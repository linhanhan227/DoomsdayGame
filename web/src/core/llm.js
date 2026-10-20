/**
 * LLM 客户端（OpenAI 兼容）· 浏览器端
 * ------------------------------------------------------------------
 * 纯静态模式下由浏览器直连模型服务商：
 *   · 非流式单次调用返回完整 JSON（便于结构化解析）。
 *   · 健壮 JSON 提取：兼容代码围栏、前后废话、尾随逗号。
 *   · 每次请求携带随机「命运种子」，配合高温度保证同状态也会演化出不同结果。
 *   · mock 通道仅供离线体验 UI，非游戏正式内容来源。
 *
 * 注意：浏览器直连要求模型服务商允许 CORS。多数主流服务商（DeepSeek / OpenAI 等）支持；
 * 本地 Ollama 需设置 OLLAMA_ORIGINS。
 *
 * 跨域中转（默认启用）：
 *   某些服务商不返回 CORS 响应头，浏览器无法直连。
 *   内置通道走 https://proxy.killcors.com?url=<上游地址>，由该代理转发并补上 CORS 头。
 */
import { getConfig } from '../db/store.js'

/** 内置 CORS 代理。查询参数名固定为 url= */
export const LOCAL_CORS_API = 'https://proxy.killcors.com?url='

/** 把上游地址包进代理：https://proxy.killcors.com?url=<编码后的目标> */
export function localCorsUrl(target, base = LOCAL_CORS_API) {
  const b = String(base || LOCAL_CORS_API).trim()
  const prefix = /[?&]url=$/.test(b) ? b : `${b.replace(/\/+$/, '')}${b.includes('?') ? '&' : '?'}url=`
  return `${prefix}${encodeURIComponent(target)}`
}

/** @deprecated 旧名保留。现在指向 https://proxy.killcors.com?url= */
export function corsfixUrl(target) {
  return localCorsUrl(target)
}

export function alloriginsUrl(target) {
  return localCorsUrl(target)
}

/** 按配置决定请求最终打到哪。builtin 走 killcors，不改写方法与请求体 */
export function wrapWithCorsProxy(url, cfg = getConfig()) {
  const mode = String(cfg.corsProxy || '').trim()
  if (!mode || mode === 'off') return url
  if (mode === 'custom') {
    const prefix = String(cfg.corsProxyCustom || '').trim()
    if (!prefix) return url
    if (/[?&]url=$/.test(prefix) || /\/api\/cors/i.test(prefix)) return localCorsUrl(url, prefix)
    return `${prefix}${url}`
  }
  return localCorsUrl(url)
}

export class LLMError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message)
    this.name = 'LLMError'
    this.status = status
    this.code = code
    if (cause) this.cause = cause
  }
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

/** 从模型返回的自由文本中稳健地提取 JSON 对象 */
export function extractJSON(text) {
  if (!text || typeof text !== 'string') throw new LLMError('模型返回为空')
  let t = text.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }

  let parsed = tryParse(t)
  if (parsed !== undefined) return parsed

  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const slice = t.slice(start, end + 1)
    parsed = tryParse(slice)
    if (parsed !== undefined) return parsed
    parsed = tryParse(slice.replace(/,\s*([}\]])/g, '$1'))
    if (parsed !== undefined) return parsed
  }
  throw new LLMError('模型未返回合法 JSON')
}

async function rawChat({ config, system, user, temperature, jsonMode }) {
  const directUrl = joinUrl(config.baseUrl, 'chat/completions')
  const url = wrapWithCorsProxy(directUrl, config)
  const viaProxy = url !== directUrl
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: temperature ?? config.temperature,
    max_tokens: config.maxTokens,
    stream: false,
  }
  if (jsonMode) body.response_format = { type: 'json_object' }

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new LLMError(`请求超时（>${Math.round(config.timeoutMs / 1000)}s），请检查网络或改用更快的模型`)
    }
    throw new LLMError(
      `无法连接模型服务：${err.message}\n` +
        (viaProxy
          ? `当前请求经 CORS 代理（https://proxy.killcors.com?url=）转发。常见原因：① 代理或上游不可达；② 网络拦截了该域名。\n` +
            `建议：若服务商本身支持直连，把跨域中转改为「关闭」。`
          : `常见原因：① 该服务商未返回 CORS 响应头，浏览器不允许跨域直连；② 地址不可达。\n` +
            `若是 CORS：在设置里把跨域中转改为「KillCORS 代理」，或改用支持跨域直连的服务商。`),
      { cause: err },
    )
  }

  let text
  try {
    text = await res.text()
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* 保留原文 */
    }
    const detail = parsed?.error?.message || parsed?.message || text
    const hint =
      res.status === 401 || res.status === 403
        ? '（API Key 无效或无权限）'
        : res.status === 404
          ? '（Base URL 或模型名可能不正确）'
          : res.status === 429
            ? '（触发限流，请稍后重试）'
            : ''
    throw new LLMError(`模型服务返回 ${res.status}${hint}：${String(detail).slice(0, 300)}`, { status: res.status })
  }

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new LLMError('模型服务返回了非 JSON 响应')
  }
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new LLMError('模型返回内容为空')
  return content
}

/** 请求模型并解析为 JSON 对象；上游不支持 response_format 时自动降级重试一次 */
export async function chatJSON({ system, user, temperature, config = getConfig() }) {
  if (config.provider === 'mock') {
    const { mockRespond } = await import('./mock.js')
    return mockRespond(user)
  }
  let content
  try {
    content = await rawChat({ config, system, user, temperature, jsonMode: true })
  } catch (err) {
    const canRetry =
      err instanceof LLMError &&
      err.status &&
      err.status >= 400 &&
      err.status < 500 &&
      ![401, 403, 429].includes(err.status)
    if (canRetry) content = await rawChat({ config, system, user, temperature, jsonMode: false })
    else throw err
  }
  return extractJSON(content)
}

/** 连通性测试：一次极小的调用 */
export async function testConnection(config = getConfig()) {
  if (config.provider === 'mock') {
    return { ok: true, model: 'mock', sample: '离线自检通道正常' }
  }
  const content = await rawChat({
    config,
    system: '你是一个连通性测试探针。只回复 JSON。',
    user: '请只回复：{"ok": true}',
    temperature: 0,
    jsonMode: false,
  })
  return { ok: true, model: config.model, sample: String(content).slice(0, 120) }
}
