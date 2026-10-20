/**
 * 仓储层：游戏存档 + 应用配置，全部落在 SQLite 里。
 * ------------------------------------------------------------------
 * 表：
 *   sessions     一行一局（标量字段 + 固定形状的 JSON 字段）
 *   log_entries  一行一段叙事（长文本，增量写入）
 *   entities     背包 / 状态 / 同行者 / 剧情标记 / 变异株 / 支线（多值集合）
 *   settings     键值配置（含 API Key）
 */
import { run, get, all, flush } from './sqlite.js'

/* ============================ 配置 ============================ */

const DEFAULTS = {
  // openai（预设）| custom（自定义 OpenAI 兼容）；mock 仅保留给自检脚本，界面已停用
  // 不再预置任何网关、模型或 API Key——首次启动必须由玩家自己填写
  provider: 'openai',
  customName: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 1.05,
  maxTokens: 2400,
  timeoutMs: 90000,
  // 跨域中转：'builtin' 启用公共中转（corsfix，默认） | 'off' 直连 | 'custom' 自定义前缀
  // ⚠ 启用后请求（含 Authorization 头 / API Key）会经过第三方服务器，存在泄露风险。
  corsProxy: 'builtin',
  corsProxyCustom: '', // corsProxy === 'custom' 时使用的自定义中转前缀
}

function readSettings() {
  const out = {}
  for (const row of all('SELECT key, value FROM settings')) {
    try {
      out[row.key] = JSON.parse(row.value)
    } catch {
      out[row.key] = row.value
    }
  }
  return out
}

/** 完整配置（含明文 apiKey，仅在内存与 SQLite 中使用） */
export function getConfig() {
  const cfg = { ...DEFAULTS, ...readSettings() }
  cfg.temperature = Number(cfg.temperature) || DEFAULTS.temperature
  cfg.maxTokens = Number(cfg.maxTokens) || DEFAULTS.maxTokens
  cfg.timeoutMs = Number(cfg.timeoutMs) || DEFAULTS.timeoutMs
  cfg.baseUrl = String(cfg.baseUrl || '').trim().replace(/\/+$/, '')
  cfg.model = String(cfg.model || '').trim()
  cfg.apiKey = String(cfg.apiKey || '')
  cfg.customName = String(cfg.customName || '').trim()
  cfg.corsProxy = String(cfg.corsProxy || '').trim()
  cfg.corsProxyCustom = String(cfg.corsProxyCustom || '').trim()
  // 历史配置若停在已删除的通道（codex / 内置 AI），回落到需要玩家重新填写的 openai
  if (cfg.provider !== 'openai' && cfg.provider !== 'custom' && cfg.provider !== 'mock') cfg.provider = 'openai'
  return cfg
}

export function isReady(cfg = getConfig()) {
  // 离线体验（mock）已停用：不再视为就绪，没有可用的 AI 模型就不能开始游戏
  return Boolean(cfg.apiKey) && Boolean(cfg.baseUrl) && Boolean(cfg.model)
}

/** 脱敏后的配置，可安全用于界面展示 */
export function getPublicConfig() {
  const cfg = getConfig()
  const out = {
    provider: cfg.provider,
    customName: cfg.customName,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    hasKey: Boolean(cfg.apiKey),
    corsProxy: cfg.corsProxy,
    corsProxyCustom: cfg.corsProxyCustom,
    ready: isReady(cfg),
  }
  return out
}

/** 保存配置；apiKey 为空字符串表示「不修改现有 Key」 */
export function saveConfig(patch = {}) {
  const next = {}
  if (patch.provider !== undefined) next.provider = String(patch.provider)
  if (patch.customName !== undefined) next.customName = String(patch.customName).trim().slice(0, 30)
  if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl).trim().replace(/\/+$/, '')
  if (patch.model !== undefined) next.model = String(patch.model).trim()
  if (patch.temperature !== undefined) next.temperature = Number(patch.temperature)
  if (patch.maxTokens !== undefined) next.maxTokens = Number(patch.maxTokens)
  if (patch.corsProxy !== undefined) next.corsProxy = String(patch.corsProxy).trim()
  if (patch.corsProxyCustom !== undefined) next.corsProxyCustom = String(patch.corsProxyCustom).trim()
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') next.apiKey = patch.apiKey.trim()
  if (patch.clearApiKey === true) next.apiKey = ''

  for (const [k, v] of Object.entries(next)) {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      k,
      JSON.stringify(v),
    ])
  }
  return getPublicConfig()
}

/* ============================ 存档 ============================ */

