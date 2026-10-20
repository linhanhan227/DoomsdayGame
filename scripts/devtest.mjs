/**
 * 开发服冒烟测试：主菜单渲染、未配置时禁止开局、设置面板不再出现内置 AI / Codex。
 * 依赖已启动的 Chrome CDP（默认 http://127.0.0.1:9222）与 Vite（默认 http://127.0.0.1:5173）。
 */
const CDP = process.env.CDP || 'http://127.0.0.1:9222'
const APP = process.env.APP || 'http://[::1]:5173/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ver = await (await fetch(`${CDP}/json/version`)).json()
const ws = new WebSocket(ver.webSocketDebuggerUrl)
let idc = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))

function send(method, params = {}, sessionId) {
  const id = ++idc
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Network.enable', {}, sessionId)
await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId)
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false }, sessionId)

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''))
  }
  return r.result.value
}

async function waitFor(expr, timeout = 30000, label = expr) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await evalJs(`!!(${expr})`)) return true
    await sleep(250)
  }
  throw new Error(`waitFor 超时: ${label}`)
}

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`)
  } else {
    fail++
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? `  \x1b[31m${extra}\x1b[0m` : ''}`)
  }
}

console.log(`\n[dev] ${APP}`)
await send('Runtime.addBinding', { name: '__probe' }, sessionId).catch(() => {})
await send(
  'Page.addScriptToEvaluateOnNewDocument',
  {
    source: `window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message||e.error))); window.addEventListener('unhandledrejection', e => window.__errs.push('rej:' + String(e.reason && (e.reason.stack || e.reason.message || e.reason))));`,
  },
  sessionId,
)
await send('Page.navigate', { url: APP }, sessionId)
await sleep(6000)
const snap = await evalJs(`JSON.stringify({
  href: location.href,
  ready: document.readyState,
  ashes: typeof window.__ASHES__,
  title: document.title,
  body: (document.body && document.body.innerText || '').slice(0, 500),
  errs: window.__errs || null,
})`)
console.log('SNAP', snap)
await waitFor(`window.__ASHES__ && window.__ASHES__.api`, 40000, '应用启动')
await waitFor(`document.querySelector('.menu-actions')`, 20000, '主菜单')

const boot = await evalJs(`(() => {
  const text = document.body.innerText
  return {
    title: document.querySelector('.menu-title')?.textContent || '',
    foot: document.querySelector('.menu-foot')?.textContent || '',
    hasStart: text.includes('开始新的一局'),
    settingsBtn: [...document.querySelectorAll('button')].find(b => /AI 通道/.test(b.textContent))?.textContent.trim() || '',
  }
})()`)
ok('主菜单渲染「灰烬余生」', boot.title === '灰烬余生', boot.title)
ok('有「开始新的一局」按钮', boot.hasStart === true)
ok('未配置时提示配置 AI 通道', /配置 AI 通道/.test(boot.settingsBtn), boot.settingsBtn)
ok('页脚显示未就绪', /未就绪/.test(boot.foot), boot.foot)

// 未就绪时点开始应弹出设置，而不是进入游戏
await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('开始新的一局'))?.click(), true`)
await waitFor(`document.querySelector('.modal')`, 10000, '设置面板')
const modal = await evalJs(`(() => {
  const options = [...document.querySelectorAll('.modal select option')].map(o => o.value)
  const buttons = [...document.querySelectorAll('.modal .btn')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())
  const labels = [...document.querySelectorAll('.modal .field label')].map(l => l.textContent.trim())
  return {
    options,
    buttons,
    labels,
    body: document.querySelector('.modal')?.innerText.replace(/\\s+/g, ' ').slice(0, 400) || '',
  }
})()`)
ok('设置面板不再有「内置 AI」按钮', !modal.buttons.some((b) => /内置 AI/.test(b)))
ok('通道选项不再包含 codex', !modal.options.includes('codex'), modal.options.join(','))
ok('仍提供 openai 与自定义通道', modal.options.includes('openai') && modal.options.includes('custom'), modal.options.join(','))
ok('面板正文不再出现内置 AI / Codex', !/内置 AI|Codex|builtin\.js/.test(modal.body))
ok('温度滑杆仍在', modal.labels.some((l) => l.includes('温度')))

// 填一套假配置并保存，确认能写入 SQLite 且就绪
await evalJs(`(() => {
  const sel = document.querySelector('.modal select')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'custom')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const f = t => [...document.querySelectorAll('.modal .field')].find(x => (x.querySelector('label')?.textContent || '').startsWith(t))
  setVal(f('Base URL').querySelector('input'), 'http://127.0.0.1:9/v1')
  setVal(f('模型名').querySelector('input'), 'devtest-model')
  setVal(f('API Key').querySelector('input'), 'sk-devtest')
  return true
})()`)
await evalJs(`[...document.querySelectorAll('.modal-actions .btn')].find(b => b.textContent.includes('保存'))?.click(), true`)
await sleep(600)
const saved = await evalJs(`window.__ASHES__.api.getSettings()`)
ok('自定义通道写入 SQLite', saved.provider === 'custom' && saved.baseUrl === 'http://127.0.0.1:9/v1' && saved.model === 'devtest-model', `${saved.provider} ${saved.baseUrl} ${saved.model}`)
ok('填入 Key 后通道就绪', saved.ready === true && saved.hasKey === true, `ready=${saved.ready} hasKey=${saved.hasKey}`)

const errs = await evalJs(`window.__errs || []`)
ok('无前端运行时错误', !errs || errs.length === 0, (errs || []).join(' | '))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
ws.close()
process.exit(fail === 0 ? 0 : 1)
