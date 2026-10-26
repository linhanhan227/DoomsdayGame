import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { openAIChatUrl } from '../web/src/core/openai.js'
import {
  decodeModelResponseBody,
  extractJSONObject,
  findModelServiceError,
  isTruncatedFinishReason,
  ModelResponseError,
  normalizeModelResponse,
} from '../web/src/core/llm-response.js'

let passed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m ${name}`)
    throw err
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m ${name}`)
    throw err
  }
}

function contentOf(payload) {
  return normalizeModelResponse(payload).content
}

console.log('\n[llm] 自定义 OpenAI 兼容响应')

test('读取标准 Chat Completions content', () => {
  assert.equal(contentOf({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), '{"ok":true}')
})

test('合并 content parts 文本数组', () => {
  const content = contentOf({
    choices: [{ message: { content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }] } }],
  })
  assert.equal(content, '{"ok":true}')
})

test('接受 content 中已解析的 JSON 对象', () => {
  assert.deepEqual(contentOf({ choices: [{ message: { content: { ok: true } } }] }), { ok: true })
})

test('读取 message.parsed 结构化对象', () => {
  assert.deepEqual(contentOf({ choices: [{ message: { content: null, parsed: { ok: true } } }] }), { ok: true })
})

test('读取旧式 choices[0].text', () => {
  assert.equal(contentOf({ choices: [{ text: '{"ok":true}' }] }), '{"ok":true}')
})

test('content 为空时兼容 reasoning_content', () => {
  const payload = { choices: [{ message: { content: null, reasoning_content: '分析后输出 {"ok":true}' } }] }
  assert.deepEqual(extractJSONObject(contentOf(payload)), { ok: true })
})

test('读取工具调用 arguments 中的 JSON', () => {
  const payload = {
    choices: [{ message: { content: null, tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }],
  }
  assert.deepEqual(extractJSONObject(contentOf(payload)), { ok: true })
})

test('兼容 Responses API output_text 回包', () => {
  assert.equal(contentOf({ output_text: '{"ok":true}', status: 'completed' }), '{"ok":true}')
})

test('兼容 Responses API output content parts', () => {
  const payload = { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }
  assert.equal(contentOf(payload), '{"ok":true}')
})

test('递归拆开网关 data 包装', () => {
  const payload = { data: { choices: [{ message: { content: '{"ok":true}' } }] } }
  assert.equal(contentOf(payload), '{"ok":true}')
})

test('递归拆开字符串 body 包装', () => {
  const body = JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })
  assert.equal(contentOf({ status: '200', body }), '{"ok":true}')
})

test('识别 HTTP 200 中的服务错误', () => {
  assert.deepEqual(findModelServiceError({ data: { error: { message: 'response_format unsupported', code: 'bad_request' } } }), {
    message: 'response_format unsupported',
    code: 'bad_request',
    param: '',
    status: 400,
  })
})

test('识别 token 截断原因', () => {
  assert.equal(isTruncatedFinishReason('length'), true)
  assert.equal(isTruncatedFinishReason('max_output_tokens'), true)
  assert.equal(isTruncatedFinishReason('stop'), false)
})

console.log('\n[llm] JSON 提取与 SSE')

test('直接接受已解析对象', () => {
  assert.deepEqual(extractJSONObject({ ok: true }), { ok: true })
})

test('提取 Markdown 代码围栏并修复尾逗号', () => {
  assert.deepEqual(extractJSONObject('```json\n{"ok": true,}\n```'), { ok: true })
})

test('修复字符串中的裸换行与制表符', () => {
  assert.deepEqual(extractJSONObject('{"text":"第一行\n\t第二行"}'), { text: '第一行\n\t第二行' })
})

test('思考中引用示例时选择最后一个完整对象', () => {
  const text = '先按示例 {"ok":false} 思考。最终答案：\n{"ok":true,"text":"保留 {花括号}"}'
  assert.deepEqual(extractJSONObject(text), { ok: true, text: '保留 {花括号}' })
})

test('思考中未闭合的示例不会吞掉后面的完整答案', () => {
  const text = '错误示例 {"ok": false\n最终答案：{"ok":true}'
  assert.deepEqual(extractJSONObject(text), { ok: true })
})

test('顶层数组不会被当作游戏对象', () => {
  assert.throws(() => extractJSONObject('[{"ok":true}]'), (err) => err instanceof ModelResponseError && err.code === 'invalid_json')
})

test('截断 JSON 不会被误判为合法对象', () => {
  assert.throws(() => extractJSONObject('{"ok":true'), (err) => err instanceof ModelResponseError && err.code === 'invalid_json')
})

test('解析 Chat Completions SSE 增量', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
  ].join('\n')
  const payload = decodeModelResponseBody(sse, 'text/event-stream')
  assert.deepEqual(extractJSONObject(contentOf(payload)), { ok: true })
})

test('解析 Responses API SSE 增量', () => {
  const sse = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"{\\"ok\\":"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"true}"}',
    '',
    'data: [DONE]',
  ].join('\n')
  const payload = decodeModelResponseBody(sse, 'text/event-stream')
  assert.deepEqual(extractJSONObject(contentOf(payload)), { ok: true })
})

