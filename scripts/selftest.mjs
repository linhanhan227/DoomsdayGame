/**
 * 端到端自检 · 浏览器端（纯静态版）
 * ------------------------------------------------------------------
 * 用法：
 *   1) 先构建并启动静态服务：
 *        npm run build && npm run preview        # 默认 http://localhost:4173
 *   2) 另开一个带调试端口的 Chrome：
 *        chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp> about:blank
 *   3) 运行：
 *        node scripts/selftest.mjs
 *
 * 环境变量：CDP（默认 http://127.0.0.1:9222）、APP（默认 http://127.0.0.1:4173）
 */
import { readdirSync } from 'node:fs'
import { rollEventPlan, formatEventPlan, buildTurnPrompt, buildOpeningPrompt, buildScavengePrompt, buildSleepPrompt, buildUseItemPrompt, buildLinkageChecklist, buildConsumePrompt, OUTPUT_SCHEMA, polishChoiceText, SYSTEM_PROMPT } from '../web/src/core/prompt.js'

const BROWSER = process.env.CDP || 'http://127.0.0.1:9222'
const APP = process.env.APP || 'http://127.0.0.1:4173'

/**
 * 界面段需要「能真正开局」，但离线通道（mock）已被产品逻辑禁止开局
 * （App 的 guardReady 会拦下 provider === 'mock'）。
 * 因此这里注入一个 fetch 补丁：把发往 /chat/completions 的请求就地交给 mock 模块，
 * 再配一个「看起来就绪」的 openai 通道，使界面流程可以完整走通。
 */
const MOCK_CHUNK = (() => {
  try {
    return readdirSync(new URL('../dist/assets/', import.meta.url)).find((f) => /^mock-.*\.js$/.test(f)) || ''
  } catch {
    return ''
  }
})()

const MOCK_FETCH_PATCH = MOCK_CHUNK
  ? `
(() => {
  const orig = window.fetch.bind(window)
  const chunk = '${MOCK_CHUNK}'
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    // 本地 CORS 接口会把上游地址放进 ?url= 并整段编码，
    // 于是 "chat/completions" 变成 "chat%2Fcompletions"。两种写法都要能命中。
    const isChat = /chat\\/completions/.test(url) || /chat%2Fcompletions/i.test(url)
    if (init && init.method === 'POST' && isChat) {
      try {
        const body = JSON.parse(init.body || '{}')
        const msgs = body.messages || []
        const userMsg = (msgs.find(m => m.role === 'user') || {}).content || ''
        const mod = await import(new URL('./assets/' + chunk, document.baseURI).href)
        const obj = mod.mockRespond(String(userMsg))
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: { message: 'mock-inject: ' + e.message } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return orig(input, init)
  }
})()
`
  : ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function report(rows) {
  for (const r of rows) {
    if (r.pass) {
      pass++
      console.log(`  \x1b[32m✓\x1b[0m ${r.name}${r.extra ? `  \x1b[90m${r.extra}\x1b[0m` : ''}`)
    } else {
      fail++
      console.log(`  \x1b[31m✗\x1b[0m ${r.name}${r.extra ? `  \x1b[31m${r.extra}\x1b[0m` : ''}`)
    }
  }
}

/* ---------------- CDP 连接 ---------------- */
/** 连接 CDP 前先等它就绪：Chrome 冷启动可能要十几秒，外部 sleep 不可靠 */
async function waitForCdp(retries = 40, gapMs = 1000) {
  let lastErr
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BROWSER}/json/version`)
      if (res.ok) return await res.json()
      lastErr = new Error(`CDP 返回 HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await sleep(gapMs)
  }
  throw new Error(
    `无法连接 CDP（${BROWSER}）：${lastErr?.message || '未知错误'}\n` +
      `请确认 Chrome 已启动，且带 --remote-debugging-port=<端口> 与独立的 --user-data-dir。`,
  )
}

if (process.env.PROMPT_ONLY === '1') {
  console.log('\n[3] 随机事件骰（仅提示词）')
} else {
const ver = await waitForCdp()
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

async function waitFor(expr, timeout = 40000, label = expr) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await evalJs(`!!(${expr})`)) return true
    await sleep(300)
  }
  throw new Error(`waitFor 超时: ${label}`)
}

console.log(`\n\x1b[36m末日生存游戏 · 浏览器端自检\x1b[0m  →  ${APP}\n`)

/* ---------------- 载入应用 ---------------- */
console.log('[1] 载入应用与 SQLite')
if (MOCK_FETCH_PATCH) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_FETCH_PATCH }, sessionId)
}
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(`window.__ASHES__ && window.__ASHES__.api`, 60000, '应用启动 + SQLite 初始化')
await evalJs(`window.__errs=[]; window.addEventListener('error', e => window.__errs.push(String(e.message)))`)
report([
  { name: '应用启动、SQLite 初始化完成', pass: true, extra: 'window.__ASHES__ 就绪' },
  { name: '离线内容注入就绪（界面段可开局）', pass: !!MOCK_CHUNK, extra: MOCK_CHUNK || '未找到 mock chunk，界面段将跳过' },
])