const parse = (s, fallback = null) => {
  if (s === null || s === undefined || s === '') return fallback
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

/**
 * 保存一局。日志按增量写入（只补新增的段落），其余集合整体替换。
 */
export function saveSession(state) {
  run(
    `INSERT INTO sessions
       (id, created_at, updated_at, turn, day, minute, weather, location, over, memory,
        protagonist, stats, main_quest, ending, last_event,
        scavenge_count, scavenge_spot, scavenge_spot_count, scavenge_cap, scavenge_skip_spot,
        scavenge_safe, unsafe_reason, used_this_turn, use_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       updated_at     = excluded.updated_at,
       turn           = excluded.turn,
       day            = excluded.day,
       minute         = excluded.minute,
       weather        = excluded.weather,
       location       = excluded.location,
       over           = excluded.over,
       memory         = excluded.memory,
       protagonist    = excluded.protagonist,
       stats          = excluded.stats,
       main_quest     = excluded.main_quest,
       ending         = excluded.ending,
       last_event     = excluded.last_event,
       scavenge_count      = excluded.scavenge_count,
       scavenge_spot       = excluded.scavenge_spot,
       scavenge_spot_count = excluded.scavenge_spot_count,
       scavenge_cap        = excluded.scavenge_cap,
       scavenge_skip_spot  = excluded.scavenge_skip_spot,
       scavenge_safe       = excluded.scavenge_safe,
       unsafe_reason       = excluded.unsafe_reason,
       used_this_turn      = excluded.used_this_turn,
       use_count           = excluded.use_count`,
    [
      state.id,
      state.createdAt,
      state.updatedAt,
      state.turn,
      state.day,
      state.minute == null ? 360 : state.minute,
      state.weather ? JSON.stringify(state.weather) : null,
      state.location || '',
      state.over ? 1 : 0,
      state.memory || '',
      JSON.stringify(state.protagonist || null),
      JSON.stringify(state.stats || {}),
      state.mainQuest ? JSON.stringify(state.mainQuest) : null,
      state.ending ? JSON.stringify(state.ending) : null,
      state.lastEvent ? JSON.stringify(state.lastEvent) : null,
      state.scavengeCount || 0,
      state.scavengeSpot || null,
      state.scavengeSpotCount || 0,
      state.scavengeCap == null ? 3 : state.scavengeCap,
      state.scavengeSkipSpot || null,
      state.scavengeSafe == null ? null : state.scavengeSafe ? 1 : 0,
      state.unsafeReason || null,
      state.usedThisTurn || null,
      state.useCount || 0,
    ],
  )

  // 叙事日志：增量补齐
  const log = state.log || []
  const stored = get('SELECT COUNT(*) AS c FROM log_entries WHERE session_id = ?', [state.id])?.c || 0
  if (stored > log.length) run('DELETE FROM log_entries WHERE session_id = ?', [state.id])
  for (let i = stored > log.length ? 0 : stored; i < log.length; i++) {
    const e = log[i]
    run(
      'INSERT INTO log_entries (session_id, turn, kind, text, chosen, day, time, loot, used, target, special, weather) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        state.id,
        e.turn ?? 0,
        e.kind ?? 'event',
        e.text ?? '',
        e.chosen ?? null,
        e.day ?? null,
        e.time ?? null,
        e.loot && e.loot.length ? JSON.stringify(e.loot) : null,
        e.used ?? null,
        e.target ?? null,
        e.special ? JSON.stringify({ kind: e.special, title: e.specialTitle || '' }) : null,
        e.weather ?? null,
      ],
    )
  }

  // 集合类数据：整体替换
  run('DELETE FROM entities WHERE session_id = ?', [state.id])
  const push = (kind, name, data, ord) =>
    run('INSERT INTO entities (session_id, kind, name, data, ord) VALUES (?,?,?,?,?)', [
      state.id,
      kind,
      String(name),
      JSON.stringify(data || {}),
      ord,
    ])

  ;(state.inventory || []).forEach((it, i) =>
    push(
      'inventory',
      it.name,
      { category: it.category, qty: it.qty, note: it.note, fits: it.fits, tradable: it.tradable === true },
      i,
    ),
  )
  ;(state.conditions || []).forEach((c, i) => push('condition', c, {}, i))
  ;(state.allies || []).forEach((a, i) => push('ally', a.name, { status: a.status, note: a.note }, i))
  ;(state.flags || []).forEach((f, i) => push('flag', f, {}, i))
  ;(state.mutations || []).forEach((m, i) => push('mutation', m.name, { traits: m.traits, note: m.note }, i))
  ;(state.shelters || []).forEach((s, i) =>
    push('shelter', s.name, { quality: s.quality, note: s.note, day: s.day }, i),
  )
  ;(state.timeline || []).forEach((t, i) => push('timeline', t, {}, i))
  ;(state.sideQuests || []).forEach((q, i) =>
    push('sidequest', q.title, { id: q.id, hook: q.hook, giver: q.giver, status: q.status, note: q.note, day: q.day }, i),
  )

  // 区域地图：每个已探明地点一行（坐标是引擎分配的稳定槽位，界面据此绘制地图）
  ;(state.mapNodes || []).forEach((n, i) =>
    push('mapnode', n.name, { type: n.type, x: n.x, y: n.y, shelter: !!n.shelter, day: n.day, visits: n.visits || 0 }, i),
  )

  // 行进轨迹：按到访顺序存成一行行地点名（ord 即顺序），地图据此画出路线
  ;(state.locationTrail || []).forEach((t, i) => push('trail', String(t), {}, i))

  // 任务链：已完成的主线归档 + 当前焦点 / 主线序号 / 待派生支线标记
  ;(state.mainQuestHistory || []).forEach((h, i) =>
    push('mainquest', h.title, { stage: h.stage, note: h.note, day: h.day, outcome: h.outcome }, i),
  )
  push('meta', 'questFocus', state.questFocus || { type: 'main', title: '', sinceTurn: 0 }, 0)
  push('meta', 'mainQuestSeq', { v: state.mainQuestSeq || 1 }, 1)
  push('meta', 'spin', { on: !!state.spinSideFromMain, since: state.spinSinceTurn || 0 }, 2)
}

