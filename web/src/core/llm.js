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
 * 跨域中转：
 *   某些服务商不返回 CORS 响应头，浏览器无法直连。三条出路：
 *   · 同源中转 —— 部署在自带服务端的实例上（Bonto / 自建 Node）时走本站 /api/cors，
 *     请求不离开自己的源，最干净；
 *   · cors.io —— 公共代理，会把上游响应包成 { status, headers, body }，客户端再拆 body；
 *   · 自定义前缀 —— 玩家自己的网关。
 *   默认仍是直连；直连被 CORS 挡掉且本站有 /api/cors 时，会自动改走同源中转一次。
 */
import { getConfig } from '../db/store.js'

/** 内置 CORS 代理。查询参数名固定为 url= */
export const LOCAL_CORS_API = 'https://cors.io/?url='

/** 本站反代路径。server.js 与 vite 开发中间件都提供它 */
export const SAME_ORIGIN_CORS_API = '/api/cors?url='

/**
 * 探测本站是否提供 /api/cors。
 * ------------------------------------------------------------------
 * 用 /api/health 而不是直接打 /api/cors：后者需要一个真实上游地址，
 * 探测本身就会产生一次外部请求，既慢又可能被上游记一笔账。
 * 结果缓存（含失败），一局游戏只探一次；file:// 下直接判定不可用。
 */
let sameOriginProbe = null
export async function hasSameOriginProxy() {
  if (sameOriginProbe !== null) return sameOriginProbe
  sameOriginProbe = false
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const res = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' })
    if (res.ok) {
      const data = await res.json().catch(() => null)
      sameOriginProbe = Boolean(data?.corsProxy)
    }
  } catch {
    /* 探测失败按"不可用"处理，不影响直连 */
  } finally {
    clearTimeout(timer)
  }
  return sameOriginProbe
}

/** 把上游地址包进代理：https://cors.io/?url=<编码后的目标> */
export function localCorsUrl(target, base = LOCAL_CORS_API) {
  const b = String(base || LOCAL_CORS_API).trim()
  const prefix = /[?&]url=$/.test(b) ? b : `${b.replace(/\/+$/, '')}${b.includes('?') ? '&' : '?'}url=`
  return `${prefix}${encodeURIComponent(target)}`
}

/** @deprecated 旧名保留。现在指向 https://cors.io/?url= */
export function corsfixUrl(target) {
  return localCorsUrl(target)
}

export function alloriginsUrl(target) {
  return localCorsUrl(target)
}

/** 按配置决定请求最终打到哪。默认直连；corsio / same / custom 才包一层中转。旧值 builtin 按直连处理 */
export function wrapWithCorsProxy(url, cfg = getConfig()) {
  const mode = String(cfg.corsProxy || '').trim()
  if (!mode || mode === 'off' || mode === 'builtin') return url
  if (mode === 'same') return localCorsUrl(url, SAME_ORIGIN_CORS_API)
  if (mode === 'custom') {
    const prefix = String(cfg.corsProxyCustom || '').trim()
    if (!prefix) return url
    if (/[?&]url=$/.test(prefix) || /\/api\/cors/i.test(prefix)) return localCorsUrl(url, prefix)
    return `${prefix}${url}`
  }
  if (mode === 'corsio') return localCorsUrl(url)
  return url
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
  const configuredUrl = wrapWithCorsProxy(directUrl, config)
  let viaProxy = configuredUrl !== directUrl

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

  /** 单次投递。每次新建 AbortController，让超时从这一次开始重新计时 */
  const send = async (target) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      return { res, text: await res.text() }
    } finally {
      clearTimeout(timer)
    }
  }

  const describeFailure = (err) => {
    if (err.name === 'AbortError') {
      return new LLMError(`请求超时（>${Math.round(config.timeoutMs / 1000)}s），请检查网络或改用更快的模型`)
    }
    if (viaProxy) {
      return new LLMError(
        `无法连接模型服务：${err.message}\n` +
          `当前请求经 CORS 中转转发。常见原因：① 中转或上游不可达；② 网络拦截了该域名。\n` +
          `建议：若服务商本身支持直连，把跨域中转改为「关闭」。`,
        { cause: err },
      )
    }
    return new LLMError(
      `无法连接模型服务：${err.message}\n` +
        `常见原因：① 该服务商未返回 CORS 响应头，浏览器不允许跨域直连；② 地址不可达。\n` +
        `若是 CORS：把跨域中转改为「同源中转（本站 /api/cors）」——需要部署在带服务端的实例上；` +
        `没有服务端时改用「cors.io」。`,
      { cause: err },
    )
  }

  let out
  try {
    out = await send(configuredUrl)
  } catch (err) {
    // 直连被 CORS / 网络挡掉，而本站恰好带反代：自动再走一次同源中转。
    // 只在"玩家没显式选中转"时兜底，不覆盖玩家的明确选择。
    if (!viaProxy && (await hasSameOriginProxy())) {
      try {
        out = await send(localCorsUrl(directUrl))
        viaProxy = true
      } catch (err2) {
        throw describeFailure(err2)
      }
    } else {
      throw describeFailure(err)
    }
  }

  let { res, text } = out
  if (viaProxy) {
    try {
      const wrapped = JSON.parse(text)
      if (wrapped && typeof wrapped.body === 'string' && Number.isInteger(wrapped.status)) {
        text = wrapped.body
        res = new Response(text, { status: wrapped.status, headers: { 'content-type': 'application/json' } })
      }
    } catch {
      /* 不是 cors.io 包装，按原文继续 */
    }
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