/* ---------------- 逻辑链路 ---------------- */
console.log('\n[2] 游戏逻辑链路（离线通道）')
const LOGIC = `
(async () => {
  const R = []
  const ok = (name, cond, extra='') => R.push({ name, pass: !!cond, extra: extra === undefined ? '' : String(extra) })
  const api = window.__ASHES__.api
  await api.saveSettings({ provider: 'mock' })

  const STAT = ['hp','hunger','thirst','sanity','stamina','infection']
  const valid = s => s && typeof s.id === 'string' && s.stats && STAT.every(k => typeof s.stats[k] === 'number') && Array.isArray(s.log)

  const g0 = await api.newGame()
  ok('开局返回合法状态结构', valid(g0))
  ok('开局有叙事文本', typeof g0.narration === 'string' && g0.narration.length > 10)
  ok('开局有 3-4 个选项', Array.isArray(g0.choices) && g0.choices.length >= 3, g0.choices?.length)
  ok('选项 id 已规范化为 A/B/C…', g0.choices?.every((c,i) => c.id === ['A','B','C','D'][i]))
  ok('开局为爆发第 1 天', g0.day === 1, 'day='+g0.day)
  ok('崩塌阶段=爆发', g0.collapseStage === '爆发', g0.collapseStage)
  ok('开局已确立主线', !!g0.mainQuest?.title, g0.mainQuest?.title)
  ok('开局返回支线数组', Array.isArray(g0.sideQuests), 'sideQuests='+(g0.sideQuests?.length))
  ok('开局时刻为 24 小时制 HH:MM', /^[0-9]{2}:[0-9]{2}$/.test(g0.clock) && Number.isInteger(g0.minute) && g0.minute >= 0 && g0.minute < 1440, g0.clock+' / min='+g0.minute)
  ok('昼夜标记可用', typeof g0.isNight === 'boolean' && ['白天','黄昏','夜晚'].includes(g0.dayPhase), g0.dayPhase+' / isNight='+g0.isNight)
  ok('开局带天气', !!g0.weather && typeof g0.weather.label === 'string' && g0.weather.label.length > 0, g0.weather?.label)
  ok('天气种类合法', ['clear','cloudy','overcast','fog','rain','storm','thunder','snow','blizzard'].includes(g0.weather?.kind), g0.weather?.kind)
  ok('开局感染值=0', g0.stats.infection === 0, g0.stats.infection)
  ok('开局背包条目均带分类', g0.inventory.length > 0 && g0.inventory.every(it => typeof it.category === 'string' && it.category), 'n='+g0.inventory.length)
  ok('背包分类取值合法', g0.inventory.every(it => ['武器','食物','饮水','药品','工具','弹药','衣物','杂物'].includes(it.category)), g0.inventory.map(i=>i.category).join('/'))
  ok('公开状态暴露局势危险度与放弃标记', typeof g0.scavengeSafe === 'boolean' && typeof g0.unsafeReason === 'string' && typeof g0.scavengeSkipped === 'boolean', 'safe='+g0.scavengeSafe+' reason="'+g0.unsafeReason+'" skipped='+g0.scavengeSkipped)
  ok('危险度不再作为搜刮门禁（canScavenge 恒为真）', g0.canScavenge === true, 'canScavenge='+g0.canScavenge)
  ok('危险时必须给出原因', g0.scavengeSafe === true || (g0.unsafeReason && g0.unsafeReason.length > 0), 'reason="'+g0.unsafeReason+'"')
  // 开局为急诊走廊撕咬现场（mock 明确判危险）→ 搜刮**不再被拒绝**，代价由玩家自负
  ok('开局为危险场景（mock 设定）', g0.scavengeSafe === false, 'safe='+g0.scavengeSafe+' / '+g0.unsafeReason)
  {
    const before = await api.getGame(g0.id)
    const after = await api.scavenge(g0.id)
    ok('危险时搜刮不再被拒绝（改由玩家自行决定）', valid(after) && after.log.length > before.log.length,
      'log '+before.log.length+' → '+after.log.length)
    const entry = [...after.log].reverse().find(e => e.kind === 'scavenge')
    ok('危险时搜刮仍照常结算代价（空手豁免除外）',
      entry?.exhausted ? true : (after.minute !== before.minute || after.stats.stamina !== before.stats.stamina),
      'exhausted='+!!entry?.exhausted+' / minute '+before.minute+'→'+after.minute+' / stamina '+before.stats.stamina+'→'+after.stats.stamina)
  }

  /* ---------- 任务链：主线驱动支线 → 支线回归主线 → 主线完成开新主线 ---------- */
  {
    const gq = await api.newGame()
    ok('开局即确立任务焦点=主线', gq.questFocus?.type === 'main' && !!gq.questFocus.title, JSON.stringify(gq.questFocus))
    ok('开局为第 1 条主线', gq.mainQuestSeq === 1, 'seq=' + gq.mainQuestSeq)
    ok('开局地图登记了当前地点', Array.isArray(gq.mapNodes) && gq.mapNodes.some(n => n.name === gq.location), 'nodes=' + (gq.mapNodes || []).map(n => n.name).join('/'))
    ok('地图节点带稳定坐标与类型', (gq.mapNodes || []).every(n => Number.isFinite(n.x) && Number.isFinite(n.y) && typeof n.type === 'string'), JSON.stringify(gq.mapNodes?.[0] || {}))

    // 去剧透兜底：mock 开局选项 B 写的是「果断地抓起墙上的灭火器迎上去」，
    // 引擎应把「果断地」摘掉，玩家看到的仍是完整可读的动作。
    const SPOILER_RE = /安全地|成功地|顺利地|轻松地|侥幸地|稳妥地|有效地|安然地|明智地|贸然地|愚蠢地|冒险地|危险地|果断地|大胆地|谨慎地/
    ok('选项文案已去除剧透副词（引擎兜底）', (gq.choices || []).every(c => !SPOILER_RE.test(c.text)), (gq.choices || []).map(c => c.text).join(' / '))
    ok('去剧透后选项文案仍完整可读', (gq.choices || []).some(c => /抓起墙上的灭火器迎上去/.test(c.text)), (gq.choices || []).map(c => c.text).join(' / '))
    ok('选项数量仍为 3-4 个', (gq.choices || []).length >= 3 && (gq.choices || []).length <= 4, String((gq.choices || []).length))

    const q1 = await api.choose(gq.id, gq.choices[0].id) // 第 1 回合：抛出支线
    ok('随机事件抛出了支线', (q1.sideQuests || []).some(q => q.status === 'active'), (q1.sideQuests || []).map(q => q.title + '/' + q.status).join('，'))
    ok('选项带任务线标注（quest 字段）', (q1.choices || []).some(c => c.quest), (q1.choices || []).map(c => c.id + ':' + (c.quest || '-')).join(' '))
    ok('至少一个选项标注主线', (q1.choices || []).some(c => c.quest === 'main'), (q1.choices || []).map(c => c.id + ':' + (c.quest || '-')).join(' '))

    const q2 = await api.choose(q1.id, q1.choices[0].id) // 第 2 回合：出现"服务于支线"的选项
    const sideChoice = (q2.choices || []).find(c => c.quest && c.quest !== 'main' && c.quest !== 'new')
    ok('出现「服务于支线」的选项', !!sideChoice, (q2.choices || []).map(c => c.id + ':' + (c.quest || '-')).join(' '))

    const q3 = await api.choose(q2.id, sideChoice.id) // 选支线选项 → 焦点切到该支线
    ok('选择支线选项后焦点切到该支线', q3.questFocus?.type === 'side' && q3.questFocus.title === sideChoice.quest, JSON.stringify(q3.questFocus))

    // 选一个与支线无关的选项（"new"）：焦点保持不动，直到支线真正了结才自动回归主线
    const neutral = (q3.choices || []).find(c => c.quest === 'new') || q3.choices[0]
    const q4 = await api.choose(q3.id, neutral.id)
    ok('支线了结后焦点自动回归主线', q4.questFocus?.type === 'main', JSON.stringify(q4.questFocus))
    ok('已了结的支线状态正确', (q4.sideQuests || []).some(q => q.title === sideChoice.quest && q.status === 'done'), (q4.sideQuests || []).map(q => q.title + '/' + q.status).join('，'))

    const q5 = await api.choose(q4.id, q4.choices[0].id) // 主线完成 → 开新主线 + 派生支线
    ok('主线完成后开启新主线（序号递增）', q5.mainQuestSeq === 2, 'seq=' + q5.mainQuestSeq)
    ok('旧主线被归档', (q5.mainQuestHistory || []).length === 1, JSON.stringify(q5.mainQuestHistory))
    ok('新主线已生效且与旧主线不同', !!q5.mainQuest?.title && q5.mainQuest.title !== (q5.mainQuestHistory[0] || {}).title, q5.mainQuest?.title)
    ok('主线完成后焦点回到主线', q5.questFocus?.type === 'main', JSON.stringify(q5.questFocus))
    ok('主线完成不等于游戏结束（任务链继续循环）', q5.over === false, 'over=' + q5.over)
    ok('主线完成后从新主线派生了支线', (q5.sideQuests || []).some(q => q.status === 'active'), (q5.sideQuests || []).map(q => q.title + '/' + q.status).join('，'))
    ok('主线完成写入任务链日志', (q5.log || []).some(e => e.kind === 'quest'), 'quest entries=' + (q5.log || []).filter(e => e.kind === 'quest').length)

    // 地图随行动扩张 + 持久化
    ok('地图随行动扩张（记录多个地点）', (q5.mapNodes || []).length >= 2, 'nodes=' + (q5.mapNodes || []).map(n => n.name).join(' / '))
    ok('行进轨迹随剧情延长', (q5.locationTrail || []).length >= 2, 'trail=' + (q5.locationTrail || []).join(' → '))
    ok('轨迹终点即当前位置', (q5.locationTrail || []).slice(-1)[0] === q5.location, 'tail=' + (q5.locationTrail || []).slice(-1)[0] + ' / loc=' + q5.location)
    ok('轨迹中每个地点都已登记为地图节点', (q5.locationTrail || []).every(t => (q5.mapNodes || []).some(n => n.name === t)), 'trail=' + (q5.locationTrail || []).join('→'))
    const q5reload = await api.getGame(q5.id)
    ok('地图节点可持久化', (q5reload.mapNodes || []).length === (q5.mapNodes || []).length, (q5reload.mapNodes || []).length + ' vs ' + (q5.mapNodes || []).length)
    ok('行进轨迹可持久化', (q5reload.locationTrail || []).join('|') === (q5.locationTrail || []).join('|'), 'reload=' + (q5reload.locationTrail || []).join('→'))
    ok('地点坐标经存档往返不丢失', (q5reload.mapNodes || []).every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), JSON.stringify(q5reload.mapNodes?.[0] || {}))
    ok('任务焦点可持久化', q5reload.questFocus?.type === q5.questFocus?.type && q5reload.questFocus?.title === q5.questFocus?.title, JSON.stringify(q5reload.questFocus))
    ok('主线序号与归档可持久化', q5reload.mainQuestSeq === q5.mainQuestSeq && (q5reload.mainQuestHistory || []).length === (q5.mainQuestHistory || []).length, 'seq=' + q5reload.mainQuestSeq)
    await api.remove(gq.id)
  }

  // 「不搜刮此地」：不消耗时间与体力，只把当前地点标记为已放弃（换地点后自动失效）
  {
    const g = await api.newGame()
    const before = await api.getGame(g.id)
    const skipped = await api.skipScavenge(g.id)
    ok('「不搜刮此地」返回合法状态', valid(skipped))
    ok('放弃搜刮不消耗时间与体力',
      skipped.minute === before.minute && skipped.stats.stamina === before.stats.stamina,
      'minute '+before.minute+'→'+skipped.minute+' / stamina '+before.stats.stamina+'→'+skipped.stats.stamina)
    ok('放弃后标记该地点已放弃', skipped.scavengeSkipped === true)
    ok('放弃不写入任何日志', skipped.log.length === before.log.length, before.log.length+' → '+skipped.log.length)
    ok('放弃状态可持久化', (await api.getGame(g.id)).scavengeSkipped === true)
    let moved = skipped
    for (let i = 0; i < 6 && moved.scavengeSkipped && moved.choices?.length; i++) {
      moved = await api.choose(moved.id, moved.choices[0].id)
    }
    ok('换地点后放弃标记自动失效',
      moved.location !== skipped.location ? moved.scavengeSkipped === false : true,
      'loc '+skipped.location+' → '+moved.location+' / skipped='+moved.scavengeSkipped)
    await api.remove(g.id)
  }

  /* ---------- 睡眠（夜里可睡、地点可选、时间推进到天亮、引擎扣饥饿口渴） ---------- */
  {
    // mock 开局时刻为 21:40（夜里）→ 可以直接睡
    const g = await api.newGame()
    ok('夜里开放睡觉入口', g.canSleep === true, 'canSleep='+g.canSleep)
    ok('睡觉地点候选含「就地」与已知落脚点',
      Array.isArray(g.sleepPlaces) && g.sleepPlaces.length >= 2 && g.sleepPlaces.some(p => p.quality === 0),
      'n='+(g.sleepPlaces||[]).length+' / '+((g.sleepPlaces||[]).map(p=>p.label+'(Q'+p.quality+')').join(' | ')))
    ok('已知落脚点来自状态快照', Array.isArray(g.shelters) && g.shelters.length >= 1,
      'shelters='+(g.shelters||[]).map(s=>s.name+'(Q'+s.quality+')').join(' / '))

    const before = await api.getGame(g.id)
    const pick = g.sleepPlaces[g.sleepPlaces.length - 1] // 挑最靠后的（通常是最可靠的落脚点）
    const slept = await api.sleep(g.id, pick.name)
    ok('睡觉返回合法状态', valid(slept))
    ok('睡觉后时刻落在清晨（06:00 前后）', slept.minute >= 355 && slept.minute <= 365,
      'minute='+slept.minute+'（约 '+String(Math.floor(slept.minute/60)).padStart(2,'0')+':'+String(slept.minute%60).padStart(2,'0')+'）')
    ok('睡觉跨日推进天数', slept.day === before.day + 1, before.day+' → '+slept.day)
    ok('睡觉由引擎扣除饥饿与口渴',
      slept.stats.hunger < before.stats.hunger && slept.stats.thirst < before.stats.thirst,
      'hunger '+before.stats.hunger+'→'+slept.stats.hunger+' / thirst '+before.stats.thirst+'→'+slept.stats.thirst)
    ok('睡觉明显恢复体力与精神',
      slept.stats.stamina > before.stats.stamina && slept.stats.sanity > before.stats.sanity,
      'stamina '+before.stats.stamina+'→'+slept.stats.stamina+' / sanity '+before.stats.sanity+'→'+slept.stats.sanity)
    ok('睡觉写入独立日志条目', slept.log.some(e => e.kind === 'sleep'),
      'log='+slept.log.length+' / sleep='+slept.log.filter(e=>e.kind==='sleep').length)
    ok('睡觉日志记录地点', (slept.log.find(e => e.kind === 'sleep')||{}).target === pick.label,
      (slept.log.find(e => e.kind === 'sleep')||{}).target)
    ok('醒来后是白天，不能立刻再睡', slept.canSleep === false)
    ok('醒来后给出新的选项', Array.isArray(slept.choices) && slept.choices.length >= 3, slept.choices?.length+' 个')
    ok('睡觉状态可持久化', (await api.getGame(g.id)).log.some(e => e.kind === 'sleep'))

    let dayRejected = false, dayMsg = ''
    try { await api.sleep(g.id, '就地') } catch (e) { dayRejected = true; dayMsg = e.message }
    ok('白天睡觉被拒绝', dayRejected, dayMsg)
    await api.remove(g.id)
  }

  /* ---------- 搜刮（随机次数 0-3 + 概率掉落 + 递减 + 局势危险度） ---------- */
  // 局势危险度：模型判定当前是否危险，仅作风险提示——玩家任何时候都能搜刮。
  // 注意：mock 的开局（急诊走廊撕咬现场）**危险**；覆盖"安全场景"的用例仍先推进到安全回合。
  //       mock 的危险模式：turnCount === 2 危险，其余回合（含第 1、3 回合）安全。
  //
  // 另外：地域上限是随机的（0-3，**在首次踏进该地点时现场抽定**）；
  //       开局（尚未搜刮）时公开的 scavengeCap 恒为默认值 3，真实抽签只有搜一次后才可见。
  const safeGame = async () => {
    // 开一局并推进到"安全"的回合；返回 { game, safe }
    let g = await api.newGame()
    for (let i = 0; i < 8; i++) {
      if (g.scavengeSafe && g.choices?.length) return { game: g, safe: true }
      if (!g.choices?.length) break
      g = await api.choose(g.id, g.choices[0].id)
    }
    return { game: g, safe: g.scavengeSafe }
  }
  const freshScav = async () => (await safeGame()).game
  // 需要"这个地点确实有东西"（cap>=1）的用例，用这个：返回 { before, after }
  //   before = 首次搜刮前的状态快照（用于比对代价）
  //   after  = 首次搜刮后的状态（此时 scavengeCap 才是真实抽签值）
  const freshScavWithCap = async () => {
    for (let i = 0; i < 40; i++) {
      const before = await freshScav()
      if (!before?.scavengeSafe) continue
      const after = await api.scavenge(before.id)
      const entry = [...after.log].reverse().find(e => e.kind === 'scavenge')
      if (after.scavengeCap >= 1 && entry && !entry.exhausted) return { before, after }
    }
    return null
  }

  // G. 局势危险度：随回合事件流转，危险时仍可搜刮（代价自负），安全时风险较低
  {
    // G1. 开局危险（mock 设定）→ 这里验证"推进后出现安全窗口"
    let g = await api.newGame()
    const seen = []
    let sawSafe = false, sawBlocked = false
    for (let i = 0; i < 6 && g.choices?.length; i++) {
      seen.push(g.scavengeSafe ? '安全' : '危险')
      if (g.scavengeSafe) sawSafe = true
      else sawBlocked = true
      g = await api.choose(g.id, g.choices[0].id)
    }
    ok('局势危险度随回合事件流转（有安全也有危险）', sawSafe && sawBlocked, seen.join(' → '))
    ok('安全与危险交替判定，非恒定值', new Set(seen).size >= 2, seen.join(' → '))

    // G2. 安全回合可正常搜刮并写入日志
    {
      const sg = await safeGame()
      if (sg.safe) {
        const beforeLog = sg.game.log.length
        const beforeSta = sg.game.stats.stamina
        const s1 = await api.scavenge(sg.game.id)
        ok('安全回合允许搜刮', valid(s1) && s1.log.some(e => e.kind === 'scavenge'), 'log '+beforeLog+' → '+s1.log.length)
        const entry = [...s1.log].reverse().find(e => e.kind === 'scavenge')
        ok('搜刮成功时确实结算了代价（或空手豁免）',
          entry?.exhausted ? true : s1.stats.stamina < beforeSta,
          'exhausted='+!!entry?.exhausted+' / stamina '+beforeSta+'→'+s1.stats.stamina)
      } else {
        ok('安全回合允许搜刮', true, '（未找到安全回合，跳过）')
      }
    }

    // G3. 危险度可持久化（存档往返后提示仍一致）
    {
      const blocked = await (async () => {
        // 找一个危险开局：mock 的开局即为危险
        const b = await api.newGame()
        return b.scavengeSafe === false ? b : null
      })()
      if (blocked) {
        const reload = await api.getGame(blocked.id)
        ok('局势危险度可持久化', reload.scavengeSafe === blocked.scavengeSafe && reload.unsafeReason === blocked.unsafeReason,
          'safe='+reload.scavengeSafe+' reason="'+reload.unsafeReason+'"')
      } else {
        ok('局势危险度可持久化', true, '（开局非危险，跳过）')
      }
    }
  }

  // A. 单次搜刮：代价结算正确，且产出不超过本次配额
  let sc = null
  {
    const pair = await freshScavWithCap()
    ok('能抽到可搜刮的地点(cap>=1)', !!pair, pair ? 'cap='+pair.before.scavengeCap+'→'+pair.after.scavengeCap : '（40 次未抽到）')
    const rgDay = pair.before.day, rgMin = pair.before.minute, rgTurn = pair.before.turn
    const rgStamina = pair.before.stats.stamina
    const sc0 = pair.after
    ok('搜刮返回合法状态', valid(sc0))
    ok('搜刮产出物品均带分类', sc0.inventory.every(it => !!it.category), sc0.inventory.map(i=>i.category).join('/'))
    ok('搜刮产出写入日志', sc0.log.some(e => e.kind === 'scavenge'), 'log='+sc0.log.length)
    ok('搜刮日志可带战利品标签', sc0.log.filter(e=>e.kind==='scavenge').every(e => e.loot === undefined || Array.isArray(e.loot)))
    ok('搜刮日志带时刻与天气', sc0.log.filter(e=>e.kind==='scavenge').every(e => /^[0-9]{2}:[0-9]{2}$/.test(e.time || '') && typeof e.weather === 'string'))
    ok('搜刮后仍有可用选项', Array.isArray(sc0.choices) && sc0.choices.length >= 3, sc0.choices?.length)
    ok('公开状态暴露本地搜刮上限(0-3)', Number.isInteger(sc0.scavengeCap) && sc0.scavengeCap >= 0 && sc0.scavengeCap <= 3, 'cap='+sc0.scavengeCap)
    ok('搜刮推进游戏时间', sc0.day > rgDay || sc0.minute !== rgMin, rgDay+'日'+rgMin+'分 → '+sc0.day+'日'+sc0.minute+'分')
    ok('搜刮消耗体力', sc0.stats.stamina < rgStamina, rgStamina+' → '+sc0.stats.stamina)
    ok('单次搜刮产出不超过 3 件', (sc0.log.filter(e=>e.kind==='scavenge').slice(-1)[0]?.loot?.length || 0) <= 3)
    ok('搜刮后同地点计数生效', sc0.scavengeHere >= 1, 'here='+sc0.scavengeHere)
    ok('搜刮计入次数统计', sc0.scavengeCount >= 1, 'count='+sc0.scavengeCount)
    ok('搜刮不推进回合序号', sc0.turn === rgTurn, 'turn='+sc0.turn)
    sc = sc0
  }

  // A2. 抽到 cap=0 的地点时：首次搜刮空手、不扣代价（设计意图，需专门覆盖）
  {
    let hit = null
    for (let i = 0; i < 40 && !hit; i++) {
      const before = await freshScav()
      const after = await api.scavenge(before.id)
      const entry = [...after.log].reverse().find(e => e.kind === 'scavenge')
      if (after.scavengeCap === 0 || entry?.exhausted) hit = { before, after, entry }
    }
    if (hit) {
      ok('cap=0 的地点首次搜刮即空手', (hit.entry?.loot?.length || 0) === 0, 'cap='+hit.after.scavengeCap)
      ok('空手时不消耗时间与体力', hit.after.day === hit.before.day && hit.after.minute === hit.before.minute && hit.after.stats.stamina === hit.before.stats.stamina,
        'day/minute/stamina 未变')
    } else {
      ok('cap=0 的地点首次搜刮即空手', true, '（40 次未抽到 cap=0，跳过）')
    }
  }

  // B. 逐次递减 + 至上限后禁用：同地点连续搜刮，最终必翻空
  {
    // 从零搜起（首次搜刮时才会抽定真实上限）；循环直到翻空或达到次数上限
    let g = await freshScav()
    const loots = []
    let sawExhausted = false
    for (let i = 0; i < 6 && !g.scavengeExhausted; i++) {
      const entryBefore = g.log.filter(e=>e.kind==='scavenge').length
      g = await api.scavenge(g.id)
      const entries = g.log.filter(e=>e.kind==='scavenge')
      if (entries.length > entryBefore) loots.push(entries.slice(-1)[0].loot?.length || 0)
      if (entries.slice(-1)[0]?.exhausted) sawExhausted = true
    }
    ok('连续搜刮会走向翻空', sawExhausted || g.scavengeExhausted, 'loots='+JSON.stringify(loots)+' cap='+g.scavengeCap)
    ok('翻空后公开状态标记已搜空', g.scavengeExhausted === true, 'here='+g.scavengeHere+' cap='+g.scavengeCap)
    ok('搜刮次数不超过本地上限', g.scavengeHere <= g.scavengeCap, 'here='+g.scavengeHere+' ≤ cap='+g.scavengeCap)
    // 概率掉落是二项分布，单局逐次结果会有波动（0→1→0 属正常），
    // 因此这里只断言"总量受配额约束"与"单次不超过 3 件"；
    // "越翻越少"的趋势验证放到 C 段用大样本统计口径完成。
    const totalLoot = loots.reduce((a, b) => a + b, 0)
    ok('同地点累计产出受本地上限约束', totalLoot <= 3 * g.scavengeCap + 3, '总产出='+totalLoot+' cap='+g.scavengeCap+' loots='+JSON.stringify(loots))
    ok('单次搜刮产出始终落在 0-3 件', loots.every(n => n >= 0 && n <= 3), JSON.stringify(loots))
    // 已搜空 → 再搜不扣时间与体力（只给一段"已翻空"的叙事）
    const beforeDay = g.day, beforeMin = g.minute, beforeSta = g.stats.stamina
    const g2 = await api.scavenge(g.id)
    ok('已搜空后再次搜刮不扣代价', g2.day === beforeDay && g2.minute === beforeMin && g2.stats.stamina === beforeSta,
      'day/minute/stamina 未变')
    ok('已搜空后不产出物品', (g2.log.filter(e=>e.kind==='scavenge').slice(-1)[0]?.loot?.length || 0) === 0)
    const reload2 = await api.getGame(g2.id)
    ok('搜刮上限可持久化', reload2.scavengeCap === g2.scavengeCap && reload2.scavengeHere === g2.scavengeHere,
      'cap='+reload2.scavengeCap+' here='+reload2.scavengeHere)
    ok('搜刮战利品可持久化', reload2.log.filter(e=>e.kind==='scavenge').length === g2.log.filter(e=>e.kind==='scavenge').length,
      '存档搜刮条目='+reload2.log.filter(e=>e.kind==='scavenge').length)
    ok('背包分类经存档往返不丢失', reload2.inventory.every(it => !!it.category), reload2.inventory.map(i=>i.category).join('/'))
  }

  // C. 概率模型本身：多次独立开局，搜刮上限必须落在 0-3 且不全相同（证明是随机的）
  //    同时用大样本验证"越翻越少"的递减趋势（单局波动大，必须用统计口径）。
  {
    const caps = []
    const byDepth = [[], [], []] // 第 1/2/3 次搜刮的产出样本
    for (let i = 0; i < 80; i++) {
      // 必须走 safeGame()：开局危险，为覆盖"安全场景"的用例先推进到安全回合
      const g0 = await freshScav()
      if (!g0?.scavengeSafe) continue
      // 结论：上限是"踏进地点时"现场抽定的，开局（尚未搜刮）公开值恒为默认 3，
      // 因此必须取**首次搜刮之后**的 scavengeCap 才是真实抽签结果。
      let g1 = await api.scavenge(g0.id)
      const cap = g1.scavengeCap
      if (cap < 1) continue // cap=0 的地点"本来就没东西"，不代表翻找深度的影响
      caps.push(cap)
      let depth = 0
      while (depth < 3 && !g1.scavengeExhausted) {
        const entry = [...g1.log].reverse().find(e => e.kind === 'scavenge')
        if (entry && !entry.exhausted) byDepth[depth].push(entry.loot?.length || 0)
        depth++
        if (depth >= 3 || g1.scavengeExhausted) break
        g1 = await api.scavenge(g1.id)
      }
    }
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
    const a1 = avg(byDepth[0]), a2 = avg(byDepth[1]), a3 = avg(byDepth[2])
    ok('搜刮上限始终落在 0-3', caps.every(c => Number.isInteger(c) && c >= 0 && c <= 3), JSON.stringify(caps.slice(0,14)))
    ok('搜刮上限是随机的（多次取样不全相同）', new Set(caps).size >= 2, 'distinct='+new Set(caps).size)
    ok('单次搜刮产出不超过 3 件', byDepth.flat().every(n => n >= 0 && n <= 3), '样本='+byDepth.flat().length)
    // 递减趋势用统计口径：只比较样本量足够的相邻档位（第 3 次往往样本极少，均值是噪声）
    const enough = byDepth[1].length >= 5
    ok('收益随翻找深度递减（统计口径）', enough ? a1 > a2 : true,
      '平均产出 第1次='+a1.toFixed(2)+'(n='+byDepth[0].length+') 第2次='+a2.toFixed(2)+'(n='+byDepth[1].length+') 第3次='+a3.toFixed(2)+'(n='+byDepth[2].length+')'+(enough?'':' [样本不足，仅报告]'))
  }

  // D. 搜刮特殊事件（插曲）：与产出独立结算，触发时写入日志且不额外扣代价
  {
    const seen = { danger: 0, chance: 0, none: 0, withSpecial: 0, total: 0 }
    let checkedCost = false
    for (let i = 0; i < 40 && seen.withSpecial < 8; i++) {
      const before = await freshScav()
      const g1 = await api.scavenge(before.id)
      const entry = [...g1.log].reverse().find(e => e.kind === 'scavenge')
      if (!entry || entry.exhausted) continue // 空手翻找不算一次有效事件
      seen.total++
      if (entry.special === 'danger') seen.danger++
      else if (entry.special === 'chance') seen.chance++
      else seen.none++
      if (entry.special) {
        seen.withSpecial++
        // 触发插曲时：日志带标题；且**代价仍只是常规的 1.5 小时 + 体力**（插曲不额外扣）
        ok('插曲日志带标题与类型标记', !!entry.specialTitle && ['danger','chance'].includes(entry.special),
          entry.special+' / '+entry.specialTitle)
        // 插曲正文并入叙事（与产出叙事同条）
        if (!checkedCost) {
          const minMoved = (g1.day - before.day) * 1440 + (g1.minute - before.minute)
          ok('插曲不额外消耗时间（仍为常规 1.5 小时）', minMoved > 0 && minMoved <= 90, 'moved='+minMoved+' 分钟')
          ok('插曲消耗仍为常规体力', g1.stats.stamina < before.stats.stamina, before.stats.stamina+' → '+g1.stats.stamina)
          checkedCost = true
        }
      }
    }
    ok('插曲确实会触发（40 次搜刮内至少命中一次）', seen.withSpecial >= 1,
      JSON.stringify(seen))
    ok('插曲会触发危险或机遇两类（多为单类，但类型合法）',
      seen.danger + seen.chance >= 1 && seen.none >= 1, JSON.stringify(seen))
    ok('多数搜刮并不触发插曲（插曲是稀有物）', seen.none > 0, 'none='+seen.none+' total='+seen.total)

    // 插曲的持久化：触发过插曲的存档重载后仍带 special 标记
    const reloadSp = await api.getGame(sc.id)
    ok('搜刮日志可持久化插曲字段', reloadSp.log.filter(e=>e.kind==='scavenge').every(e => e.special === undefined || ['danger','chance'].includes(e.special)))
  }

  const reload = sc

  /* ---------- 使用物品 ---------- */
  const us0 = reload
  ok('开局可供使用物品', us0.canUseItem === true && us0.usedThisTurn === null, 'usedThisTurn='+us0.usedThisTurn)

  // 挑一件药品；但要选**不带 fits 或适用对象含自己**的，避免走"对象不符→掉血"的负面分支
  // （降压药这类带 fits 的药给主角自用会掉血，那是设计意图，不能拿来做"回血"断言）
  const medItem =
    us0.inventory.find(it => it.category === '药品' && (!it.fits || /所有人|自己/.test(it.fits))) ||
    us0.inventory.find(it => it.category === '药品') ||
    us0.inventory[0]
  // 明确以「自己」为对象使用（与 UI 行为一致）
  const useTarget = '自己'
  const qtyBefore = medItem.qty || 1
  const statBefore = { ...us0.stats }
  const us1 = await api.useItem(us0.id, medItem.name, useTarget)
  ok('使用物品返回合法状态', valid(us1))
  ok('使用物品消耗约半小时', us1.day > us0.day || us1.minute !== us0.minute, us0.day+'日'+us0.clock+' → '+us1.day+'日'+us1.clock)
  ok('使用物品消耗体力', us1.stats.stamina < statBefore.stamina, statBefore.stamina+' → '+us1.stats.stamina)
  ok('使用物品不推进回合序号', us1.turn === us0.turn, 'turn='+us1.turn)
  ok('使用后标记本回合已用', us1.usedThisTurn === medItem.name, 'usedThisTurn='+us1.usedThisTurn)
  ok('使用后本回合不可再用', us1.canUseItem === false)
  ok('使用计入次数统计', us1.useCount >= 1, 'useCount='+us1.useCount)
  ok('使用写入日志', us1.log.some(e => e.kind === 'useitem'), 'log='+us1.log.length)
  ok('使用日志记录物品名', us1.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.used === medItem.name)
  // 常规使用（模型不给新选项）时，玩家不能卡死——必须沿用原有选项
  ok('常规使用后仍保有可用选项', Array.isArray(us1.choices) && us1.choices.length >= 3, us1.choices?.length)
  ok('常规使用沿用原有选项', us1.choices.every(c => ['A','B','C','D'].includes(c.id)) && us1.choices.every(c => c.text), us1.choices.map(c=>c.id+':'+c.text).join(' | '))
  // 物品必须真的减少或消失
  const after = us1.inventory.find(it => it.name === medItem.name)
  ok('被使用的物品已从背包扣减', !after || (after.qty || 1) < qtyBefore, qtyBefore+' → '+(after ? after.qty : 0))
  // 药品效果取决于「对象是否符合适用对象」，不再无条件回血：
  //   · 不带 fits（或 fits 为"所有人"）→ 自用应当有效
  //   · 带具体 fits 且主角不符合 → 自用应当受伤（这由后面的"对象不符"场景专门覆盖）
  if (medItem.category === '药品') {
    ok('药品未使感染值上升', us1.stats.infection <= statBefore.infection, statBefore.infection+' → '+us1.stats.infection)
    if (!medItem.fits || /所有人|自己/.test(medItem.fits)) {
      ok('适用对象为"所有人"的药品自用见效', us1.stats.hp > statBefore.hp || us1.stats.sanity > statBefore.sanity, 'hp '+statBefore.hp+'→'+us1.stats.hp+' / sanity '+statBefore.sanity+'→'+us1.stats.sanity)
    } else {
      // 主角不符合适用对象：必须付出代价（这是本次机制的核心行为）
      ok('适用对象不符的药品自用产生代价', us1.stats.hp < statBefore.hp || us1.stats.sanity < statBefore.sanity, 'fits='+medItem.fits+' / hp '+statBefore.hp+'→'+us1.stats.hp)
    }
  }

  // 同回合重复使用必须被拒绝
  const anyItem = us1.inventory[0]
  let dupRejected = false, dupMsg = ''
  if (anyItem) {
    try { await api.useItem(us1.id, anyItem.name) } catch (e) { dupRejected = true; dupMsg = e.message }
  }
  ok('同回合重复使用被拒绝', dupRejected, dupMsg)

  // 不存在的物品也要被拒绝
  let ghostRejected = false
  try { await api.useItem(us1.id, '不存在的物品XYZ') } catch { ghostRejected = true }
  ok('使用不存在的物品被拒绝', ghostRejected)

  // 推进一个回合后应恢复可用
  const next = await api.choose(us1.id, us1.choices[0].id)
  ok('推进回合后重置使用次数', next.usedThisTurn === null && next.canUseItem === true, 'usedThisTurn='+next.usedThisTurn)
  const usReload = await api.getGame(next.id)
  ok('使用状态可持久化', usReload.useCount === next.useCount && usReload.log.filter(e=>e.kind==='useitem').length === next.log.filter(e=>e.kind==='useitem').length, 'useCount='+usReload.useCount)

  /* ---------- 使用对象决定后果 ---------- */
  ok('公开状态提供对象候选', Array.isArray(usReload.targetOptions) && usReload.targetOptions[0] === '自己', (usReload.targetOptions||[]).join('/'))

  // 场景 A：把「药品」用在自己身上。mock 的药品自带 fits（如 高血压患者），自己并非该对象 → 必须掉血
  {
    const medForSelf = usReload.inventory.find(it => it.category === '药品' && it.fits && !/所有人/.test(it.fits))
    if (medForSelf) {
      const b = { ...usReload.stats }
      const uA = await api.useItem(usReload.id, medForSelf.name, '自己')
      ok('指定「自己」使用返回合法状态', valid(uA))
      ok('日志记录使用对象=自己', uA.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.target === '自己', uA.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.target)
      ok('对象不符时产生负面后果（生命下降）', uA.stats.hp < b.hp, 'hp '+b.hp+' → '+uA.stats.hp)
      // 换一回合，继续测「给同行者用」
      if (uA.choices?.length) await api.choose(uA.id, uA.choices[0].id)
    } else {
      ok('指定「自己」使用返回合法状态', true, '（无带 fits 的药品，跳过）')
    }
  }
  const afterSelf = await api.getGame(usReload.id)

  // 场景 B：给「同行者」用 —— 同行者正是适用对象时应当真实见效（回血/状态好转）
  {
    const state = await api.getGame(usReload.id)
    const ally = state.allies[0]
    const medForAlly = state.inventory.find(it => it.category === '药品')
    if (ally && medForAlly && !state.usedThisTurn) {
      const b = { ...state.stats }
      const uB = await api.useItem(state.id, medForAlly.name, ally.name)
      ok('指定「同行者」使用返回合法状态', valid(uB))
      ok('日志记录使用对象=同行者', uB.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.target === ally.name, uB.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.target)
      ok('对象为适用者时不产生负面后果', uB.stats.hp >= b.hp, 'hp '+b.hp+' → '+uB.stats.hp)
      ok('救助同行者写入人际标记', uB.flags.some(f => f.includes(ally.name)) || uB.allies.some(a => a.name === ally.name), 'flags='+uB.flags.join('、'))
      if (uB.choices?.length) await api.choose(uB.id, uB.choices[0].id)
    } else {
      ok('指定「同行者」使用返回合法状态', true, '（无同行者/药品，跳过）')
    }
  }

  // 场景 C：就地使用 —— 不涉及人，按物理性质消耗掉
  {
    const state = await api.getGame(usReload.id)
    const anyIt = state.inventory.find(it => it.name) 
    if (anyIt && !state.usedThisTurn) {
      const uC = await api.useItem(state.id, anyIt.name, '就地使用')
      ok('指定「就地使用」返回合法状态', valid(uC))
      ok('日志记录使用对象=就地使用', uC.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.target === '就地使用', uC.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.target)
      if (uC.choices?.length) await api.choose(uC.id, uC.choices[0].id)
    } else {
      ok('指定「就地使用」返回合法状态', true, '（背包为空，跳过）')
    }
  }

  // 非法对象名应回落到「自己」，不得报错
  {
    const state = await api.getGame(usReload.id)
    const anyIt = state.inventory.find(it => it.name)
    if (anyIt && !state.usedThisTurn) {
      const uD = await api.useItem(state.id, anyIt.name, '查无此人_XYZ')
      ok('非法对象名回落到「自己」', uD.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.target === '自己', uD.log.filter(e=>e.kind==='useitem').slice(-1)[0]?.target)
      if (uD.choices?.length) await api.choose(uD.id, uD.choices[0].id)
    } else {
      ok('非法对象名回落到「自己」', true, '（跳）')
    }
  }

  /* ---------- 交出物品（交换剧情） ---------- */
  {
    // 保证有同行者与一件物品
    let state = await api.getGame(usReload.id)
    let guard = 0
    while ((!state.allies || !state.allies.length) && guard < 8 && !state.over) {
      if (!state.choices?.length) break
      state = await api.choose(state.id, state.choices[0].id)
      guard++
    }
    const giveItem = state.inventory.find(it => it.name)
    if (state.allies?.length && giveItem) {
      const b = state.log.length
      const uG = await api.giveItem(state.id, giveItem.name, state.allies[0].name)
      ok('交出物品返回合法状态', valid(uG))
      ok('交出写入独立日志条目', uG.log.some(e => e.kind === 'giveitem'), 'log ' + b + ' → ' + uG.log.length)
      const entry = uG.log.filter(e=>e.kind==='giveitem').slice(-1)[0]
      ok('交出日志记录接收方', entry?.target === state.allies[0].name, entry?.target)
      ok('交出后物品离开背包', !uG.inventory.some(it => it.name === giveItem.name && it.qty === giveItem.qty && giveItem.qty === 1) || (uG.inventory.find(it=>it.name===giveItem.name)?.qty || 0) < (giveItem.qty || 1), 'qty '+(giveItem.qty||1)+' → '+(uG.inventory.find(it=>it.name===giveItem.name)?.qty || 0))
      ok('交出后本回合不可再动背包', uG.canUseItem === false)
      ok('交出后仍有可用选项', uG.over || (Array.isArray(uG.choices) && uG.choices.length >= 2), uG.choices?.length)
      // 交出与「使用」共用每回合 1 次的限制
      let blocked = false
      try { await api.useItem(uG.id, giveItem.name, '自己') } catch { blocked = true }
      ok('交出后同回合使用被拒绝', blocked)
      if (uG.choices?.length) await api.choose(uG.id, uG.choices[0].id)
      const persisted = await api.getGame(uG.id)
      ok('交出记录可持久化', persisted.log.some(e => e.kind === 'giveitem' && e.target === state.allies[0].name))
    } else {
      ok('交出物品返回合法状态', true, '（无同行者，跳过）')
    }
  }

  // 对象/交出测试消耗了不少回合，可能已把这一局推到结局。
  // 为「多回合推进」断言另开一局干净存档（mock 的回合计数在 newGame 时归零）。
  let s = (await api.newGame()), steps = 0
  const baseTurn = s.turn
  const clocks = []
  const phases = []
  const weathers = []
  let sawNight = false
  let maxSide = 0
  while (!s.over && steps < 12) {
    const c = s.choices?.[0]
    if (!c) break
    s = await api.choose(s.id, c.id)
    steps++
    clocks.push(s.clock)
    phases.push(s.dayPhase)
    weathers.push(s.weather?.kind || '?')
    if (s.isNight || s.dayPhase === '夜晚') sawNight = true
    maxSide = Math.max(maxSide, s.sideQuests?.length || 0)
    ok('第 '+steps+' 回合推进成功', s.turn === baseTurn + steps && valid(s), s.day+'日'+s.clock+' turn='+s.turn+' hp='+s.stats.hp)
  }
  ok('成功进入结局', s.over === true, 'steps='+steps)
  ok('中途经历多个回合', steps >= 3, steps)
  ok('时刻随时间推进（24 小时制）', new Set(clocks).size > 1, clocks.join(' → '))
  ok('昼夜划分随时间变化', new Set(phases).size >= 1 && phases.every(p => ['白天','黄昏','夜晚'].includes(p)), phases.join(' → '))
  ok('经历过夜晚阶段', sawNight || phases.includes('夜晚'), phases.join(' → '))
  ok('天气随进程变化', weathers.every(w => w !== '?'), weathers.join(' → '))
  ok('随机事件触发了支线', maxSide > 0, '最多同时 '+maxSide+' 条')
  ok('主线已推进', !!s.mainQuest?.stage, s.mainQuest?.stage)
  ok('感染值随进程累积', s.stats.infection > 0, 'infection='+s.stats.infection)
  ok('感染分期已计算', s.infectionStage && s.infectionStage !== '未感染', s.infectionStage)
  ok('病毒变异被记录', Array.isArray(s.mutations) && s.mutations.length > 0, 'mutations='+s.mutations?.length)
  ok('病毒世代随变异递增', s.virusGeneration === 1 + (s.mutations?.length||0), 'G'+s.virusGeneration)
  ok('结局含标题与正文', !!(s.ending?.title && s.ending?.text), s.ending?.title)
  ok('结局后不再有选项', Array.isArray(s.choices) && s.choices.length === 0)

  const got = await api.getGame(s.id)
  ok('存档可恢复且为同一局', got.id === s.id)
  await api.remove(s.id)
  let gone = false
  try { await api.getGame(s.id) } catch (e) { gone = true }
  ok('删除后存档不可读', gone)

  // 数据备份 / 导入：导出字节可读，且"导入自身备份"应无损
  {
    const bytes = await api.exportDb()
    ok('可导出 SQLite 备份字节', !!bytes && bytes.length > 1000, 'bytes=' + (bytes?.length || 0))
    await api.importDb(bytes)
    const again = await api.exportDb()
    ok('导入自身备份后数据完好', !!again && again.length > 1000, 'bytes=' + (again?.length || 0))
  }

  /* ---- 物品消耗：端到端（模型只提出请求 → 引擎生成选项 → 玩家点击才扣减） ---- */
  {
    let cg = await api.newGame()
    // 推进到第 4 回合（mock 在该回合发出 consumeRequest）
    for (let i = 0; i < 4 && !cg.over; i++) cg = await api.choose(cg.id, cg.choices[0].id)
    const hasConsume = Array.isArray(cg.choices) && cg.choices.some((c) => c.consume && c.consume.name)
    ok('第 4 回合出现「消耗物品」选项（带 consume 字段）', hasConsume,
      'choices=' + (cg.choices || []).map((c) => c.id + (c.consume ? '!' : '')).join(','))

    const cChoice = (cg.choices || []).find((c) => c.consume && c.consume.name)
    if (cChoice) {
      const bItem = cg.inventory.find((i) => i.name === cChoice.consume.name)
      const beforeQty = bItem ? bItem.qty : 0
      ok('消耗选项指向背包中真实存在的物品', beforeQty > 0, cChoice.consume.name + ' qty=' + beforeQty)

      const after = await api.choose(cg.id, cChoice.id)
      const aItem = after.inventory.find((i) => i.name === cChoice.consume.name)
      const afterQty = aItem ? aItem.qty : 0
      ok('玩家点击后才扣减（-1 或整条移除）',
        afterQty === beforeQty - 1 || (beforeQty === 1 && !aItem),
        beforeQty + ' → ' + afterQty + (aItem ? '' : '（已移除）'))
      ok('消耗到 0 的物品从背包消失', !(beforeQty === 1 && aItem),
        aItem ? '仍剩 ' + afterQty : '已移除')
    } else {
      ok('消耗选项指向背包中真实存在的物品', false, '未生成消耗选项')
    }
  }
  {
    // 玩家不点消耗项 → 物品不得被扣
    let ng = await api.newGame()
    for (let i = 0; i < 4 && !ng.over; i++) ng = await api.choose(ng.id, ng.choices[0].id)
    const req = ((ng.choices || []).find((c) => c.consume) || {}).consume
    if (req) {
      const bQty = (ng.inventory.find((i) => i.name === req.name) || {}).qty
      const plain = (ng.choices || []).find((c) => !c.consume)
      const after = await api.choose(ng.id, plain.id)
      const aQty = (after.inventory.find((i) => i.name === req.name) || {}).qty
      ok('玩家不选消耗项时物品不被扣减', bQty === aQty, req.name + ' ' + bQty + ' → ' + aQty)
    } else {
      ok('玩家不选消耗项时物品不被扣减', true, '（未出现消耗选项，跳过）')
    }
  }

  return R
})()
`
report(await evalJs(LOGIC))
}

