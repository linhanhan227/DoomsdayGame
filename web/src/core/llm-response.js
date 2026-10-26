const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export class ModelResponseError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'ModelResponseError'
    this.code = code
    Object.assign(this, details)
  }
}

function parseJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function asJSONObject(value) {
  let current = value
  for (let i = 0; i < 3; i++) {
    if (isObject(current)) return current
    if (typeof current !== 'string') return null
    const parsed = parseJSON(current.trim())
    if (parsed === undefined || parsed === current) return null
    current = parsed
  }
  return isObject(current) ? current : null
}

/** 修正常见的模型 JSON 小错误，不执行代码，也不接受对象以外的顶层值。 */
function loosenJSON(text) {
  let out = ''
  let quote = false
  let escaped = false
  let smartQuote = false

  for (const ch of text) {
    if (quote) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if ((!smartQuote && ch === '"') || (smartQuote && ch === '”')) {
        out += '"'
        quote = false
        smartQuote = false
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') continue
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }

    if (ch === '"' || ch === '“') {
      out += '"'
      quote = true
      smartQuote = ch === '“'
      continue
    }
    out += ch === '”' ? '"' : ch
  }

  return out.replace(/,\s*([}\]])/g, '$1')
}

/** 找出自由文本里的完整 JSON 对象；较晚结束的外层对象优先。 */
function balancedObjectSlices(text) {
  const ranges = []

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue
    const stack = ['}']
    let quote = false
    let escaped = false

    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i]
      if (quote) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') quote = false
        continue
      }
      if (ch === '"') {
        quote = true
        continue
      }
      if (ch === '{') stack.push('}')
      else if (ch === '[') stack.push(']')
      else if (ch === '}' || ch === ']') {
        if (stack[stack.length - 1] !== ch) break
        stack.pop()
        if (stack.length === 0) {
          ranges.push({ start, end: i, text: text.slice(start, i + 1) })
          break
        }
      }
    }
  }

  return ranges
    .sort((a, b) => a.end - b.end || b.start - a.start)
    .map((range) => range.text)
}

function parseObjectCandidate(text) {
  return asJSONObject(parseJSON(text)) || asJSONObject(parseJSON(loosenJSON(text)))
}

/**
 * 从模型自由文本中提取最后一个完整 JSON 对象。
 * 模型的思考过程可能先引用示例对象，因此不能再用“第一个 { 到最后一个 }”整段截取。
 */
export function extractJSONObject(value) {
  if (isObject(value)) return value
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    throw new ModelResponseError('模型返回为空', 'empty_content')
  }
  if (typeof value !== 'string') {
    throw new ModelResponseError('模型返回内容不是文本或 JSON 对象', 'unsupported_content')
  }

  const text = value.trim().replace(/^\uFEFF/, '')
  const strictRoot = parseJSON(text)
  if (strictRoot !== undefined) {
    const parsed = asJSONObject(strictRoot)
    if (parsed) return parsed
    throw new ModelResponseError('模型未返回 JSON 对象', 'invalid_json')
  }

  const direct = parseObjectCandidate(text)
  if (direct) return direct

  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (let i = fenced.length - 1; i >= 0; i--) {
    const parsed = parseObjectCandidate(fenced[i][1].trim())
    if (parsed) return parsed
  }

  const slices = balancedObjectSlices(text)
  for (let i = slices.length - 1; i >= 0; i--) {
    const parsed = parseObjectCandidate(slices[i])
    if (parsed) return parsed
  }

  throw new ModelResponseError('模型未返回合法 JSON', 'invalid_json')
}

function textFromPart(part) {
  if (typeof part === 'string') return part
  if (!isObject(part)) return ''
  if (typeof part.text === 'string') return part.text
  if (typeof part.text?.value === 'string') return part.text.value
  if (typeof part.output_text === 'string') return part.output_text
  if (typeof part.content === 'string') return part.content
  if (typeof part.value === 'string' && /text/i.test(String(part.type || ''))) return part.value
  return ''
}

/** 把 OpenAI content 字符串、content parts 和已解析对象收成一种值。 */
function normalizeContent(value) {
  if (typeof value === 'string') return value.trim() ? value : null
  if (isObject(value)) {
    if (isObject(value.json)) return value.json
    const text = textFromPart(value)
    return text.trim() ? text : value
  }
  if (!Array.isArray(value)) return null

  const primary = []
  const reasoning = []
  const objects = []
  for (const part of value) {
    if (isObject(part?.json)) objects.push(part.json)
    const text = textFromPart(part)
    if (!text) continue
    if (/reason|thinking/i.test(String(part?.type || ''))) reasoning.push(text)
    else primary.push(text)
  }
  if (primary.length) return primary.join('')
  if (objects.length === 1) return objects[0]
  if (reasoning.length) return reasoning.join('')
  return null
}

function parseNestedPayload(value) {
  if (isObject(value)) return value
  if (typeof value !== 'string') return null
  const parsed = parseJSON(value.trim())
  return isObject(parsed) ? parsed : null
}

/**
 * 归一化常见的 OpenAI 兼容响应包络。
 * 仍发送 Chat Completions 请求，但兼容网关常见的 content parts、嵌套 data 和 Responses 风格回包。
 */
