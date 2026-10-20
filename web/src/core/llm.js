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
 *   某些服务商不返回 CORS 响应头，浏览器无法直连，此时经公共中转服务代取上游。
 *   ⚠ 代价：请求（含 Authorization / API Key）会经过第三方服务器，存在 Key 泄露风险。
 */
import { getConfig } from '../db/store.js'

/**
 * 公共中转服务（唯一内置）：corsfix
 * ------------------------------------------------------------------
 * ⚠ 采用官方 SDK 的 URL 形式：`?sdk=1&url=<编码后的目标地址>`（免注册免费额度）。
 *
 *   裸形式 `?<目标地址>`（不编码、不带 sdk=1）走「已注册域名」通道：
 *   仅当部署在 corsfix 后台登记过的域名下才被接受，否则返回 403：
 *     { "corsfix_error": "domain_not_registered",
 *       "message": "This website domain hasn't been registered to use the proxy" }
 *   SDK 形式无此限制，故作为默认（免费额度：每 IP 60 次/分，每域名 10MB/月）。
 *
 *   ⚠ corsfix 要求请求携带合法 Origin 头（必须由浏览器 fetch 发起）；
 *     服务端 / curl 直连会返回 `invalid_origin`，属正常现象。
 *
 *   ⚠ 两种形式的编码要求**相反**：裸形式原样拼接；SDK 形式必须 encodeURIComponent
 *     （见 corsfix SDK 源码的 proxiedUrlFor）。
 */
const CORS_PROXY_BASE = 'https://proxy.corsfix.com'

/** 按官方 SDK 的形式拼接代理地址 */
export function corsfixUrl(target, base = CORS_PROXY_BASE) {
  const b = String(base || CORS_PROXY_BASE).replace(/\/+$/, '')
  return `${b}/?sdk=1&url=${encodeURIComponent(target)}`
}

/** 按配置把上游 URL 包装成经中转的 URL；未启用时原样返回 */
export function wrapWithCorsProxy(url, cfg = getConfig()) {
  const mode = String(cfg.corsProxy || '').trim()
  if (!mode || mode === 'off') return url
  if (mode === 'custom') {
    const prefix = String(cfg.corsProxyCustom || '').trim()
    if (!prefix) return url // 自定义中转未填地址 → 退回直连
    // 用户直接粘了 corsfix 地址时，同样改走 SDK 形式，否则会撞上域名未注册
    if (/corsfix\.com/i.test(prefix)) return corsfixUrl(url, prefix)
    // 其余自建网关：按原样拼接（不做 URL 编码）
    return `${prefix}${url}`
  }
  return corsfixUrl(url)
}

/**
 * 识别「中转自身」的报错（corsfix 会返回 corsfix_error 字段）。
 * 这类失败与 API Key / 模型无关，必须单独提示，否则会把用户引到错误的方向。
 */
const CORSFIX_ERROR_TEXT = {
  domain_not_registered: '公共中转（corsfix）未注册当前站点域名',
  no_active_plan: '公共中转（corsfix）未启用免费额度',
  free_tier_transfer_limit: '公共中转（corsfix）免费流量已用尽（免费额度 10MB/月/域名）',
  free_tier_concurrency_limit: '公共中转（corsfix）免费并发已用尽（免费额度同时 1 个用户）',
  invalid_url: '公共中转（corsfix）无法解析目标地址',
  forbidden_target: '公共中转（corsfix）不允许访问该目标地址',
  blocked_target: '公共中转（corsfix）已屏蔽该目标地址',
  payload_too_large: '请求体超过公共中转上限（5MB）',
}

function corsfixErrorText(parsed) {
  const code = String(parsed?.corsfix_error || '').trim()
  if (!code) return null
  const label = CORSFIX_ERROR_TEXT[code] || `公共中转（corsfix）返回错误 ${code}`
  const fix = parsed?.if_you_are_admin ? `\n处理办法：${parsed.if_you_are_admin}` : ''
  return (
    `${label}${fix}\n` +
    '若不便处理，可在「AI 通道设置」里把「跨域中转」改为「关闭」直连服务商（需该服务商支持浏览器跨域），' +
    '或填写自己的中转前缀。'
  )
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
          ? `当前请求经公共中转（corsfix）转发，常见原因：① 中转服务不可达或限流；② 上游地址不可达。\n` +
            `建议：若你的服务商支持直连（DeepSeek / OpenAI 等），在设置里把跨域中转改为「关闭」重试。`
          : `常见原因：① 该服务商未返回 CORS 响应头，浏览器不允许跨域直连；② 地址不可达。\n` +
            `若是 CORS：在设置里把跨域中转改为「公共中转（corsfix）」，或改用支持跨域直连的服务商。`),
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
    // 中转自身的故障（域名未注册、额度用尽…）与 Key / 模型无关，先单独提示
    const proxyErr = corsfixErrorText(parsed)
    if (proxyErr) throw new LLMError(proxyErr, { status: res.status })

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