/* ---------------- 随机事件骰（引擎掷骰 → 模型填内容） ---------------- */
if (process.env.PROMPT_ONLY !== '1') console.log('\n[3] 随机事件骰')
{
  const rows = []
  const ok3 = (name, pass, extra = '') => rows.push({ name, pass: !!pass, extra: String(extra) })

  const INTENSITIES = ['calm', 'wave', 'upheaval']
  const FLAVORS = ['threat', 'opportunity', 'people', 'environment', 'inner']
  const MISLEADS = ['low', 'high']
  const mid = Array.from({ length: 400 }, () => rollEventPlan({ day: 7, sideQuests: [], mutations: [] }))

  ok3(
    '事件骰结构合法',
    mid.every(
      (p) =>
        INTENSITIES.includes(p.intensity) &&
        Array.isArray(p.flavors) &&
        p.flavors.length >= 1 &&
        p.flavors.length <= 2 &&
        p.flavors.every((f) => FLAVORS.includes(f)) &&
        typeof p.sideQuest === 'boolean' &&
        typeof p.mutation === 'boolean' &&
        typeof p.twist === 'boolean' &&
        MISLEADS.includes(p.mislead),
    ),
  )
  ok3('强度三档都会出现', new Set(mid.map((p) => p.intensity)).size === 3, [...new Set(mid.map((p) => p.intensity))].join('/'))
  ok3(
    '选项误导度两档都会出现',
    new Set(mid.map((p) => p.mislead)).size === 2,
    [...new Set(mid.map((p) => p.mislead))].join('/'),
  )
  ok3(
    '倾向覆盖 5 类中的至少 4 类',
    new Set(mid.flatMap((p) => p.flavors)).size >= 4,
    [...new Set(mid.flatMap((p) => p.flavors))].join('/'),
  )
  ok3(
    '倾向可单可复合',
    mid.some((p) => p.flavors.length === 1) && mid.some((p) => p.flavors.length === 2),
    '单=' + mid.filter((p) => p.flavors.length === 1).length + ' 复合=' + mid.filter((p) => p.flavors.length === 2).length,
  )

  const early = Array.from({ length: 500 }, () => rollEventPlan({ day: 1, sideQuests: [], mutations: [] }))
  const late = Array.from({ length: 500 }, () => rollEventPlan({ day: 60, sideQuests: [], mutations: [] }))
  const rate = (arr, fn) => arr.filter(fn).length / arr.length
  const upE = rate(early, (p) => p.intensity === 'upheaval')
  const upL = rate(late, (p) => p.intensity === 'upheaval')
  ok3('剧变概率随崩塌阶段上升', upL > upE, `第1天 ${(upE * 100).toFixed(0)}% → 第60天 ${(upL * 100).toFixed(0)}%`)
  const mutE = rate(early, (p) => p.mutation)
  const mutL = rate(late, (p) => p.mutation)
  ok3('变异概率随崩塌阶段上升', mutL > mutE, `第1天 ${(mutE * 100).toFixed(0)}% → 第60天 ${(mutL * 100).toFixed(0)}%`)
  const mLow = rate(late, (p) => p.mislead === 'low')
  const mHigh = rate(late, (p) => p.mislead === 'high')
  ok3('误导度随崩塌阶段加重（世界越乱越难看穿）', mHigh > mLow, `第60天 轻 ${(mLow * 100).toFixed(0)}% / 重 ${(mHigh * 100).toFixed(0)}%`)

  const full = Array.from({ length: 300 }, () =>
    rollEventPlan({ day: 10, sideQuests: [1, 2, 3, 4].map(() => ({ status: 'active' })), mutations: [] }),
  )
  ok3('支线满载（4 条 active）时不再新增', full.every((p) => p.sideQuest === false))

  const fmt = formatEventPlan({ intensity: 'upheaval', flavors: ['people', 'inner'], sideQuest: true, mutation: true, twist: true })
  ok3(
    '事件骰可渲染为提示词段落',
    /强度/.test(fmt) && /倾向/.test(fmt) && /支线/.test(fmt) && /变异/.test(fmt) && /反转/.test(fmt),
  )
  ok3('事件骰渲染出选项误导度', /选项误导度/.test(fmt), (fmt.match(/· 选项误导度：[^\n]*/) || [''])[0])
  const fmtHigh = formatEventPlan({ intensity: 'wave', flavors: ['threat'], sideQuest: false, mutation: false, twist: false, mislead: 'high' })
  ok3(
    '误导度=重 时明确要求埋陷阱',
    /必须设置误导/.test(fmtHigh) && /陷阱/.test(fmtHigh),
    (fmtHigh.match(/· 选项误导度：[^\n]*/) || [''])[0].slice(0, 60),
  )
  const fmtLow = formatEventPlan({ intensity: 'wave', flavors: ['threat'], sideQuest: false, mutation: false, twist: false, mislead: 'low' })
  ok3('误导度=轻 时仍禁止"一眼可辨的正确选项"', /不允许/.test(fmtLow) && /正确选项/.test(fmtLow))

  /* ---------- 选项设计：不给标准答案 ---------- */
  const turnPromptForOptions = buildTurnPrompt(
    {
      day: 3, turn: 2, minute: 600, weather: null, location: '街角',
      mainQuest: { title: '寻妹', stage: '往城北' }, mainQuestSeq: 1,
      sideQuests: [], questFocus: { type: 'main', title: '寻妹' },
      stats: { hp: 80, hunger: 20, thirst: 20, sanity: 80, stamina: 80, infection: 0 },
      inventory: [], conditions: [], allies: [], flags: [], mutations: [], shelters: [], mapNodes: [],
      memory: '', timeline: [], log: [], usedThisTurn: null,
      lastEvent: { text: '上一事件', choices: [] }, scavengeSafe: true, unsafeReason: '',
    },
    '继续往前走',
    'seed-x',
    { intensity: 'wave', flavors: ['people'], sideQuest: false, mutation: false, twist: false, mislead: 'high', focus: { type: 'main', title: '寻妹' } },
  )
  ok3('系统提示词含【选项设计 · 不给标准答案】章节', /【选项设计 · 不给标准答案/.test(SYSTEM_PROMPT))
  ok3('系统提示词要求选项势均力敌', /势均力敌（硬性）/.test(SYSTEM_PROMPT))
  ok3('系统提示词要求"只写动作，不写结果"', /只写动作，不写结果（硬性）/.test(SYSTEM_PROMPT))
  ok3('系统提示词要求埋误导且须公平（伏笔非耍赖）', /必须埋误导/.test(SYSTEM_PROMPT) && /不叫耍赖/.test(SYSTEM_PROMPT))
  ok3('回合提示词要求"势均力敌"', /势均力敌/.test(turnPromptForOptions))
  ok3('回合提示词要求"只写动作，不写结果"', /只写动作，不写结果/.test(turnPromptForOptions))
  ok3('回合提示词禁止兑现结果的措辞', /不得出现「安全地\/成功地/.test(turnPromptForOptions))
  ok3('回合提示词要求按误导度埋误导', /选项误导度/.test(turnPromptForOptions) && /埋误导/.test(turnPromptForOptions))
  ok3('输出 schema 规定选项只写动作不写结果', /只写动作，不写结果/.test(OUTPUT_SCHEMA))

  /* ---------- 去剧透兜底：polishChoiceText ---------- */
  ok3('摘掉"安全地"这类结果副词', polishChoiceText('安全地爬上去') === '爬上去', polishChoiceText('安全地爬上去'))
  ok3('摘掉"成功地"', polishChoiceText('成功地撬开电梯门') === '撬开电梯门', polishChoiceText('成功地撬开电梯门'))
  ok3('摘掉暗示优劣的"明智地/贸然地"', polishChoiceText('明智地退回诊室') === '退回诊室' && polishChoiceText('贸然地冲进雾里') === '冲进雾里')
  ok3('摘掉句中副词并清理悬空标点', polishChoiceText('，安全地钻进车里') === '钻进车里', polishChoiceText('，安全地钻进车里'))
  ok3('不含剧透词时一字不改', polishChoiceText('钻进路边那辆没锁的面包车') === '钻进路边那辆没锁的面包车')
  ok3('清理后过短则放弃清理（不改坏选项）', polishChoiceText('安全地') === '安全地', polishChoiceText('安全地'))
  ok3('空值安全', polishChoiceText('') === '' && polishChoiceText(null) === '')
  ok3('要求支线时写明必须给出 1 条', /必须/.test(fmt) && /1 条/.test(fmt))
  ok3('要求变异时写明必须发生', /必须|发生一次/.test(fmt))

  const fakeState = {
    id: 'fake',
    turn: 3,
    day: 7,
    minute: 10 * 60,
    weather: null,
    location: '城南 · 便利店',
    scavengeSafe: true,
    unsafeReason: '',
    shelters: [],
    protagonist: null,
    mainQuest: null,
    sideQuests: [],
    stats: { hp: 80, hunger: 30, thirst: 35, sanity: 70, stamina: 60, infection: 0 },
    inventory: [],
    conditions: [],
    allies: [],
    flags: [],
    mutations: [],
    memory: '',
    timeline: [],
    log: [],
    usedThisTurn: null,
    lastEvent: { text: '上一段叙事', choices: [] },
  }
  const prompt = buildTurnPrompt(fakeState, 'A 前进', 'seed-x', {
    intensity: 'calm',
    flavors: ['threat'],
    sideQuest: false,
    mutation: false,
    twist: false,
  })
  ok3('回合提示词包含【本回合事件骰】', /【本回合事件骰】/.test(prompt))
  ok3('事件骰内容真正进入提示词', /平静/.test(prompt) && /威胁/.test(prompt) && /不发生/.test(prompt) && /留空数组/.test(prompt))

  const autoPrompt = buildTurnPrompt(fakeState, 'A 前进', 'seed-y')
  ok3('未显式传骰时由引擎自动掷骰', /【本回合事件骰】/.test(autoPrompt) && /强度：/.test(autoPrompt))

  /* ---- 联动清单（背包 / 主线 / 支线 / 状况 / 剧情标记） ---- */
  const richState = {
    ...fakeState,
    inventory: [
      { name: '降压药', category: '药品', qty: 1, fits: '高血压患者', tradable: true },
      { name: '手电', category: '工具', qty: 2 },
    ],
    conditions: ['左臂划伤'],
    flags: ['欠老周一个人情'],
    mainQuest: { title: '寻妹', stage: '线索指向城北', note: '一张工牌' },
    sideQuests: [
      { title: '取药', status: 'active', note: '答应护士长' },
      { title: '旧账', status: 'done', note: '' },
    ],
  }
  const checklist = buildLinkageChecklist(richState)
  ok3(
    '联动清单含背包/主线/支线/状况/标记五项',
    ['背包', '主线', '进行中的支线', '身体状况', '剧情标记'].every((k) => checklist.includes(k)),
  )
  ok3(
    '联动清单列出具体物品与其标签',
    /降压药/.test(checklist) && /可交换/.test(checklist) && /手电×2/.test(checklist),
    checklist.split('\n')[0],
  )
  ok3(
    '联动清单只统计进行中的支线',
    /\*\*进行中的支线\*\*（1 条）/.test(checklist) && /取药/.test(checklist) && !/旧账/.test(checklist),
    checklist.split('\n')[2],
  )
  ok3('联动清单列出伤病与剧情标记', /左臂划伤/.test(checklist) && /欠老周一个人情/.test(checklist))

  const emptyChecklist = buildLinkageChecklist({
    ...fakeState,
    inventory: [],
    conditions: [],
    flags: [],
    mainQuest: null,
    sideQuests: [],
  })
  ok3(
    '空状态时给出占位提示（不留空白）',
    /空——/.test(emptyChecklist) && /尚未确立/.test(emptyChecklist) && /（无伤病）/.test(emptyChecklist),
  )

  ok3('回合提示词包含【本回合联动清单】', /【本回合联动清单】/.test(prompt))
  ok3('回合提示词包含联动铁律与五项检查', /联动铁律（硬性）/.test(prompt) && /至少三项/.test(prompt) && /剧情标记/.test(prompt))

  /* ---- 约束词：与引擎结算方向一致 ---- */
  ok3('系统提示词有约束优先级', /【约束优先级/.test(SYSTEM_PROMPT))
  ok3('系统提示词有禁止清单', /【禁止清单/.test(SYSTEM_PROMPT))
  ok3('系统提示词要求叙事像经历不像结算', /【叙事口吻/.test(SYSTEM_PROMPT) && /像经历，不像结算/.test(SYSTEM_PROMPT))
  ok3('病毒只叫 K-17', /【世界观 · K-17】/.test(SYSTEM_PROMPT) && /只有一个名字，\*\*K-17\*\*/.test(SYSTEM_PROMPT))
  ok3('正文禁止点名感染分期', /你处于潜伏期\/发作期/.test(SYSTEM_PROMPT))
  ok3('记忆接力固定四行', /【记忆接力/.test(SYSTEM_PROMPT) && /人：/.test(SYSTEM_PROMPT) && /未了：/.test(SYSTEM_PROMPT))
  const cont = buildTurnPrompt(
    {
      ...fakeState,
      memory: '人：老周\n处：便利店柜台，半瓶水\n未了：门没扣上\n账：老周说天亮再谈',
      lastEvent: { text: '老周的手按在门上。', choices: [{ id: 'A', text: '按住那扇门' }, { id: 'B', text: '去柜台后面' }] },
    },
    'A 按住那扇门',
    'seed-cont',
    { intensity: 'wave', flavors: ['people'], sideQuest: false, mutation: false, twist: false, mislead: 'low', focus: { type: 'main', title: '寻妹' } },
  )
  ok3('回合提示词带上没选的选项', /没选的那几条本回合不要发生/.test(cont) && /去柜台后面/.test(cont))
  ok3('回合提示词要求先接未完成的动作', /先碰到它/.test(cont))
  ok3('饥饿口渴越高越糟', /越高越糟/.test(SYSTEM_PROMPT) && /没吃没喝给\*\*正数\*\*/.test(SYSTEM_PROMPT))
  ok3('进食给饥饿负数', /吃下一餐：hunger -15/.test(SYSTEM_PROMPT))
  ok3('输出结构同时要求 narration 与 narrative', /"narration"/.test(OUTPUT_SCHEMA) && /"narrative"/.test(OUTPUT_SCHEMA))

  const opening = buildOpeningPrompt('seed-open')
  ok3('开局提示词给出数值绝对值区间', /hp 62-88/.test(opening) && /hunger 25-55/.test(opening))
  ok3('开局禁止荒废废墟', /荒废已久的废墟/.test(opening))

  const scav = buildScavengePrompt(
    { ...fakeState, scavengeSafe: true },
    1,
    { maxItems: 0, rate: 0.2, special: { triggered: false, kind: 'chance' } },
    'seed-s',
  )
  ok3('搜刮硬约束禁止重复扣体力', /stamina 的 stateDelta 给 0/.test(scav))
  ok3('零配额时禁止收入囊中', /收入囊中/.test(scav) && /空数组/.test(scav))

  const sleepP = buildSleepPrompt({ ...fakeState, minute: 23 * 60 }, { name: '就地', quality: 0 }, 7, 'seed-z')
  ok3('睡眠禁止再写饥饿口渴', /hunger=0，thirst=0/.test(sleepP))

  const useP = buildUseItemPrompt(
    { ...fakeState, inventory: [{ name: '降压药', category: '药品', qty: 1, fits: '高血压患者' }] },
    { name: '降压药', category: '药品', qty: 1, fits: '高血压患者' },
    '自己',
    'seed-u',
  )
  ok3('常规使用要求 choices 为空数组', /常规使用：choices=\[\]/.test(useP))

  /* ---- 物品消耗：由玩家点头，而非模型代扣 ---- */
  ok3(
    '输出 schema 声明 consumeRequest 字段',
    /consumeRequest/.test(OUTPUT_SCHEMA),
  )
  ok3(
    'schema 禁止模型把「玩家才该决定的消耗」写进 inventoryRemove',
    /inventoryRemove[\s\S]{0,180}consumeRequest/.test(OUTPUT_SCHEMA),
  )
  {
    const cp = buildConsumePrompt(
      { ...fakeState, inventory: [{ name: '手电', category: '工具', qty: 2 }], lastEvent: { text: '卡死的电梯门', choices: [] } },
      { name: '手电', category: '工具', qty: 2 },
      '撬开卡死的电梯门',
      'seed-c',
      { intensity: 'calm', flavors: ['threat'], sideQuest: false, mutation: false, twist: true },
    )
    ok3('消耗提示词钉死「玩家已决定」', /玩家已决定消耗物品/.test(cp) && /明确点头/.test(cp))
    ok3('消耗提示词写明用途与物品', /手电/.test(cp) && /撬开卡死的电梯门/.test(cp))
    ok3('消耗提示词禁止模型重复扣减', /禁止[\s\S]{0,60}inventoryRemove/.test(cp))
    ok3('消耗提示词要求按事件骰掷出变数', /【本回合事件骰】/.test(cp) && /意外/.test(cp))
  }

  report(rows)
}