test('非 JSON 且非 SSE 时给出明确错误', () => {
  assert.throws(
    () => decodeModelResponseBody('<html>bad gateway</html>', 'text/html'),
    (err) => err instanceof ModelResponseError && err.code === 'non_json_response',
  )
})

console.log('\n[llm] 自定义 Base URL')

test('域名自动补 /v1/chat/completions', () => {
  assert.equal(openAIChatUrl('https://example.com'), 'https://example.com/v1/chat/completions')
})

test('/v1 自动补 /chat/completions', () => {
  assert.equal(openAIChatUrl('https://example.com/v1/'), 'https://example.com/v1/chat/completions')
})

test('完整 endpoint 与查询参数原样保留', () => {
  assert.equal(
    openAIChatUrl('https://example.com/openai/deployments/demo/chat/completions?api-version=2024-10-21'),
    'https://example.com/openai/deployments/demo/chat/completions?api-version=2024-10-21',
  )
})

test('/responses 给出可操作错误而不是错误拼接 URL', () => {
  assert.throws(() => openAIChatUrl('https://example.com/v1/responses'), /不能填写 \/responses/)
})

console.log('\n[llm] 客户端请求与降级')

const clientConfig = {
  provider: 'custom',
  baseUrl: 'https://custom.test/v1',
  model: 'custom-model',
  apiKey: 'sk-test',
  temperature: 0,
  maxTokens: 2400,
  timeoutMs: 5000,
  corsProxy: 'off',
  corsProxyCustom: '',
}

async function withFetchMock(mock, run) {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
let client
try {
  client = await vite.ssrLoadModule('/src/core/llm.js')
} catch (err) {
  await vite.close()
  throw err
}
const { chatJSON, LLMError, testConnection } = client

await testAsync('标准 DeepSeek 回包保持原路径可用', async () => {
  await withFetchMock(async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }, async () => {
    assert.deepEqual(await chatJSON({ system: 's', user: 'u', config: clientConfig }), { ok: true })
  })
})

await testAsync('连接测试在 response_format 400 后自动降级并读取 content parts', async () => {
  const requests = []
  await withFetchMock(async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ url: String(url), jsonMode: Boolean(body.response_format) })
    if (body.response_format) {
      return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({ data: { choices: [{ message: { content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }] } }] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }, async () => {
    const result = await testConnection(clientConfig)
    assert.equal(result.ok, true)
    assert.equal(result.sample, '{"ok":true}')
  })
  assert.deepEqual(requests.map((x) => x.jsonMode), [true, false])
  assert.ok(requests.every((x) => x.url === 'https://custom.test/v1/chat/completions'))
})

await testAsync('HTTP 200 错误包络会降级一次而非报内容为空', async () => {
  const modes = []
  await withFetchMock(async (_url, init) => {
    const body = JSON.parse(init.body)
    modes.push(Boolean(body.response_format))
    if (body.response_format) {
      return new Response(JSON.stringify({ error: { message: 'json mode disabled', code: 'invalid_request' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }, async () => {
    assert.equal((await testConnection(clientConfig)).ok, true)
  })
  assert.deepEqual(modes, [true, false])
})

await testAsync('HTTP 200 错误的 param=response_format 也会兼容降级', async () => {
  const modes = []
  await withFetchMock(async (_url, init) => {
    const body = JSON.parse(init.body)
    modes.push(Boolean(body.response_format))
    if (body.response_format) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid parameter', code: 'invalid_request', param: 'response_format' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }, async () => {
    assert.equal((await testConnection(clientConfig)).ok, true)
  })
  assert.deepEqual(modes, [true, false])
})

await testAsync('HTTP 200 非兼容性错误不会重复请求', async () => {
  let calls = 0
  await withFetchMock(async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: 'insufficient balance', code: 'billing_error' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }, async () => {
    await assert.rejects(
      () => testConnection(clientConfig),
      (err) => err instanceof LLMError && err.code === 'billing_error' && /insufficient balance/.test(err.message),
    )
  })
  assert.equal(calls, 1)
})

await testAsync('HTTP 404 模型或地址错误不会重复请求', async () => {
  let calls = 0
  await withFetchMock(async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: 'model not found' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }, async () => {
    await assert.rejects(() => testConnection(clientConfig), (err) => err instanceof LLMError && err.status === 404)
  })
  assert.equal(calls, 1)
})

await testAsync('finish_reason=length 给出截断错误且不发二次修复请求', async () => {
  let calls = 0
  await withFetchMock(async () => {
    calls++
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true' }, finish_reason: 'length' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }, async () => {
    await assert.rejects(
      () => chatJSON({ system: 's', user: 'u', config: clientConfig }),
      (err) => err instanceof LLMError && err.code === 'output_truncated' && /截断/.test(err.message),
    )
  })
  assert.equal(calls, 1)
})

await vite.close()
console.log(`\n结果：${passed} 通过 / 0 失败`)