export function normalizeModelResponse(payload) {
  const root = parseNestedPayload(payload) || payload
  const queue = [{ value: root, source: 'root' }]
  const seen = new Set()

  while (queue.length) {
    const { value, source } = queue.shift()
    if (!isObject(value) || seen.has(value)) continue
    seen.add(value)

    const choice = Array.isArray(value.choices) ? value.choices[0] : null
    if (choice) {
      const message = choice.message || {}
      const finishReason = choice.finish_reason || choice.finishReason || value.finish_reason || ''
      const candidates = [
        ['message.content', message.content],
        ['message.parsed', message.parsed],
        ['message.function_call.arguments', message.function_call?.arguments],
        ['message.tool_calls.arguments', message.tool_calls?.[0]?.function?.arguments],
        ['choice.text', choice.text],
      ]
      for (const [field, candidate] of candidates) {
        const content = normalizeContent(candidate)
        if (content !== null) return { content, finishReason, source: `${source}.${field}` }
      }

      const reasoning = normalizeContent(message.reasoning_content ?? message.reasoning)
      if (reasoning !== null) return { content: reasoning, finishReason, source: `${source}.message.reasoning_content` }
    }

    const outputText = normalizeContent(value.output_text)
    if (outputText !== null) {
      return {
        content: outputText,
        finishReason: value.incomplete_details?.reason || value.status || '',
        source: `${source}.output_text`,
      }
    }

    if (Array.isArray(value.output)) {
      const texts = []
      const objects = []
      for (const item of value.output) {
        const content = normalizeContent(item?.content ?? item)
        if (typeof content === 'string') texts.push(content)
        else if (isObject(content)) objects.push(content)
      }
      if (texts.length) {
        return {
          content: texts.join(''),
          finishReason: value.incomplete_details?.reason || value.status || '',
          source: `${source}.output[].content`,
        }
      }
      if (objects.length === 1) {
        return {
          content: objects[0],
          finishReason: value.incomplete_details?.reason || value.status || '',
          source: `${source}.output[].content`,
        }
      }
    }

    const topContent = normalizeContent(value.content)
    if (topContent !== null) {
      return { content: topContent, finishReason: value.finish_reason || '', source: `${source}.content` }
    }

    for (const key of ['data', 'response', 'result', 'body']) {
      const nested = parseNestedPayload(value[key])
      if (nested) queue.push({ value: nested, source: `${source}.${key}` })
    }
  }

  throw new ModelResponseError('模型返回内容为空', 'empty_content')
}

function deltaText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null
  const chatDelta = normalizeContent(choice?.delta?.content)
  if (typeof chatDelta === 'string') return chatDelta
  if (typeof payload?.delta === 'string') return payload.delta
  if (typeof payload?.delta?.text === 'string') return payload.delta.text
  if (typeof payload?.text === 'string' && /delta/i.test(String(payload?.type || ''))) return payload.text
  return ''
}

/** 解析普通 JSON；若兼容网关无视 stream:false 返回 SSE，则把文本增量合并为标准包络。 */
export function decodeModelResponseBody(text, contentType = '') {
  const raw = String(text || '').trim().replace(/^\uFEFF/, '')
  const parsed = parseJSON(raw)
  if (parsed !== undefined) return parsed

  const looksLikeSSE = /text\/event-stream/i.test(contentType) || /^(?:event|data):/m.test(raw)
  if (!looksLikeSSE) throw new ModelResponseError('模型服务返回了非 JSON 响应', 'non_json_response')

  const deltas = []
  let finishReason = ''
  let finalPayload = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    const event = parseJSON(data)
    if (!isObject(event)) continue
    const delta = deltaText(event)
    if (delta) deltas.push(delta)
    finishReason = event.choices?.[0]?.finish_reason || finishReason
    if (event.response && isObject(event.response)) finalPayload = event.response
    else if (event.choices?.[0]?.message || event.output_text || event.error) finalPayload = event
  }

  if (deltas.length) {
    return { choices: [{ message: { content: deltas.join('') }, finish_reason: finishReason }] }
  }
  if (finalPayload) return finalPayload
  throw new ModelResponseError('模型服务返回的 SSE 中没有文本内容', 'empty_sse')
}

export function findModelServiceError(payload) {
  const root = parseNestedPayload(payload) || payload
  const queue = [root]
  const seen = new Set()
  while (queue.length) {
    const value = queue.shift()
    if (!isObject(value) || seen.has(value)) continue
    seen.add(value)
    if (value.error) {
      const err = isObject(value.error) ? value.error : { message: String(value.error) }
      const numericStatus = Number(err.status ?? err.status_code ?? value.status)
      const code = String(err.code || err.type || '')
      const param = String(err.param || err.parameter || '')
      const message = String(err.message || value.message || value.error)
      let status = Number.isInteger(numericStatus) && numericStatus >= 400 ? numericStatus : 400
      if (/unauthor|forbidden|api.?key|authentication/i.test(`${code} ${message}`)) status = 401
      else if (/rate.?limit|quota/i.test(`${code} ${message}`)) status = 429
      return { message, code, param, status }
    }
    for (const key of ['data', 'response', 'result', 'body']) {
      const nested = parseNestedPayload(value[key])
      if (nested) queue.push(nested)
    }
  }
  return null
}

export function isTruncatedFinishReason(reason) {
  return /length|max(?:imum)?(?:_|\s|-)*(?:output(?:_|\s|-)*)?tokens?|incomplete/i.test(String(reason || ''))
}