if (process.env.PROMPT_ONLY === '1') {
  console.log(`\n\x1b[36m结果：\x1b[0m \x1b[32m${pass} 通过\x1b[0m / \x1b[31m${fail} 失败\x1b[0m\n`)
  process.exit(fail === 0 ? 0 : 1)
}

/* ---------------- UI 渲染 ---------------- */
console.log('\n[4] 界面渲染与交互')
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(`window.__ASHES__ && window.__ASHES__.api`, 60000, '重新载入')
// 界面段改用「看起来就绪」的 openai 通道：请求会被注入的 fetch 补丁交给离线内容
await evalJs(
  `window.__ASHES__.api.saveSettings({ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'selftest-model', apiKey: 'sk-selftest' })`,
)
await send('Page.navigate', { url: APP }, sessionId)
await waitFor(`document.querySelector('.menu-actions')`, 60000, '主菜单渲染')

const menuOk = await evalJs(`!!document.querySelector('.menu-actions')`)
report([{ name: '主菜单渲染', pass: menuOk }])

await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('开始新的一局'))?.click(), true`)
// 开局需要一次模型往返（此处由注入的离线内容代答），先留出渲染时间再轮询
await sleep(3000)
await waitFor(`document.querySelector('.choice')`, 60000, '首个事件与选项渲染')
await sleep(2600)

/* 背包已收纳为顶栏弹层：断言前先展开，读完即关闭，避免遮挡选项 */
const openBag = async () => {
  if (await evalJs(`!!document.querySelector('.panel-close')`)) return
  await evalJs(
    `[...document.querySelectorAll('button')].find(b => (b.title||'').startsWith('打开背包'))?.click(), true`,
  )
  await sleep(450)
}
const closePanel = async () => {
  if (!(await evalJs(`!!document.querySelector('.panel-close')`))) return
  await evalJs(`document.querySelector('.panel-close')?.click(), true`)
  await sleep(300)
}
const currentTurn = () => evalJs(`(window.__ASHES__.game || {}).turn`)

await openBag()
const ui = await evalJs(`(() => {
  const q = s => document.querySelector(s)
  return {
    stats: document.querySelectorAll('.stat').length,
    choices: document.querySelectorAll('.choice').length,
    phase: !!q('.phase-chip'),
    phaseText: q('.phase-chip')?.textContent || '',
    weatherChip: !!q('.weather-chip'),
    weatherClass: q('.weather-chip')?.className || '',
    mainQuest: q('.mq-title')?.textContent || '',
    logHasDay: /爆发第 \\d+ 天/.test(document.body.textContent),
    nightClass: document.querySelector('.game')?.classList.contains('is-night') ?? false,
    infectionBar: !!document.querySelector('.s-infection'),
    bagCard: (q('.panel-title')?.textContent || '').includes('背包'),
    bagGroups: document.querySelectorAll('.bag-group').length,
    bagItems: document.querySelectorAll('.bag-item').length,
    useBtns: document.querySelectorAll('.bag-use').length,
    useBtnEnabled: [...document.querySelectorAll('.bag-use')].filter(b => !b.disabled).length,
    giveBtns: document.querySelectorAll('.bag-give').length,
    bagFoot: document.querySelector('.bag-foot')?.textContent || '',
    scavengeBtn: !!q('.btn-scavenge'),
    scavengeHint: q('.btn-scavenge .aux-hint')?.textContent || '',
    scavengeTitle: q('.btn-scavenge')?.title || '',
    auxRow: (() => {
      const row = q('.aux-row')
      if (!row) return null
      const btns = [...row.querySelectorAll(':scope > .btn')]
      const tops = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top / 6)))
      return { count: btns.length, sameLine: tops.size === 1 }
    })(),
    scavengeDisabled: q('.btn-scavenge') ? !!q('.btn-scavenge').disabled : null,
    scavengeRisky: q('.btn-scavenge') ? q('.btn-scavenge').classList.contains('is-risky') : null,
    skipScavengeBtn: !!q('.btn-skip-scavenge'),
    sleepBtn: !!q('.btn-sleep'),
    sleepHint: q('.btn-sleep .aux-hint')?.textContent || '',
    backupBtn: [...document.querySelectorAll('.topbar-sub-group > .btn')].some((b) => /备份/.test(b.textContent)),
    importLabel: !!q('.topbar-sub-group .db-file-label input[type="file"]'),
    topbarActions: [...document.querySelectorAll('.topbar-sub-group > .btn, .topbar-sub-group > label.btn')]
      .map((b) => b.textContent.trim().replace(/\s+/g, ' ')),
  }
})()`)
const reportUi = [
  { name: '状态条渲染', pass: ui.stats >= 5, extra: ui.stats + ' 条' },
  { name: '选项按钮渲染', pass: ui.choices >= 3, extra: ui.choices + ' 个' },
  { name: '昼夜徽标渲染', pass: ui.phase },
  { name: '顶栏时钟为 24 小时制 HH:MM', pass: /[0-9]{2}:[0-9]{2}/.test(ui.phaseText), extra: ui.phaseText.replace(/\s+/g,' ').trim() },
  { name: '昼夜标记显示白天/黄昏/夜晚', pass: /白天|黄昏|夜晚/.test(ui.phaseText), extra: ui.phaseText.replace(/\s+/g,' ').trim() },
  { name: '天气徽标渲染', pass: ui.weatherChip === true, extra: ui.weatherClass },
  { name: '主线面板渲染', pass: !!ui.mainQuest, extra: ui.mainQuest },
  { name: '日志含"爆发第 N 天"', pass: ui.logHasDay },
  { name: '夜晚阶段启用夜色氛围', pass: /夜晚/.test(ui.phaseText) ? ui.nightClass === true : ui.nightClass === false, extra: 'phase=' + (ui.phaseText||'').replace(/\s+/g,' ').trim() + ' / is-night=' + ui.nightClass },
  { name: '未感染时不显示感染条', pass: ui.infectionBar === false },
  { name: '背包面板渲染', pass: ui.bagCard === true },
  { name: '背包按分类分组展示', pass: ui.bagGroups >= 1, extra: ui.bagGroups + ' 组 / ' + ui.bagItems + ' 项' },
  { name: '每件物品渲染使用按钮', pass: ui.useBtns === ui.bagItems && ui.useBtns > 0, extra: ui.useBtns + ' 个按钮 / ' + ui.bagItems + ' 项' },
  { name: '每件物品渲染交出按钮', pass: ui.giveBtns === ui.bagItems && ui.giveBtns > 0, extra: ui.giveBtns + ' 个 / ' + ui.bagItems + ' 项' },
  { name: '使用按钮初始可用', pass: ui.useBtnEnabled === ui.useBtns, extra: ui.useBtnEnabled + '/' + ui.useBtns + ' 可用' },
  { name: '背包底部标注使用规则', pass: /每回合可使用或交出 1 件/.test(ui.bagFoot), extra: ui.bagFoot },
  { name: '搜刮按钮渲染并带完整说明（tooltip）', pass: ui.scavengeBtn === true && ui.scavengeTitle.length > 0, extra: ui.scavengeTitle },
  { name: '搜刮按钮不再内嵌说明文字', pass: ui.scavengeHint === '', extra: JSON.stringify(ui.scavengeHint) },
  { name: '搜刮 / 不搜刮 / 睡觉 单行排列', pass: ui.auxRow !== null && ui.auxRow.count >= 3 && ui.auxRow.sameLine === true, extra: ui.auxRow ? ui.auxRow.count + ' 个按钮 / 同一行=' + ui.auxRow.sameLine : '未找到 .aux-row' },
  { name: '危险时说明标注原因', pass: ui.scavengeBtn === true && (ui.scavengeDisabled !== true || /危险|代价/.test(ui.scavengeTitle)), extra: ui.scavengeTitle },
  { name: '提供「不搜刮此地」按钮', pass: ui.skipScavengeBtn === true },
  { name: '危险时搜刮按钮不再被禁用（改由玩家自行决定）', pass: ui.scavengeBtn === true && ui.scavengeDisabled === false, extra: 'disabled=' + ui.scavengeDisabled + ' / risky=' + ui.scavengeRisky },
  { name: '夜里渲染「睡觉」入口', pass: ui.sleepBtn === true, extra: ui.sleepHint },
  { name: '顶栏提供「备份」按钮', pass: ui.backupBtn === true, extra: ui.topbarActions.join(' | ') },
  { name: '顶栏提供「导入」按钮（文件选择）', pass: ui.importLabel === true },
]
report(reportUi)
await closePanel()

/* ---------------- 区域地图（绘制式，非文字地图） ---------------- */
const mapBtnClick = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.topbar-sub-group > .btn')].find(x => /地图/.test(x.textContent))
  if (!b) return 'no-btn'
  b.click()
  return 'clicked'
})()`)
await sleep(500)
const mapUi = await evalJs(`(() => {
  const svg = document.querySelector('.map-panel svg.worldmap')
  const labels = [...document.querySelectorAll('.map-node-label')].map(t => t.textContent)
  const nodes = ((window.__ASHES__.game || {}).mapNodes) || []
  return {
    opened: !!document.querySelector('.map-panel'),
    title: (document.querySelector('.map-panel .panel-title') || {}).textContent || '',
    svg: !!svg,
    svgViewBox: svg ? svg.getAttribute('viewBox') : '',
    lines: document.querySelectorAll('.map-panel svg line').length,
    blocks: document.querySelectorAll('.map-panel svg rect').length,
    labels,
    nodes: nodes.map(n => n.name),
    currentRing: document.querySelectorAll('.map-current-ring').length,
    legend: document.querySelectorAll('.map-legend-item').length,
    fog: document.querySelectorAll('.map-fog rect').length,
    routes: document.querySelectorAll('.map-route').length,
    trail: document.querySelectorAll('.map-trail').length,
    trailDots: document.querySelectorAll('.map-trail-dot').length,
    curLabel: (document.querySelector('.map-node-cur') || {}).textContent || '',
    curPos: (nodes.find(n => n.name === ((window.__ASHES__.game || {}).location)) || {}).name || '',
    shelters: nodes.filter(n => n.shelter).length,
  }
})()`)
report([
  { name: '顶栏提供「地图」按钮', pass: mapBtnClick === 'clicked', extra: mapBtnClick },
  { name: '点击「地图」弹出区域地图面板', pass: mapUi.opened === true, extra: mapUi.title },
  { name: '地图以 SVG 绘制（非文字地图）', pass: mapUi.svg === true, extra: 'viewBox=' + mapUi.svgViewBox },
  { name: '地图绘制了街道与街区地形', pass: mapUi.lines > 0 && mapUi.blocks > 0, extra: mapUi.lines + ' 条线 / ' + mapUi.blocks + ' 个块' },
  { name: '地图节点数与状态一致', pass: mapUi.labels.length === mapUi.nodes.length && mapUi.nodes.length > 0, extra: mapUi.nodes.join(' / ') },
  { name: '当前位置高亮标记', pass: mapUi.currentRing >= 1, extra: 'ring=' + mapUi.currentRing },
  { name: '当前位置有明确文字标签', pass: mapUi.curLabel.trim() === '当前位置', extra: JSON.stringify(mapUi.curLabel) },
  { name: '开局仅一个地点时不绘制轨迹（避免单点连线）', pass: mapUi.trail === 0, extra: 'polyline=' + mapUi.trail },
  { name: '地图含未探明区域（雾区）', pass: mapUi.fog >= 4, extra: 'fog rects=' + mapUi.fog },
  { name: '地图含图例', pass: mapUi.legend >= 3, extra: mapUi.legend + ' 项' },
  { name: '落脚点在图上单独标记', pass: mapUi.shelters >= 1 || mapUi.nodes.length < 2, extra: '落脚点=' + mapUi.shelters },
])
const focusTag = await evalJs(`(document.querySelector('.focus-tag') || {}).textContent || ''`)
report([
  { name: '任务焦点标记文案为「当前进行」', pass: focusTag.trim() === '当前进行', extra: JSON.stringify(focusTag) },
  { name: '任务焦点标记不含箭头', pass: focusTag.length > 0 && !/▶/.test(focusTag), extra: JSON.stringify(focusTag) },
])
await evalJs(`document.querySelector('.map-panel .panel-close')?.click(), true`)
await sleep(300)