/** 从 SQLite 还原一局完整状态 */
export function loadSession(id) {
  const row = get('SELECT * FROM sessions WHERE id = ?', [id])
  if (!row) return null

  const ents = all('SELECT kind, name, data FROM entities WHERE session_id = ? ORDER BY kind, ord', [id])
  const byKind = {}
  for (const e of ents) (byKind[e.kind] ||= []).push(e)
  const bag = (kind) => (byKind[kind] || []).map((e) => ({ name: e.name, ...parse(e.data, {}) }))

  // 任务链的标量字段以 meta 行的形式存放（无需为新增字段改表结构）
  const metaBag = bag('meta')
  const meta = (k) => metaBag.find((m) => m.name === k) || null
  const qf = meta('questFocus')
  const seqRow = meta('mainQuestSeq')
  const spinRow = meta('spin')

  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turn: row.turn,
    day: row.day,
    minute: row.minute == null ? 360 : row.minute,
    weather: parse(row.weather, null),
    location: row.location,
    over: Boolean(row.over),
    memory: row.memory || '',
    protagonist: parse(row.protagonist, null),
    stats: parse(row.stats, {}),
    mainQuest: parse(row.main_quest, null),
    ending: parse(row.ending, null),
    lastEvent: parse(row.last_event, null),
    scavengeCount: row.scavenge_count || 0,
    scavengeSpot: row.scavenge_spot || null,
    scavengeSpotCount: row.scavenge_spot_count || 0,
    scavengeCap: row.scavenge_cap == null ? 3 : row.scavenge_cap,
    scavengeSkipSpot: row.scavenge_skip_spot || null,
    scavengeSafe: row.scavenge_safe == null ? null : Boolean(row.scavenge_safe),
    unsafeReason: row.unsafe_reason || '',
    usedThisTurn: row.used_this_turn || null,
    useCount: row.use_count || 0,
    log: all(
      'SELECT turn, kind, text, chosen, day, time, loot, used, target, special, weather FROM log_entries WHERE session_id = ? ORDER BY id',
      [id],
    ).map((e) => {
      const sp = parse(e.special, null)
      return {
        ...e,
        loot: parse(e.loot, null) || undefined,
        special: sp?.kind ? sp.kind : undefined,
        specialTitle: sp?.title || undefined,
      }
    }),
    inventory: bag('inventory'),
    conditions: bag('condition').map((x) => x.name),
    allies: bag('ally'),
    flags: bag('flag').map((x) => x.name),
    mutations: bag('mutation'),
    shelters: bag('shelter'),
    timeline: bag('timeline').map((x) => x.name),
    sideQuests: bag('sidequest').map((x) => ({ ...x, title: x.name })),
    // 区域地图（引擎分配的稳定坐标）
    mapNodes: bag('mapnode').map((x) => ({
      name: x.name,
      type: x.type || 'other',
      x: Number(x.x) || 320,
      y: Number(x.y) || 210,
      shelter: !!x.shelter,
      day: x.day,
      visits: x.visits || 0,
    })),
    // 行进轨迹：按到访顺序还原（ord 即顺序）
    locationTrail: bag('trail').map((x) => x.name),
    // 任务链：已完成的主线归档 + 当前焦点 / 主线序号 / 待派生支线标记
    mainQuestHistory: bag('mainquest').map((x) => ({
      title: x.name,
      stage: x.stage || '',
      note: x.note || '',
      day: x.day,
      outcome: x.outcome || 'done',
    })),
    questFocus: qf
      ? { type: qf.type === 'side' ? 'side' : 'main', title: qf.title || '', sinceTurn: qf.sinceTurn || 0 }
      : { type: 'main', title: '', sinceTurn: 0 },
    mainQuestSeq: Number(seqRow?.v) || 1,
    spinSideFromMain: Boolean(spinRow?.on),
    spinSinceTurn: Number(spinRow?.since) || 0,
  }
}

/** 最近更新的一局 */
export function latestSession() {
  const row = get('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1')
  return row ? loadSession(row.id) : null
}

export function deleteSession(id) {
  run('DELETE FROM entities WHERE session_id = ?', [id])
  run('DELETE FROM log_entries WHERE session_id = ?', [id])
  run('DELETE FROM sessions WHERE id = ?', [id])
  flush()
  return true
}

export function countSessions() {
  return get('SELECT COUNT(*) AS c FROM sessions')?.c || 0
}
