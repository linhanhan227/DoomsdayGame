/**
 * 把玩家填写的地址收成 OpenAI 的 chat/completions。
 * 接受三种写法：
 *   https://api.openai.com
 *   https://api.openai.com/v1
 *   https://api.openai.com/v1/chat/completions
 */
export function openAIChatUrl(base) {
  const raw = String(base || '').trim()
  if (!raw) return ''

  let url
  try {
    url = new URL(raw)
  } catch {
    let b = raw.replace(/\/+$/, '')
    if (/\/chat\/completions$/i.test(b)) return b
    if (/\/v\d+$/i.test(b)) return `${b}/chat/completions`
    return `${b}/v1/chat/completions`
  }

  let path = url.pathname.replace(/\/+$/, '')
  if (/\/responses$/i.test(path)) {
    throw new Error('当前自定义通道使用 Chat Completions，请填写以 /v1 或 /chat/completions 结尾的地址，不能填写 /responses。')
  }
  if (!/\/chat\/completions$/i.test(path)) {
    path = /\/v\d+$/i.test(path) ? `${path}/chat/completions` : `${path}/v1/chat/completions`
  }
  url.pathname = path
  return url.toString()
}