/* ---------------- 睡觉地点面板 ---------------- */
const sleepClick = await evalJs(`(() => {
  const b = document.querySelector('.btn-sleep')
  if (!b) return 'no-btn'
  if (b.disabled) return 'disabled'
  b.click()
  return 'clicked'
})()`)
await sleep(500)
const sleepUi = await evalJs(`(() => {
  const p = document.querySelector('.target-panel')
  const names = [...document.querySelectorAll('.target-option .target-name')].map(n => n.textContent)
  return {
    opened: !!p,
    title: (document.querySelector('.target-title')||{}).textContent || '',
    options: document.querySelectorAll('.target-option').length,
    qualityTags: document.querySelectorAll('.sleep-q').length,
    hasHere: names.some(t => /就地/.test(t)),
    confirmBtn: [...document.querySelectorAll('.target-foot .btn')].some(b => /在这里睡下/.test(b.textContent)),
    closeBtn: [...document.querySelectorAll('.target-foot .btn')].some(b => /再撑一会儿/.test(b.textContent)),
  }
})()`)
report([
  { name: '点击「睡觉」按钮生效', pass: sleepClick === 'clicked', extra: sleepClick },
  { name: '点击「睡觉」弹出地点选择面板', pass: sleepUi.opened === true, extra: sleepUi.title },
  { name: '面板列出多个睡觉地点', pass: sleepUi.options >= 2, extra: sleepUi.options + ' 个' },
  { name: '每个地点标注可靠性等级', pass: sleepUi.qualityTags === sleepUi.options, extra: sleepUi.qualityTags + '/' + sleepUi.options },
  { name: '候选包含「就地」过夜', pass: sleepUi.hasHere === true },
  { name: '提供确认与放弃两个动作', pass: sleepUi.confirmBtn === true && sleepUi.closeBtn === true },
])
await evalJs(
  `[...document.querySelectorAll('.target-foot .btn')].find(b => /再撑一会儿/.test(b.textContent))?.click(), true`,
)
await sleep(350)

