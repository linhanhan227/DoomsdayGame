/**
 * 把玩家填写的地址收成 OpenAI 的 chat/completions。
 * 接受三种写法：
 *   https://api.openai.com
 *   https://api.openai.com/v1
 *   https://api.openai.com/v1/chat/completions
 */
export function openAIChatUrl(base) {
  let b = String(base || '').trim().replace(/\/+$/, '')
  if (!b) return ''
  if (/\/chat\/completions$/i.test(b)) return b
  if (/\/v\d+$/i.test(b)) return `${b}/chat/completions`
  return `${b}/v1/chat/completions`
}