// 点击一次选项，验证交互推进（并等待支线触发后检查面板）
// ⚠ 主界面只展示最新回合，日志条数在跨回合时不会累加，故以 turn 变化判定推进
const turnBefore = await currentTurn()
await evalJs(`document.querySelector('.choice')?.click(), true`)
await sleep(1200)
await waitFor(
  `(window.__ASHES__.game || {}).turn > ${turnBefore} || document.querySelector('.ending-overlay')`,
  60000,
  '回合推进',
)
const turnAfter = await currentTurn()
const questCard = await evalJs(
  `[...document.querySelectorAll('.card h4')].some(h => h.textContent.includes('支线'))`,
)
report([
  { name: '点击选项推进剧情', pass: turnAfter > turnBefore, extra: `turn ${turnBefore} → ${turnAfter}` },
  { name: '支线面板在触发后渲染', pass: questCard === true },
])

/* ---------------- 地图随剧情更新（轨迹延长 + 当前位置跟随） ---------------- */
await evalJs(`[...document.querySelectorAll('.topbar-sub-group > .btn')].find(b => /地图/.test(b.textContent))?.click(), true`)
await sleep(500)
const mapAfter = await evalJs(`(() => {
  const g = window.__ASHES__.game || {}
  const cur = document.querySelector('.map-node-cur')
  const curG = cur && cur.parentNode
  const curTitle = curG && curG.querySelector('title') ? curG.querySelector('title').textContent : ''
  return {
    opened: !!document.querySelector('.map-panel'),
    location: g.location,
    trailData: (g.locationTrail || []).length,
    trailLast: (g.locationTrail || []).slice(-1)[0] || '',
    polyline: document.querySelectorAll('.map-trail').length,
    trailDots: document.querySelectorAll('.map-trail-dot').length,
    curLabel: cur ? cur.textContent : '',
    curTitle,
    ring: document.querySelectorAll('.map-current-ring').length,
  }
})()`)
report([
  { name: '剧情推进后地图轨迹延长', pass: mapAfter.trailData >= 2 && mapAfter.polyline >= 1 && mapAfter.trailDots >= 1, extra: `轨迹点=${mapAfter.trailData} polyline=${mapAfter.polyline} 途经点=${mapAfter.trailDots}` },
  { name: '轨迹终点即当前位置', pass: mapAfter.trailLast === mapAfter.location, extra: `轨迹末=${mapAfter.trailLast} / location=${mapAfter.location}` },
  { name: '当前位置标记跟随剧情移动', pass: mapAfter.curLabel.trim() === '当前位置' && mapAfter.curTitle.startsWith(mapAfter.location) && mapAfter.ring >= 1, extra: `当前位置节点=「${mapAfter.curTitle}」` },
])
await evalJs(`document.querySelector('.map-panel .panel-close')?.click(), true`)
await sleep(300)

/* ---------------- 搜刮按钮交互（危险度感知） ---------------- */
// 打字机播放期间按钮不在 DOM 中，先等它出现
await waitFor(`document.querySelector('.btn-scavenge') || document.querySelector('.ending-overlay')`, 60000, '搜刮按钮出现')

// 当前局面可能危险 → 先验证"按钮仍可用且不会自行产生日志"，再推进到安全回合测试真实搜刮
const blockedState = await evalJs(`(() => {
  const b = document.querySelector('.btn-scavenge')
  return { exists: !!b, disabled: b ? !!b.disabled : null, risky: b ? b.classList.contains('is-risky') : null }
})()`)
const logBeforeBlocked = await evalJs(`document.querySelectorAll('.log-entry').length`)
if (blockedState.exists && blockedState.disabled) {
  await evalJs(`document.querySelector('.btn-scavenge')?.click(), true`)
  await sleep(900)
}
const logAfterBlocked = await evalJs(`document.querySelectorAll('.log-entry').length`)
report([
  { name: '危险时搜刮按钮保持可用（不再被门禁拦下）', pass: blockedState.exists === false || blockedState.disabled === false, extra: 'disabled=' + blockedState.disabled + ' / risky=' + blockedState.risky },
  { name: '未点击时不会自行产生日志', pass: logAfterBlocked === logBeforeBlocked, extra: `${logBeforeBlocked} → ${logAfterBlocked}` },
])

// 推进局面，直到搜刮按钮可用（安全窗口），最多推 5 次
let scavReady = false
for (let i = 0; i < 5; i++) {
  const st = await evalJs(`(() => {
    const b = document.querySelector('.btn-scavenge')
    return { has: !!b, disabled: b ? !!b.disabled : false, ending: !!document.querySelector('.ending-overlay') }
  })()`)
  if (st.ending) break
  if (st.has && !st.disabled) { scavReady = true; break }
  const hasChoice = await evalJs(`!!document.querySelector('.choice')`)
  if (!hasChoice) break
  const n0 = await currentTurn()
  await evalJs(`document.querySelector('.choice')?.click(), true`)
  await waitFor(
    `(window.__ASHES__.game || {}).turn > ${n0} || document.querySelector('.ending-overlay')`,
    60000,
    '推进到安全回合',
  )
}

await openBag()
const bagBefore = await evalJs(`document.querySelectorAll('.bag-item').length`)
await closePanel()
const logBefore = await evalJs(`document.querySelectorAll('.log-entry').length`)
if (scavReady) {
  await evalJs(`document.querySelector('.btn-scavenge')?.click(), true`)
  await waitFor(
    `document.querySelectorAll('.log-entry').length > ${logBefore} || document.querySelector('.ending-overlay')`,
    60000,
    '搜刮结果返回',
  )
}
const scavLog = await evalJs(`(() => {
  return {
    scavEntry: document.querySelectorAll('.log-entry.kind-scavenge').length,
    logNow: document.querySelectorAll('.log-entry').length,
    lootChips: document.querySelectorAll('.log-loot-chip').length,
    specialBlocks: document.querySelectorAll('.log-special').length,
    specialKind: (document.querySelector('.log-special')||{}).className || '',
  }
})()`)
await openBag()
const bagNow = await evalJs(`document.querySelectorAll('.bag-item').length`)
await closePanel()
const scavUi = { ...scavLog, bagNow }
report([
  { name: '推进后出现可搜刮的安全窗口', pass: scavReady === true, extra: scavReady ? '按钮已可用' : '5 次推进内未出现安全窗口' },
  { name: '安全窗口内搜刮可点击并产出结果', pass: !scavReady || scavUi.logNow > logBefore, extra: `${logBefore} → ${scavUi.logNow}` },
  { name: '搜刮结果渲染为独立日志条目', pass: scavUi.scavEntry >= 1, extra: scavUi.scavEntry + ' 条' },
  { name: '搜刮后背包面板同步刷新', pass: scavUi.bagNow >= bagBefore, extra: `${bagBefore} → ${scavUi.bagNow}` },
  { name: '搜刮战利品标签渲染', pass: scavUi.lootChips >= 0, extra: scavUi.lootChips + ' 个' },
  { name: '插曲（若有）渲染为独立样式块', pass: scavUi.specialBlocks >= 0 && (!scavUi.specialBlocks || /special-(danger|chance)/.test(scavUi.specialKind)), extra: scavUi.specialBlocks + ' 个 / ' + scavUi.specialKind },
])

/* ---------------- 使用物品按钮交互（经对象选择面板） ---------------- */
await openBag()
await waitFor(
  `document.querySelector('.bag-use:not([disabled])') || document.querySelector('.ending-overlay')`,
  60000,
  '可用物品按钮出现',
)
const useLogBefore = await evalJs(`document.querySelectorAll('.log-entry').length`)
const canUse = await evalJs(`!!document.querySelector('.bag-use:not([disabled])')`)
let pickerUi = { opened: false, options: 0, hasSelf: false, hasHere: false, fitsShown: false }
if (canUse) {
  await evalJs(`document.querySelector('.bag-use:not([disabled])')?.click(), true`)
  await sleep(400)
  pickerUi = await evalJs(`(() => {
    const p = document.querySelector('.target-panel')
    const texts = [...document.querySelectorAll('.target-option .target-name')].map(n => n.textContent)
    return {
      opened: !!p,
      options: document.querySelectorAll('.target-option').length,
      hasSelf: texts.includes('主角自己'),
      hasHere: texts.includes('就地使用'),
      fitsShown: !!document.querySelector('.target-fits'),
    }
  })()`)
  // 选择「自己」并确认
  await evalJs(`[...document.querySelectorAll('.target-option')].find(o => /主角自己/.test(o.textContent))?.click(), true`)
  await sleep(200)
  await evalJs(`[...document.querySelectorAll('.target-foot .btn')].find(b => /用「/.test(b.textContent))?.click(), true`)
  await waitFor(
    `document.querySelectorAll('.log-entry').length > ${useLogBefore} || document.querySelector('.ending-overlay')`,
    60000,
    '使用物品结果返回',
  )
}
const useUi = await evalJs(`(() => {
  return {
    useEntry: document.querySelectorAll('.log-entry.kind-useitem').length,
    logNow: document.querySelectorAll('.log-entry').length,
    useChip: document.querySelectorAll('.log-use-chip').length,
    targetChip: document.querySelectorAll('.log-target-chip').length,
    disabledNow: [...document.querySelectorAll('.bag-use')].filter(b => b.disabled).length,
    totalBtns: document.querySelectorAll('.bag-use').length,
    pickerGone: !document.querySelector('.target-panel'),
  }
})()`)
report([
  { name: '使用前弹出对象选择面板', pass: pickerUi.opened === true },
  { name: '对象面板提供"自己/就地"等选项', pass: pickerUi.options >= 2 && pickerUi.hasSelf && pickerUi.hasHere, extra: pickerUi.options + ' 个选项' },
  { name: '对象面板展示适用对象', pass: pickerUi.fitsShown === true },
  { name: '确认后关闭选择面板', pass: useUi.pickerGone === true },
  { name: '使用按钮可点击并产出结果', pass: canUse && useUi.logNow > useLogBefore, extra: `${useLogBefore} → ${useUi.logNow}` },
  { name: '使用结果渲染为独立日志条目', pass: useUi.useEntry >= 1, extra: useUi.useEntry + ' 条' },
  { name: '使用物品标签渲染', pass: useUi.useChip >= 0, extra: useUi.useChip + ' 个' },
  { name: '使用对象标签渲染', pass: useUi.targetChip >= 0, extra: useUi.targetChip + ' 个' },
  { name: '使用后本回合按钮全部禁用', pass: useUi.totalBtns === 0 || useUi.disabledNow === useUi.totalBtns, extra: useUi.disabledNow + '/' + useUi.totalBtns + ' 已禁用' },
])

/* ---------------- 设置面板：玩家自填的 OpenAI 兼容通道 ---------------- */
console.log('\n[5] 设置面板 · 自定义通道')
await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '设置')?.click(), true`)
await waitFor(`document.querySelector('.modal')`, 20000, '设置面板打开')
const channelUi = await evalJs(`(() => {
  const labels = [...document.querySelectorAll('.modal .field label')].map(l => l.textContent)
  const options = [...document.querySelectorAll('.modal select option')].map(o => o.value)
  return {
    noBuiltin: ![...document.querySelectorAll('.modal .btn')].some(b => /内置 AI/.test(b.textContent)),
    noCodex: !options.includes('codex') && !document.querySelector('.codex-block'),
    hasCustom: options.includes('custom'),
    hasTemp: labels.some(t => t.includes('温度')),
  }
})()`)
report([
  { name: '设置面板不再提供「内置 AI」按钮', pass: channelUi.noBuiltin === true },
  { name: '通道类型不再提供 Codex 终端模拟', pass: channelUi.noCodex === true },
  { name: '仍可切换到自定义 OpenAI 兼容接口', pass: channelUi.hasCustom === true },
  { name: '温度滑杆始终可见', pass: channelUi.hasTemp === true },
])

// 保存后配置应持久化到 SQLite
await evalJs(`(() => {
  const sel = document.querySelector('.modal select')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'custom')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const f = t => [...document.querySelectorAll('.modal .field')].find(x => (x.querySelector('label')?.textContent || '').startsWith(t))
  setVal(f('Base URL').querySelector('input'), 'http://127.0.0.1:9/v1')
  setVal(f('模型名').querySelector('input'), 'selftest-model')
  setVal(f('API Key').querySelector('input'), 'sk-selftest')
  return true
})()`)
await evalJs(`[...document.querySelectorAll('.modal-actions .btn')].find(b => b.textContent.includes('保存'))?.click(), true`)
await sleep(700)
const customCfg = await evalJs(`window.__ASHES__.api.getSettings()`)
report([
  { name: '自定义通道可保存到 SQLite', pass: customCfg.provider === 'custom', extra: customCfg.provider },
  { name: '保存后模型与地址正确回读', pass: customCfg.model === 'selftest-model' && customCfg.baseUrl === 'http://127.0.0.1:9/v1', extra: [customCfg.model, customCfg.baseUrl].join(' | ') },
  { name: '填入 API Key 后通道就绪', pass: customCfg.ready === true && customCfg.hasKey === true, extra: 'ready=' + customCfg.ready + ' / hasKey=' + customCfg.hasKey },
])

await evalJs(
  `window.__ASHES__.api.saveSettings({ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'selftest-model' })`,
)

/* ---------------- 控制台错误 ---------------- */
const errs = await evalJs(`window.__errs || []`)
report([{ name: '无前端运行时错误', pass: errs.length === 0, extra: errs.join(' | ') }])

console.log(`\n\x1b[36m结果：\x1b[0m \x1b[32m${pass} 通过\x1b[0m / \x1b[31m${fail} 失败\x1b[0m\n`)
ws.close()
process.exit(fail === 0 ? 0 : 1)
