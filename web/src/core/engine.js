/**
 * 游戏引擎 · 浏览器端
 * ------------------------------------------------------------------
 * 职责：维护结构化游戏状态、调用世界引擎生成事件、结算数值、推进昼夜、
 *       维护主线/支线、判定结局。状态全部落在 SQLite。
 *
 * 关键点：引擎从不把逐轮对话历史发给模型。每回合只发送
 * 「有界状态快照 + 上一事件 + 玩家选择」，因此 prompt 体积恒定。
 */
import { getConfig, saveSession, loadSession as loadSessionRaw, latestSession, deleteSession } from '../db/store.js'
import { chatJSON } from './llm.js'
import {
  SYSTEM_PROMPT,
  buildOpeningPrompt,
  buildTurnPrompt,
  buildScavengePrompt,
  buildUseItemPrompt,
  buildGiveItemPrompt,
  buildConsumePrompt,
  buildSleepPrompt,
  buildEndingPrompt,
  buildCraftPrompt,
  buildTradePrompt,
  buildUpgradePrompt,
  RECIPES,
  UPGRADE_SLOTS,
  SKILL_DEFS,
  makeSeed,
  rollEventPlan,
  questFocusOf,
  polishChoiceText,
  infectionStage,
  collapseStage,
  MIN_PER_HOUR,
  MIN_PER_DAY,
  DAY_FROM_MIN,
  DUSK_FROM_MIN,
  normMinute,
  formatClock,
  isNightMinute,
  dayPhaseOf,
  timeOfDayPhrase,
  slotFromLabel,
} from './prompt.js'

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'GameError'
    this.status = status
  }
}

const STAT_KEYS = ['hp', 'hunger', 'thirst', 'sanity', 'stamina', 'infection']
const DEFAULT_STATS = { hp: 100, hunger: 20, thirst: 20, sanity: 90, stamina: 100, infection: 0 }
const CHOICE_IDS = ['A', 'B', 'C', 'D', 'E', 'F']

/** 物品分类（背包按此分组展示）。模型给的值不在此列时统一归入「杂物」。 */
export const ITEM_CATEGORIES = ['武器', '食物', '饮水', '药品', '工具', '弹药', '衣物', '杂物']

/** 使用物品时可指定的对象（在同行者之外的两个特殊选项） */
export const TARGET_SELF = '自己'
export const TARGET_HERE = '就地使用'

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)))
const arr = (v) => (!v ? [] : Array.isArray(v) ? v : [v])

/** 归一化物品分类：命中则原样返回，否则归入「杂物」 */
function normCategory(c) {
  const t = String(c || '').trim()
  return ITEM_CATEGORIES.includes(t) ? t : '杂物'
}

/**
 * 把模型给出的物品对象规范化为背包条目。
 * fits / tradable 是「使用对象与方法」的载体：
 *   · fits      适用对象（如「高血压患者」「伤员」「幼儿」「所有人」）——模型据此判定谁用有效、谁用有害
 *   · tradable  是否适合拿去交换（会引来交易、觊觎或骗局）
 * setQty：显式「设定剩余数量」（而非增量）。用于"只用掉一部分"的场景，
 *         允许写 0（表示用尽）——归零的物品由 pruneInventory 统一移除。
 */
function normalizeItem(item) {
  if (!item || !item.name) return null
  const setRaw = item.setQty
  const hasSet = setRaw !== undefined && setRaw !== null && setRaw !== '' && Number.isFinite(Number(setRaw))
  return {
    name: String(item.name).slice(0, 30),
    category: normCategory(item.category),
    qty: Math.max(1, Number(item.qty) || 1),
    setQty: hasSet ? Math.max(0, Math.floor(Number(setRaw))) : undefined,
    note: String(item.note || '').slice(0, 40),
    fits: String(item.fits || '').slice(0, 24),
    tradable: item.tradable === true,
  }
}

/**
 * 背包净化：数量耗尽（qty <= 0）的条目**一律移除**。
 * ------------------------------------------------------------------
 * 收口所有扣减路径（AI 覆盖 qty、useItem / giveItem / 消耗 的引擎兜底），
 * 保证"用到 0 就消失"这条规则永远不会被某条分支漏掉。
 */
function pruneInventory(state) {
  if (!Array.isArray(state.inventory)) return
  state.inventory = state.inventory.filter((it) => it && Number(it.qty) > 0)
}

/**
 * 存档加载统一入口：读盘后立刻净化背包。
 * 历史存档若残留 qty=0（旧版本逻辑遗留），在这里一次性清掉，避免"用完了还占着背包"。
 */
function loadSession(id) {
  const state = loadSessionRaw(id)
  if (state) pruneInventory(state)
  return state
}

/** 兼容不支持 crypto.randomUUID 的环境（如 file:// 下的部分浏览器） */
function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function baseState() {
  return {
    id: uuid(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turn: 0,
    day: 1, // 爆发后天数
    minute: 6 * 60, // 一天内的分钟数（24 小时制，0-1439）；开局 06:00
    weather: null, // 当前天气（见 rollWeather / weatherDrift）
    location: '未知地点',
    protagonist: null,
    mainQuest: null,
    sideQuests: [],
    stats: { ...DEFAULT_STATS },
    inventory: [],
    conditions: [],
    allies: [],
    flags: [],
    mutations: [],
    // 已知的安全落脚点（睡觉地点候选）：{ name, quality(1-3), note, day }
    shelters: [],
    // 区域地图：已探明的地点节点（由引擎在"地点变化 / 落脚点登记"时自动登记）
    // { name, type, x, y, shelter, day, visits } —— 只用于绘制地图，不参与数值结算
    mapNodes: [],
    // 行进轨迹：按剧情推进顺序记录到访地点，地图据此画出路线（随剧情不断延长）
    locationTrail: [],
    // 任务链：当前任务焦点（主线 / 某条支线）——决定下一回合围绕哪条任务线生成随机事件
    questFocus: { type: 'main', title: '', sinceTurn: 0 },
    // 第几条主线（主线完成后递增）+ 已完成的主线归档
    mainQuestSeq: 1,
    mainQuestHistory: [],
    // 主线刚完成并派生新主线 → 下一回合强制从新主线抛出一条支线（任务链闭环的入口）
    spinSideFromMain: false,
    spinSinceTurn: 0,
    memory: '',
    timeline: [],
    log: [],
    lastEvent: null,
    // 搜刮：次数统计 + 同一地点连续搜刮的收益衰减 + 该地点的随机搜刮上限（0-3）
    scavengeCount: 0,
    scavengeSpot: null,
    scavengeSpotCount: 0,
    scavengeCap: 3,
    // 玩家明确放弃搜刮的地点名（"不搜刮此地"）——换地点后自动失效
    scavengeSkipSpot: null,
    // 局势危险度：仅用于界面风险提示与模型代价裁决，**不再作为搜刮门禁**
    scavengeSafe: null,
    unsafeReason: '',
    // 使用物品：每回合限 1 次，记录本回合已使用的物品名
    usedThisTurn: null,
    useCount: 0,
    // 制作：每回合限 1 次（与使用/交出共用 usedThisTurn，避免同一回合连做两件大事）
    craftCount: 0,
    // 交易：现场生成的报价只在成交前有效，成交后清空
    tradeOffer: null,
    tradeCount: 0,
    // 据点升级：每个落脚点的加固件 { [shelterName]: { door, fire, bed, storage } }
    upgrades: {},
    // 技能经验：搜刮 / 战斗 / 制作 / 交涉，各自独立累积
    skills: { scavenge: 0, combat: 0, craft: 0, social: 0 },
    over: false,
    ending: null,
  }
}

/* ------------------------------ 状态结算 ------------------------------ */

/** 安全落脚点：一旦在叙事里确立就长期可用（会成为夜里睡觉的地点候选） */
function applyShelters(state, raw) {
  for (const sh of arr(raw.sheltersAdd)) {
    if (!sh || !sh.name) continue
    const name = String(sh.name).slice(0, 24)
    const quality = Math.max(1, Math.min(3, Math.round(Number(sh.quality) || 1)))
    const exist = state.shelters.find((x) => x.name === name)
    if (exist) {
      exist.quality = quality
      if (sh.note) exist.note = String(sh.note).slice(0, 60)
    } else {
      state.shelters.push({ name, quality, note: String(sh.note || '').slice(0, 60), day: state.day })
    }
    ensureUpgrade(state, name)
  }
  for (const name of arr(raw.sheltersRemove)) {
    const nm = String(name || '')
    state.shelters = state.shelters.filter((x) => x.name !== nm)
    if (state.upgrades && state.upgrades[nm]) delete state.upgrades[nm]
  }
  // 落脚点也是"已探明地点"——登记进区域地图（不额外计一次到访）
  for (const s of state.shelters) placeMapNode(state, s.name, { shelter: true, visit: false })
}

/* ------------------------------ 区域地图 ------------------------------ */

/**
 * 地图节点类型：按地点名里的关键词推断。
 * 只影响界面的图标与配色，不参与任何数值结算——它让"画出来的地图"有可辨识的地貌。
 * 类型的图标/配色由界面层负责（引擎只给出 type 字符串，保持纯数据）。
 */
const NODE_TYPE_RULES = [
  ['hospital', /医院|急诊|门诊|住院|诊所|卫生|药房|药店|血站/],
  ['market', /超市|便利|商场|菜场|市场|商店|小店|铺|卖场/],
  ['police', /警局|派出所|公安|警亭|岗亭|巡逻|警务/],
  ['military', /军营|哨卡|检查站|军车|部队|据点|封锁|指挥/],
  ['school', /学校|大学|中学|小学|幼儿园|校园|图书馆/],
  ['transit', /地铁|车站|火车站|公交|枢纽|高架|隧道|桥|码头/],
  ['fuel', /加油站|油站|加气|油库|充电站/],
  ['factory', /工厂|仓库|车间|工地|物流|厂房|工业/],
  ['office', /公司|办公|写字楼|值班室|机关|档案馆|政府/],
  ['park', /公园|广场|绿地|河|湖|林|山/],
  ['home', /住宅|公寓|小区|出租屋|地下室|居民|楼/],
]

/** 由地点名推断节点类型（未命中归入 other） */
export function nodeTypeOf(name) {
  const n = String(name || '')
  for (const [type, re] of NODE_TYPE_RULES) if (re.test(n)) return type
  return 'other'
}

/**
 * 地图槽位：5×4 网格，按"离中心越近越先占用"排序。
 * 于是新地点会围绕中心一圈圈铺开，形成一张有层次的区域图，而不是随机撒点。
 * 坐标对应地图画布 viewBox 0 0 640 420。
 */
const MAP_SLOT_PAD_X = 76
const MAP_SLOT_PAD_Y = 70
const MAP_SLOT_DX = 112
const MAP_SLOT_DY = 100
const MAP_SLOTS = (() => {
  const pts = []
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) pts.push({ c, r })
  const cc = 2
  const cr = 1.5
  pts.sort((a, b) => Math.abs(a.c - cc) + Math.abs(a.r - cr) - (Math.abs(b.c - cc) + Math.abs(b.r - cr)))
  return pts.map(({ c, r }) => ({ x: MAP_SLOT_PAD_X + c * MAP_SLOT_DX, y: MAP_SLOT_PAD_Y + r * MAP_SLOT_DY }))
})()

/** 名字 → 稳定的坐标抖动：同一地点每次绘制都落在同一处（哈希而非随机） */
function hashJitter(name, amp) {
  let h = 0
  const s = String(name || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return ((h % 1000) / 1000 - 0.5) * 2 * amp
}

/** 地图节点上限：超长局也不让地图无限膨胀 */
const MAP_NODE_CAP = 40

/** 地点名的"末段"（如「城南 · 市立医院 · 住院部」→「住院部」） */
function placeTail(s) {
  const segs = String(s || '').split(/[·・/|>→]/).map((t) => t.trim()).filter(Boolean)
  return segs.length > 1 ? segs[segs.length - 1] : String(s || '').trim()
}

/**
 * 判断两个地点名是否指同一个地方。
 * ------------------------------------------------------------------
 * 模型对同一地点常有不同写法（「城南 · 临街便利店」/「临街便利店」）。
 * 若不识别，地图会长出一堆几乎同名的节点，"当前位置"也会在它们之间乱跳。
 * 只做**保守**判定，宁可新建也不误合并：
 *   · 末段完全相同且 ≥4 字（避免「医院」这类短词误合并）；
 *   · 或一方完整包含另一方且较短者 ≥5 字。
 */
function samePlace(a, b) {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  if (!x || !y) return false
  if (x === y) return true
  const tx = placeTail(x)
  const ty = placeTail(y)
  if (tx === ty && tx.length >= 4) return true
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]
  return s.length >= 5 && l.includes(s)
}

/**
 * 登记一个地点到区域地图。
 * · 首次出现时分配槽位（槽位耗尽后沿环形外扩兜底）；
 * · **同一地点的不同写法会复用同一个节点**，并把节点名更新为最新写法——
 *   这样界面按 location 找"当前位置"永远找得到，标记不会丢；
 * · 落脚点（shelter）单独标记，界面以不同图标区分；
 * · 记录访问次数——界面据此区分"去过的地方"与"只是听说的地方"。
 */
export function placeMapNode(state, name, opts = {}) {
  const nm = String(name || '').trim().slice(0, 40)
  if (!nm || nm === '未知地点') return null
  if (!Array.isArray(state.mapNodes)) state.mapNodes = []
  let node = state.mapNodes.find((n) => n.name === nm)
  if (!node) {
    // 模糊复用：同一地点的另一种写法
    node = state.mapNodes.find((n) => samePlace(n.name, nm))
    if (node) {
      const old = node.name
      node.name = nm // 改名为最新写法，保证 n.name === state.location
      if (Array.isArray(state.locationTrail)) {
        state.locationTrail = state.locationTrail.map((t) => (t === old ? nm : t))
      }
    }
  }
  if (!node) {
    const i = state.mapNodes.length
    let x
    let y
    if (i < MAP_SLOTS.length) {
      x = MAP_SLOTS[i].x + hashJitter(`${nm}#x`, 14)
      y = MAP_SLOTS[i].y + hashJitter(`${nm}#y`, 12)
    } else {
      // 槽位耗尽：沿环形外扩（仍夹在画布内，避免节点跑出可视区）
      const k = i - MAP_SLOTS.length
      const ang = k * 1.15
      const rad = 140 + (k % 3) * 28
      x = 320 + Math.cos(ang) * rad
      y = 210 + Math.sin(ang) * rad * 0.7
    }
    node = {
      name: nm,
      type: nodeTypeOf(nm),
      x: Math.round(Math.max(36, Math.min(604, x))),
      y: Math.round(Math.max(36, Math.min(384, y))),
      shelter: Boolean(opts.shelter),
      day: state.day,
      visits: 0,
    }
    state.mapNodes.push(node)
  }
  if (opts.shelter) node.shelter = true
  if (opts.visit !== false) node.visits = (node.visits || 0) + 1
  // 上限裁剪：**当前位置节点必须保留**，否则地图上会找不到"你在哪"
  if (state.mapNodes.length > MAP_NODE_CAP) {
    const here = String(state.location || '').trim()
    let keep = state.mapNodes.slice(-MAP_NODE_CAP)
    if (here && !keep.some((n) => n.name === here)) {
      const cn = state.mapNodes.find((n) => n.name === here)
      if (cn) keep = [cn, ...keep.slice(0, MAP_NODE_CAP - 1)]
    }
    state.mapNodes = keep
  }
  return node
}

/**
 * 记录一次地点变化：登记地图节点 + 追加行进轨迹。
 * ------------------------------------------------------------------
 * 行进轨迹（locationTrail）是"地图随剧情发展"的数据来源：
 * 玩家每移动一次，路线就延长一段，界面上以虚线按到访顺序连起来。
 * 只在**玩家真的换了地方**时调用（落脚点登记不算移动）。
 */
function recordLocation(state, name) {
  const node = placeMapNode(state, name)
  if (!node) return null
  if (!Array.isArray(state.locationTrail)) state.locationTrail = []
  const trail = state.locationTrail
  if (trail[trail.length - 1] !== node.name) trail.push(node.name)
  if (trail.length > 40) state.locationTrail = trail.slice(-40)
  return node
}

/* ------------------------------ 任务链（焦点 / 主线循环） ------------------------------ */

/**
 * 依据玩家所选选项的 quest 标注，切换任务焦点。
 * ------------------------------------------------------------------
 * · "main"        → 焦点回到主线；
 * · 某条进行中的支线标题 → 焦点切到那条支线（下一回合围绕它生成随机事件）；
 * · "new" / 未标注 → **保持当前焦点**（故事始终围绕当前目标推进，不因玩家的无关选择而失焦）。
 * 这是需求"选支线选项就按支线生成事件、完成后回归主线"的落地点。
 */
function applyChoiceFocus(state, questTag) {
  const q = String(questTag || '').trim()
  if (q === 'main') {
    state.questFocus = { type: 'main', title: state.mainQuest?.title || '活下去', sinceTurn: state.turn }
    return
  }
  if (q && q !== 'new') {
    const hit = (state.sideQuests || []).find((x) => x.status === 'active' && x.title === q)
    if (hit) state.questFocus = { type: 'side', title: hit.title, sinceTurn: state.turn }
  }
}

/** 焦点维护：焦点支线一旦了结/消失，自动回归主线（"完成支线后回归主线"） */
function syncQuestFocus(state) {
  const active = (state.sideQuests || []).filter((q) => q.status === 'active')
  const f = state.questFocus
  if (!f || f.type !== 'side' || !active.some((q) => q.title === f.title)) {
    const title = state.mainQuest?.title || '活下去'
    if (!f || f.type !== 'main' || f.title !== title) {
      state.questFocus = { type: 'main', title, sinceTurn: state.turn }
    }
  }
}

/** 任务链的日志条目（在叙事流中显式呈现"主线完成 → 新主线确立"） */
function logQuestChain(state, text) {
  if (!Array.isArray(state.log)) state.log = []
  state.log.push({
    turn: state.turn,
    kind: 'quest',
    text,
    chosen: null,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
  })
}

/**
 * 主线完成 → 归档旧主线 + 开启新主线（任务链闭环）。
 * 模型应当同时给出 mainQuestNew；若漏给，引擎兜底用主角的目标续一条，绝不让主线空着。
 */
function completeMainQuest(state, nextRaw) {
  const cur = state.mainQuest
  const oldTitle = cur?.title || '未命名的主线'
  if (cur) {
    if (!Array.isArray(state.mainQuestHistory)) state.mainQuestHistory = []
    state.mainQuestHistory.push({
      title: cur.title,
      stage: cur.stage || '',
      note: cur.note || '',
      day: state.day,
      outcome: 'done',
    })
    if (state.mainQuestHistory.length > 20) state.mainQuestHistory = state.mainQuestHistory.slice(-20)
  }

  const nm = nextRaw && typeof nextRaw === 'object' ? nextRaw : null
  if (nm && nm.title) {
    state.mainQuest = {
      title: String(nm.title).slice(0, 24),
      stage: String(nm.stage || '刚刚开始').slice(0, 80),
      note: String(nm.note || '').slice(0, 120),
    }
  } else {
    state.mainQuest = {
      title: String(state.protagonist?.goal || '活下去').slice(0, 24),
      stage: '旧的执念已经了结，但末日不会因此停下——他必须找到下一个活下去的理由。',
      note: '',
    }
  }

  state.mainQuestSeq = (state.mainQuestSeq || 1) + 1
  state.questFocus = { type: 'main', title: state.mainQuest.title, sinceTurn: state.turn }
  // 新主线确立 → 下一回合强制从新主线派生支线（"完成主线后从主线随机生成支线"）
  state.spinSideFromMain = true
  state.spinSinceTurn = state.turn

  logQuestChain(
    state,
    `主线【${oldTitle}】达成了。\n可活下去这件事没有终点——新的主线浮出水面：【${state.mainQuest.title}】${state.mainQuest.stage ? `（${state.mainQuest.stage}）` : ''}`,
  )
}

function applyStateChanges(state, raw) {
  const delta = raw.stateDelta && typeof raw.stateDelta === 'object' ? raw.stateDelta : {}
  // 制作等级抵消本回合的感染增量：每级少 1 点，抵消不了已有的感染
  if (Number(delta.infection) > 0) {
    delta.infection = Math.max(0, Number(delta.infection) - skillLevel(state.skills?.craft))
  }
  // 战斗等级减轻本回合受到的伤害：每级少掉 1 点生命，不会因此变成回血
  if (Number(delta.hp) < 0) {
    delta.hp = Math.min(0, Number(delta.hp) + skillLevel(state.skills?.combat))
  }
  for (const k of STAT_KEYS) {
    if (delta[k] !== undefined) state.stats[k] = clamp(state.stats[k] + Number(delta[k]))
  }

  for (const c of arr(raw.conditionsRemove)) state.conditions = state.conditions.filter((x) => x !== c)
  for (const c of arr(raw.conditionsAdd)) {
    const name = String(c || '').trim().slice(0, 30)
    if (name && !state.conditions.includes(name)) state.conditions.push(name)
  }

  for (const name of arr(raw.inventoryRemove)) {
    const idx = state.inventory.findIndex((i) => i.name === name)
    if (idx >= 0) state.inventory.splice(idx, 1)
  }
  for (const item of arr(raw.inventoryAdd)) {
    const it = normalizeItem(item)
    if (!it) continue
    const exist = state.inventory.find((i) => i.name === it.name)
    if (exist) {
      if (it.setQty !== undefined) {
        // 显式设定剩余数量（可用 0 表示用尽）——覆盖而非累加
        exist.qty = it.setQty
      } else {
        exist.qty = (exist.qty || 1) + it.qty
      }
      if (it.note) exist.note = it.note // 最新备注覆盖旧值（信息更新）
      if (it.fits) exist.fits = it.fits // 适用对象由模型持续修正
      if (it.tradable) exist.tradable = true
      if (exist.category === '杂物') exist.category = it.category // 修正早期误判的分类
    } else {
      if (it.setQty !== undefined) it.qty = it.setQty || 1 // 新物品不可为 0
      delete it.setQty
      state.inventory.push(it)
    }
  }

  for (const name of arr(raw.alliesRemove)) state.allies = state.allies.filter((a) => a.name !== name)
  for (const a of arr(raw.alliesAdd)) {
    if (a && a.name && !state.allies.some((x) => x.name === a.name)) {
      state.allies.push({
        name: String(a.name).slice(0, 24),
        status: a.status || '同行',
        note: String(a.note || '').slice(0, 60),
      })
    }
  }
  for (const a of arr(raw.alliesUpdate)) {
    if (!a || !a.name) continue
    const exist = state.allies.find((x) => x.name === a.name)
    if (exist) {
      if (a.status) exist.status = a.status
      if (a.note !== undefined) exist.note = String(a.note).slice(0, 60)
    } else {
      state.allies.push({
        name: String(a.name).slice(0, 24),
        status: a.status || '同行',
        note: String(a.note || '').slice(0, 60),
      })
    }
  }

  for (const f of arr(raw.flagsAdd)) {
    const name = String(f || '').trim().slice(0, 50)
    if (name && !state.flags.includes(name)) state.flags.push(name)
  }

  // 安全落脚点：一旦在叙事里确立就长期可用（睡觉地点候选）
  applyShelters(state, raw)

  // 病毒变异株：一旦出现即永久留存
  for (const m of arr(raw.mutationsAdd)) {
    if (m && m.name && !state.mutations.some((x) => x.name === m.name)) {
      state.mutations.push({
        name: String(m.name).slice(0, 24),
        traits: String(m.traits || '').slice(0, 120),
        note: String(m.note || '').slice(0, 60),
      })
    }
  }

  if (raw.location && typeof raw.location === 'string') {
    const next = raw.location.trim().slice(0, 40)
    if (next && next !== state.location) {
      state.location = next
      recordLocation(state, next) // 移动即在地图上登记新地点，并延长行进轨迹
    }
  }

  // 最后统一净化：任何把数量写到 <= 0 的路径（含模型用同名 inventoryAdd 覆盖 qty）都在此收口
  pruneInventory(state)
}

/* ------------------------------ 昼夜时钟（24 小时制） ------------------------------ */

/**
 * 推进游戏内时间。成本以**游戏小时**计（模型给 timeCostHours），引擎换算成分钟累加。
 *  · 现实 5 分钟 = 游戏 1 天，但时钟只在玩家行动时推进（挂机暂停），所以推进量由行动耗时决定。
 *  · 每跨过一小时，天气有一次"自然转变"的判定；跨日则重新抽定天气。
 *  · 单次行动最多推进 6 小时（防止模型给出夸张耗时），最少 0（瞬发动作）。
 */
/** 底层时钟推进：按小时推进并处理跨日 / 整点的天气变化（不设上限，供睡眠等长时段使用） */
function advanceHours(state, hours) {
  const h = Number(hours)
  if (!Number.isFinite(h) || h <= 0) return 0
  const addMin = Math.round(h * MIN_PER_HOUR)
  if (addMin <= 0) return 0

  const beforeHour = Math.floor(normMinute(state.minute) / 60)
  const beforeDay = state.day
  let total = state.minute + addMin
  state.day += Math.floor(total / MIN_PER_DAY)
  state.minute = normMinute(total)

  const afterHour = Math.floor(state.minute / 60)

  // 天气递变：跨日必定重抽；同一日内每越过整点有机会自然转变
  if (state.day !== beforeDay) {
    state.weather = rollWeather(state, state.weather)
  } else if (afterHour !== beforeHour) {
    state.weather = weatherDrift(state, afterHour - beforeHour)
  }
  return addMin / MIN_PER_HOUR
}

/** 玩家行动的时间代价：模型给的 timeCostHours（0-6 小时） */
function advanceClock(state, costHours) {
  const h = Number(costHours)
  const hours = Number.isFinite(h) ? Math.max(0, Math.min(6, h)) : 1
  advanceHours(state, hours)
}

/* ------------------------------ 天气系统 ------------------------------ */

/**
 * 天气是引擎掌管的第二重环境变量（与昼夜并列），模型只读不写。
 *  · 每种天气带：可见度修正（影响搜刮掉率）、丧尸感知修正、体力/精神每小时的隐性消耗、叙事提示。
 *  · 天气按"季节倾向（用爆发后天数近似） + 时段"加权抽定，并持续若干小时；跨日或逐小时递变时可能转换。
 *  · 天气不直接改 stats（避免与模型结算打架）；它通过"掉率修正 + 提示词里的环境描写要求"发挥作用，
 *    只有极端天气（暴雨/雷暴/暴雪）才在提示词里要求模型追加少量体力/精神消耗。
 */

/** 季节近似：用爆发后天数切成 4 段（春/夏/秋/冬），影响天气权重 */
function seasonOf(day) {
  const d = Math.max(1, Math.floor(Number(day) || 1))
  const cycle = ((d - 1) % 360) / 90 // 0-1 春, 1-2 夏, 2-3 秋, 3-4 冬
  if (cycle < 1) return 'spring'
  if (cycle < 2) return 'summer'
  if (cycle < 3) return 'autumn'
  return 'winter'
}

/**
 * 天气表。字段：
 *  kind   — 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snow' | 'blizzard'
 *  label  — 中文名
 *  note   — 一句话环境描写（进快照与提示词）
 *  lootMod    — 搜刮掉率乘数（雾/雨中翻找更难发现小件，但也可能"趁乱"；此处统一为可见度惩罚）
 *  zombieMod  — 丧尸感知乘数（雨声掩盖、雾降低嗅觉传导）
 *  staminaPerHour / sanityPerHour — 极端天气的隐性消耗（写进提示词让模型在结算时体现）
 *  minH/maxH — 持续时间区间（游戏小时）
 *  nightVisible — 夜间是否仍较亮（雪/雷暴）
 */
const WEATHERS = {
  clear: { kind: 'clear', label: '晴', note: '天色澄澈，能见度高', lootMod: 1.0, zombieMod: 1.0, staminaPerHour: 0, sanityPerHour: 0, minH: 6, maxH: 14, nightVisible: false },
  cloudy: { kind: 'cloudy', label: '多云', note: '云层疏淡，光影分明', lootMod: 1.0, zombieMod: 1.0, staminaPerHour: 0, sanityPerHour: 0, minH: 5, maxH: 12, nightVisible: false },
  overcast: { kind: 'overcast', label: '阴', note: '铅灰色天幕压得很低，光线暧昧', lootMod: 0.96, zombieMod: 0.95, staminaPerHour: 0, sanityPerHour: 0, minH: 5, maxH: 12, nightVisible: false },
  fog: { kind: 'fog', label: '雾', note: '浓雾贴着地面漫开，十步之外只剩轮廓', lootMod: 0.82, zombieMod: 0.7, staminaPerHour: 0, sanityPerHour: 1, minH: 3, maxH: 7, nightVisible: false },
  rain: { kind: 'rain', label: '小雨', note: '细雨连绵，打在积水里窸窣作响', lootMod: 0.9, zombieMod: 0.72, staminaPerHour: 1, sanityPerHour: 0, minH: 3, maxH: 8, nightVisible: false },
  storm: { kind: 'storm', label: '暴雨', note: '暴雨如注，雨水模糊了整片视野', lootMod: 0.78, zombieMod: 0.6, staminaPerHour: 2, sanityPerHour: 1, minH: 2, maxH: 5, nightVisible: false },
  thunder: { kind: 'thunder', label: '雷暴', note: '雷声在楼宇间炸开，闪电短暂照亮四周', lootMod: 0.7, zombieMod: 0.55, staminaPerHour: 2, sanityPerHour: 3, minH: 1, maxH: 4, nightVisible: true },
  snow: { kind: 'snow', label: '小雪', note: '碎雪无声飘落，地面开始积起薄薄一层', lootMod: 0.88, zombieMod: 0.82, staminaPerHour: 2, sanityPerHour: 0, minH: 3, maxH: 8, nightVisible: false },
  blizzard: { kind: 'blizzard', label: '暴风雪', note: '风雪抽打着脸，方向辨认变得困难', lootMod: 0.66, zombieMod: 0.6, staminaPerHour: 4, sanityPerHour: 2, minH: 1, maxH: 4, nightVisible: false },
}

/** 各季节的天气权重 */
const SEASON_WEIGHTS = {
  spring: { clear: 3, cloudy: 3, overcast: 3, rain: 3, storm: 1.2, fog: 1.6, thunder: 0.6, snow: 0.1, blizzard: 0 },
  summer: { clear: 5, cloudy: 3, overcast: 2, rain: 2.4, storm: 1.8, fog: 0.6, thunder: 1.6, snow: 0, blizzard: 0 },
  autumn: { clear: 3.4, cloudy: 3.2, overcast: 3, rain: 2.4, storm: 0.8, fog: 2.6, thunder: 0.3, snow: 0.4, blizzard: 0 },
  winter: { clear: 2.4, cloudy: 2.6, overcast: 3.2, rain: 0.8, storm: 0.3, fog: 1.6, thunder: 0, snow: 4, blizzard: 1.4 },
}

function pickWeighted(weights) {
  const keys = Object.keys(weights).filter((k) => weights[k] > 0)
  const total = keys.reduce((s, k) => s + weights[k], 0)
  if (total <= 0) return 'clear'
  let r = Math.random() * total
  for (const k of keys) {
    r -= weights[k]
    if (r <= 0) return k
  }
  return keys[keys.length - 1]
}

/** 构造一条天气记录（含持续时间与起始时间点） */
function makeWeather(kindKey, state) {
  const w = WEATHERS[kindKey] || WEATHERS.clear
  const durH = w.minH + Math.floor(Math.random() * (w.maxH - w.minH + 1))
  return {
    kind: w.kind,
    label: w.label,
    note: w.note,
    untilDay: null, // 由调用方按需补；这里只记剩余小时
    remainH: durH,
  }
}

/**
 * 抽定一次天气。prevWeather 非空时按"季节 + 上次天气的惯性"加权（晴后不易立刻雷暴等）。
 */
function rollWeather(state, prevWeather) {
  const season = seasonOf(state.day)
  const base = { ...SEASON_WEIGHTS[season] }
  // 夜晚提高雾/雪的相对权重（辐射冷却起雾）
  if (isNightMinute(state.minute)) {
    base.fog = (base.fog || 0) * 1.5
    base.clear = (base.clear || 0) * 0.7
  }
  // 惯性：不立刻从晴切换到暴烈天气——降低与上次差异过大的极端天气权重
  if (prevWeather && prevWeather.kind) {
    const prev = prevWeather.kind
    if (prev === 'clear' || prev === 'cloudy') {
      base.thunder = (base.thunder || 0) * 0.4
      base.blizzard = (base.blizzard || 0) * 0.3
    }
  }
  const kind = pickWeighted(base)
  const w = makeWeather(kind, state)
  return { kind: w.kind, label: w.label, note: w.note, remainH: w.remainH, lootMod: WEATHERS[w.kind].lootMod, zombieMod: WEATHERS[w.kind].zombieMod }
}

/**
 * 天气逐小时递变：每越过一整点，按剩余时长判断是否该转换。
 *  · 剩余 > 0 → 递减，保持
 *  · 剩余归零 → 重新抽定（带惯性）
 * shiftHours 为本次推进跨过的整点数量（≥1）。
 */
function weatherDrift(state, shiftHours) {
  const cur = state.weather
  if (!cur) return rollWeather(state, null)
  // 跨过午夜时 afterHour - beforeHour 为负，不能拿来当递减量，否则天气会倒流、remainH 越减越大
  const steps = Math.max(0, Math.floor(Number(shiftHours) || 0))
  if (steps <= 0) return cur
  let remain = (cur.remainH || 0) - steps
  // 每跨过 1 小时有 12% 的额外"突变"机会（天气本就无常）
  for (let i = 0; i < steps; i++) {
    if (Math.random() < 0.12) remain = 0
  }
  if (remain > 0) return { ...cur, remainH: remain }
  return rollWeather(state, cur)
}

/** 当前天气的日志/展示标签 */
function weatherLogLabel(state) {
  return state.weather?.label || '晴'
}

/** 天气对搜刮掉率的乘数（无天气时按 1） */
function weatherLootMod(state) {
  return state.weather?.lootMod ?? 1
}

/* ------------------------------ 主线 / 支线 ------------------------------ */

const SIDE_STATUS = new Set(['active', 'done', 'failed', 'abandoned'])

function applyQuests(state, raw) {
  const mq = raw.mainQuestUpdate
  let mainDone = false
  if (mq && typeof mq === 'object') {
    if (!state.mainQuest) state.mainQuest = { title: state.protagonist?.goal || '活下去', stage: '', note: '' }
    if (mq.stage) state.mainQuest.stage = String(mq.stage).slice(0, 80)
    if (mq.note !== undefined) state.mainQuest.note = String(mq.note).slice(0, 120)
    if (mq.status === 'done') mainDone = true
  }

  let added = 0
  for (const q of arr(raw.sideQuestsAdd)) {
    if (!q || !q.title) continue
    const title = String(q.title).slice(0, 24)
    if (state.sideQuests.some((x) => x.title === title && x.status === 'active')) continue
    state.sideQuests.push({
      id: uuid(),
      title,
      hook: String(q.hook || '').slice(0, 120),
      giver: String(q.giver || '').slice(0, 40),
      status: 'active',
      note: String(q.note || '').slice(0, 120),
      day: state.day,
    })
    added++
  }

  for (const q of arr(raw.sideQuestsUpdate)) {
    if (!q || !q.title) continue
    const found = state.sideQuests.find((x) => x.title === String(q.title).slice(0, 24))
    if (!found) continue
    if (q.status && SIDE_STATUS.has(q.status)) found.status = q.status
    if (q.note !== undefined) found.note = String(q.note).slice(0, 120)
  }

  const active = state.sideQuests.filter((x) => x.status === 'active')
  if (active.length > 4) {
    for (const q of active.slice(0, active.length - 4)) q.status = 'abandoned'
  }
  if (state.sideQuests.length > 12) state.sideQuests = state.sideQuests.slice(-12)

  // 主线完成 → 归档 + 开启新主线（任务链闭环的核心一步）
  if (mainDone) completeMainQuest(state, raw.mainQuestNew)

  // 新主线派生的支线已经抛出 → 解除强制标记
  if (added > 0) state.spinSideFromMain = false
  // 安全阀：连续 3 回合都没能抛出支线，就不再强制（避免卡在"必须给支线"的约束上）
  if (state.spinSideFromMain && state.turn - (state.spinSinceTurn || 0) >= 3) state.spinSideFromMain = false

  // 焦点维护：焦点支线了结/消失 → 自动回归主线
  syncQuestFocus(state)
}

/* ------------------------------ 记忆与脉络 ------------------------------ */

function applyMemoryAndTimeline(state, raw) {
  if (raw.memory && typeof raw.memory === 'string') state.memory = raw.memory.trim().slice(0, 240)
  const summary =
    (raw.eventSummary && String(raw.eventSummary).trim().slice(0, 40)) ||
    (raw.narration ? String(raw.narration).slice(0, 28) + '…' : '')
  if (summary) {
    state.timeline.push(summary)
    if (state.timeline.length > 16) state.timeline = state.timeline.slice(-16)
  }
}

/**
 * quest 标注归一化：'main' / 某条**进行中的支线标题** / 'new'。
 * 非法值（拼错、指向已了结的支线、空）一律丢弃——宁可不标，也不要标错导致焦点跑偏。
 */
function normQuestTag(state, raw) {
  const q = String(raw || '').trim()
  if (!q) return ''
  if (/^(main|主线)$/i.test(q)) return 'main'
  if (/^(new|other|其他|无关|支线)$/i.test(q)) return 'new'
  const hit = (state?.sideQuests || []).find((x) => x.status === 'active' && x.title === q)
  return hit ? hit.title : ''
}

/**
 * 归一化选项：保留模型的 quest 标注（决定下一回合围绕哪条任务线生成事件）。
 * 注意：必须在本回合的 sideQuestsAdd 落库**之后**调用，否则新增支线的标注会被丢弃。
 */
function normalizeChoices(rawChoices, state) {
  const list = arr(rawChoices).filter((c) => c && c.text)
  return list.slice(0, 4).map((c, i) => {
    // 去剧透兜底：摘掉「安全地 / 成功地 / 明智地」这类把结果或优劣写在题面上的副词
    const choice = { id: CHOICE_IDS[i], text: polishChoiceText(c.text).slice(0, 60) }
    const tag = normQuestTag(state, c.quest)
    if (tag) choice.quest = tag
    const basis = String(c.basis || c.hint || c.why || '').replace(/\s+/g, ' ').trim().slice(0, 48)
    if (basis) choice.basis = basis
    return choice
  })
}

/**
 * 选项依据必须能在刚读到的正文或快照里对上号。
 * 模型仍会把正文没写过的物件（「水泥板」一类）直接写成选项——
 * 这里把对不上的名词补进本回合叙事，让玩家先看见，再做选择。
 */
const CHOICE_STOPWORDS = new Set([
  '继续', '离开', '回去', '过去', '过来', '起来', '下去', '出来', '进去', '上去', '下来',
  '看看', '找找', '听听', '问问', '等等', '先', '再', '把', '被', '给', '从', '向', '往',
  '这个', '那个', '这里', '那里', '什么', '怎么', '一下', '一点', '一些', '自己', '别人',
  '一起', '不要', '不能', '没有', '已经', '还是', '或者', '然后', '因为', '所以', '如果',
  '现在', '刚才', '之后', '之前', '周围', '附近', '里面', '外面', '上面', '下面', '前面', '后面',
  '主线', '支线', '线索', '目标', '方向', '动作', '选择', '情况', '事情', '东西', '地方',
])

function knownWorldText(state) {
  const parts = [
    state?.memory,
    state?.location,
    state?.protagonist?.name,
    state?.protagonist?.goal,
    state?.mainQuest?.title,
    state?.mainQuest?.stage,
    state?.mainQuest?.note,
  ]
  for (const a of state?.allies || []) parts.push(a?.name, a?.status, a?.note)
  for (const i of state?.inventory || []) parts.push(i?.name, i?.note)
  for (const q of state?.sideQuests || []) parts.push(q?.title, q?.note, q?.hook)
  for (const f of state?.flags || []) parts.push(f)
  for (const c of state?.conditions || []) parts.push(c)
  for (const s of state?.shelters || []) parts.push(s?.name, s?.note)
  for (const t of (state?.timeline || []).slice(-4)) parts.push(typeof t === 'string' ? t : t?.text)
  return parts.filter(Boolean).join('\n')
}

/** 从选项文案里抽出被指称的物件 / 人名 / 地点，而不是整句动作 */
function choiceNouns(text) {
  const src = String(text || '')
  const nouns = []
  const push = (w) => {
    const word = String(w || '').replace(/[的了着过]$/, '')
    if (word.length < 2 || word.length > 6) return
    if (CHOICE_STOPWORDS.has(word)) return
    if (!nouns.includes(word)) nouns.push(word)
  }
  // 「那块水泥板」「这个护士」「墙上的灭火器」「路边那辆面包车」
  const marked = src.matchAll(/(?:那|这)(?:块|扇|辆|个|名|条|处|间|张|把|瓶|盒|扇|道|家)?([\u4e00-\u9fff]{2,6})/g)
  for (const m of marked) push(m[1])
  const possessed = src.matchAll(/(?:墙上|地上|包里|手里|路边|门口|窗边|桌上|抽屉里)的([\u4e00-\u9fff]{2,6})/g)
  for (const m of possessed) push(m[1])
  if (!nouns.length) {
    // 没有指称时，取引号或书名号里的专名
    const quoted = src.matchAll(/[「『"“]([\u4e00-\u9fff]{2,8})[」』"”]/g)
    for (const m of quoted) push(m[1])
  }
  return nouns.slice(0, 3)
}

function nounKnown(noun, narration, known) {
  if (!noun) return true
  if (narration.includes(noun) || known.includes(noun)) return true
  return false
}

/** 两段文字是否共用一个实词（背包、主线、正文里已经有的，不算凭空出现） */
function sharesWords(src, hay) {
  const s = String(src || '')
  const h = String(hay || '')
  if (!s || !h) return false
  for (let n = Math.min(6, s.length); n >= 2; n--) {
    for (let i = 0; i <= s.length - n; i++) {
      const w = s.slice(i, i + n)
      if (!/^[\u4e00-\u9fff]+$/.test(w)) continue
      if (CHOICE_STOPWORDS.has(w)) continue
      if (h.includes(w)) return true
    }
  }
  return false
}

/**
 * 选项点到的物件如果正文和快照都没出现，把这一处补进本回合叙事。
 * 背包、主线、上一幕里已经有的不重复补。补不进新事实，只用模型自己写过的依据。
 */
function groundChoices(narration, choices, state) {
  const text = String(narration || '').trim()
  const list = Array.isArray(choices) ? choices : []
  if (!text || !list.length) return { text, choices: list }
  const known = knownWorldText(state)
  let corpus = `${text}\n${known}`
  const lines = []
  for (const c of list) {
    if (c?.consume) continue
    const basis = String(c.basis || '').trim()
    const basisBare = basis.replace(/[。！？…]+$/, '')
    // 依据原句已经写在这一段里，玩家看得到，不用再补
    if (basisBare && text.includes(basisBare)) continue
    const unknowns = choiceNouns(c?.text).filter((n) => !nounKnown(n, corpus, known))
    if (!unknowns.length) {
      // 没点出新物件：依据能对上正文、背包或任务线索，就让它留在原处
      if (!basisBare || sharesWords(basisBare, text) || sharesWords(basisBare, known)) continue
    }
    const lead = unknowns[0] || ''
    let line = ''
    if (lead && basisBare.includes(lead)) line = basisBare
    else if (lead && basisBare) line = `${basisBare}，因此你注意到了${lead}`
    else if (lead) line = `你这才看见${lead}`
    else line = basisBare
    line = String(line).replace(/[。！？…]+$/, '')
    if (!line || corpus.includes(line)) continue
    lines.push(`${line}。`)
    if (!basis && lead) c.basis = `你看见了${lead}`.slice(0, 48)
    corpus += `\n${line}`
  }
  if (!lines.length) return { text, choices: list }
  const block = lines.slice(0, 3).join('\n')
  const joined = /[。！？…]$/.test(text) ? `${text}\n${block}` : `${text}。\n${block}`
  return { text: joined, choices: list }
}

/**
 * 把模型提出的 `consumeRequest` 变成一条**由玩家点选的选项**。
 * ------------------------------------------------------------------
 * 设计意图（铁律）：剧情需要消耗背包物品时，**由玩家决定**，不由模型代扣。
 *   · 模型只提出"此刻需要某件东西" → 引擎在此渲染成带 `consume` 字段的选项；
 *   · 玩家点击该选项 → choose() 识别 `consume`，引擎真正扣减 qty，再走一次模型生成后果。
 *
 * 返回 { choice, item } 或 null（物品不存在 / 已失效则不生成选项）。
 */
function buildConsumeChoice(state, rawRequest) {
  if (!rawRequest || typeof rawRequest !== 'object') return null
  const name = String(rawRequest.name || '').trim()
  if (!name) return null
  const item = state.inventory.find((i) => i.name === name)
  if (!item) return null // 背包里没有 → 不生成（避免空按钮）
  const reason = String(rawRequest.reason || '').trim().slice(0, 24)
  const qty = item.qty || 1
  const text = reason
    ? `用「${item.name}」${qty > 1 ? `（剩 ${qty}）` : ''}——${reason}`
    : `用掉「${item.name}」${qty > 1 ? `（剩 ${qty}）` : ''}`
  return {
    choice: { id: 'CNS', text: text.slice(0, 60), consume: { name: item.name, reason } },
    item,
  }
}

/* ------------------------------ 开局 ------------------------------ */

async function generateOpening() {
  return chatJSON({ system: SYSTEM_PROMPT, user: buildOpeningPrompt(makeSeed()), config: getConfig() })
}

function applyOpening(state, raw) {
  if (raw.protagonist && raw.protagonist.name) {
    state.protagonist = {
      name: String(raw.protagonist.name).slice(0, 20),
      background: String(raw.protagonist.background || '').slice(0, 200),
      goal: String(raw.protagonist.goal || '').slice(0, 100),
    }
  } else {
    state.protagonist = { name: '无名者', background: '记忆在病毒爆发那天断了片。', goal: '活下去。' }
  }

  if (raw.stats && typeof raw.stats === 'object') {
    for (const k of STAT_KEYS) if (raw.stats[k] !== undefined) state.stats[k] = clamp(raw.stats[k])
  }
  if (raw.location) state.location = String(raw.location).slice(0, 40)
  state.minute = slotFromLabel(raw.timeOfDay)
  state.weather = rollWeather(state, null)
  recordLocation(state, state.location) // 开局地点是地图上的第一个节点，也是轨迹起点

  if (raw.mainQuest && raw.mainQuest.title) {
    state.mainQuest = {
      title: String(raw.mainQuest.title).slice(0, 24),
      stage: String(raw.mainQuest.stage || '刚刚开始').slice(0, 80),
      note: String(raw.mainQuest.note || '').slice(0, 120),
    }
  } else {
    state.mainQuest = { title: state.protagonist?.goal || '活下去', stage: '刚刚开始', note: '' }
  }
  // 开局即确立"第 1 条主线"，任务焦点落在主线上
  state.mainQuestSeq = 1
  state.questFocus = { type: 'main', title: state.mainQuest.title, sinceTurn: 0 }

  for (const item of arr(raw.inventory)) {
    const it = normalizeItem(item)
    if (it) state.inventory.push(it)
  }
  for (const c of arr(raw.conditions)) {
    const name = String(c || '').trim().slice(0, 30)
    if (name && !state.conditions.includes(name)) state.conditions.push(name)
  }
  for (const f of arr(raw.flags)) {
    const name = String(f || '').trim().slice(0, 50)
    if (name && !state.flags.includes(name)) state.flags.push(name)
  }
  applyShelters(state, raw)
  applyQuests(state, raw)
  // 开局的安全判定同样由模型给出（开局常常正是"事情正在变坏"的当口）
  applyScavengeSafety(state, raw)

  const openingChoices = normalizeChoices(raw.choices, state)
  const openingGrounded = groundChoices(String(raw.narration || '').trim(), openingChoices, state)
  state.lastEvent = { text: openingGrounded.text, choices: openingGrounded.choices }
  state.turn = 0
  state.over = false
  state.ending = null
  applyMemoryAndTimeline(state, raw)
  state.log = [
    { turn: 0, kind: 'opening', text: state.lastEvent.text, chosen: null, day: state.day, time: formatClock(state.minute), weather: weatherLogLabel(state) },
  ]
}

export async function newGame() {
  const state = baseState()
  const raw = await generateOpening()
  applyOpening(state, raw)
  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

/* ------------------------------ 推进一回合 ------------------------------ */

async function generateNextEvent(state, choiceText) {
  return chatJSON({ system: SYSTEM_PROMPT, user: buildTurnPrompt(state, choiceText, makeSeed()), config: getConfig() })
}

async function generateScavenge(state, depth, plan) {
  return chatJSON({
    system: SYSTEM_PROMPT,
    user: buildScavengePrompt(state, depth, plan, makeSeed()),
    config: getConfig(),
  })
}

/* ------------------------------ 睡眠 ------------------------------ */

/** 就地过夜（最差选项）：无遮挡、无门锁，任何动静都躲不过 */
export const SLEEP_PLACE_HERE = '就地'
const HERE_QUALITY = 0

/**
 * 现在能不能睡：黄昏之后到次日清晨之前都算"夜里"。
 * 白天（06:00-18:00）不能睡——那时还有事要做，也没有理由睡。
 */
export function canSleep(state) {
  if (!state || state.over) return false
  const m = normMinute(state.minute)
  return m >= DUSK_FROM_MIN || m < DAY_FROM_MIN
}

/** 可选睡觉地点：就地（最差）+ 已知的安全落脚点 */
export function sleepPlaces(state) {
  const here = {
    name: SLEEP_PLACE_HERE,
    label: `就地 · ${state.location}`,
    quality: HERE_QUALITY,
    note: '没有遮挡也没有门锁——任何动静都会先找到你',
  }
  const shelters = (state.shelters || []).map((s) => ({
    name: s.name,
    label: s.name,
    quality: effectiveShelterQuality(state, s),
    note: s.note || '',
  }))
  return [here, ...shelters]
}

/** 距离天亮（06:00）还有多少小时（精确保留，供引擎推进；显示时再四舍五入） */
export function hoursToDawn(minute) {
  const m = normMinute(minute)
  const diff = m < DAY_FROM_MIN ? DAY_FROM_MIN - m : MIN_PER_DAY - m + DAY_FROM_MIN
  return Math.max(0.5, diff / 60)
}

/** 睡眠期间的持续消耗由引擎强制结算：睡觉也在饿、也在渴 */
function applySleepUpkeep(state, hours) {
  state.stats.hunger = clamp(state.stats.hunger - Math.round(hours * 1.5))
  state.stats.thirst = clamp(state.stats.thirst - Math.round(hours * 1.8))
}

async function generateSleep(state, place, hours) {
  return chatJSON({
    system: SYSTEM_PROMPT,
    user: buildSleepPrompt(state, place, hours, makeSeed()),
    config: getConfig(),
  })
}

/**
 * 睡觉：夜晚的独立行动，由玩家自行决定"睡不睡、睡在哪"。
 * · 时间由引擎强制推进到次日 06:00（醒来即天亮）；
 * · 饥饿 / 口渴的持续消耗由引擎强制结算；
 * · 体力 / 精神 / 生命的恢复量、以及夜里是否出事，全部交给模型按地点与局势裁决。
 */
export async function sleep(id, placeName) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)
  if (!canSleep(state)) {
    throw new GameError(`现在是${dayPhaseOf(state.minute)}（${formatClock(state.minute)}），还不是睡觉的时候`, 400)
  }

  const places = sleepPlaces(state)
  const place = places.find((p) => p.name === placeName) || places[0]

  const hours = hoursToDawn(state.minute)

  advanceHours(state, hours)
  applySleepUpkeep(state, hours)
  // 去别处睡 = 一次夜行迁移；就地睡则留在原地
  if (place.name !== SLEEP_PLACE_HERE) {
    state.location = place.name
    recordLocation(state, place.name) // 迁移到落脚点 → 登记进地图并延长轨迹
  }

  const raw = await generateSleep(state, place, hours)
  applyStateChanges(state, raw)
  applyQuests(state, raw)

  let text = String(raw.narration || '').trim()
  if (!text) text = '你合上眼。黑暗里只剩自己的呼吸，再睁眼时天已经亮了。'
  const sleepChoices = normalizeChoices(raw.choices, state)
  const sleepGrounded = groundChoices(text, sleepChoices, state)
  text = sleepGrounded.text

  state.lastEvent = {
    text,
    choices: sleepGrounded.choices,
  }
  state.log.push({
    turn: state.turn,
    kind: 'sleep',
    text,
    chosen: '（睡觉）',
    target: place.label || place.name,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
  })
  applyMemoryAndTimeline(state, raw)

  // 一觉醒来是新的一天：重置"本回合已用物品"，并让放弃搜刮的标记失效
  state.usedThisTurn = null
  state.scavengeSkipSpot = null

  const cause = pendingEndingCause(state)
  if (cause) await forceEnding(state, cause)

  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}
async function generateUseItem(state, item, target) {
  return chatJSON({
    system: SYSTEM_PROMPT,
    user: buildUseItemPrompt(state, item, target, makeSeed()),
    config: getConfig(),
  })
}

async function generateGiveItem(state, item, targetName) {
  return chatJSON({
    system: SYSTEM_PROMPT,
    user: buildGiveItemPrompt(state, item, targetName, makeSeed()),
    config: getConfig(),
  })
}

/**
 * 生成「玩家确认消耗某物品」之后的后果。
 * 引擎先掷一次随机事件骰（骨架），再交给模型按骰子现场生成内容——
 * 与普通回合同构，只是起因被钉死为"玩家交出了这件东西"。
 * ⚠ **扣减在此完成**（引擎掌管数量）：先扣 1，归零则整条移除，再交给模型写后果。
 */
async function generateConsumeEvent(state, item, reason) {
  // 真正扣减（此时才扣——玩家已经点头）
  const live = state.inventory.find((i) => i.name === item.name)
  if (live) {
    live.qty = (live.qty || 1) - 1
    pruneInventory(state) // 数量归零 → 立即移除
  }
  const plan = rollEventPlan(state)
  return chatJSON({
    system: SYSTEM_PROMPT,
    user: buildConsumePrompt(state, item, reason, makeSeed(), plan),
    config: getConfig(),
  })
}

/**
 * 局势危险度（引擎掌管状态，模型负责语义判定）。
 * ------------------------------------------------------------------
 * "此刻局面危不危险"是个语义判断——只有读得懂叙事的模型能做，
 * 但它必须是**可追踪**的状态，所以由引擎持久化。
 * ⚠ 它**不是搜刮门禁**：玩家在任何局势下都能发起搜刮，本字段只用于
 *   ① 界面风险提示；② 让模型在危险时对搜刮给出相称的代价。
 * · 模型每回合在 raw.safeToScavenge 给出布尔值，引擎写进 state.scavengeSafe。
 * · 模型漏填（undefined/null）时**不收紧**：保守地沿用上一回合的判定，
 *   避免因模型偶发漏字段导致风险提示乱跳。
 */
function normUnsafeReason(v) {
  if (v === null || v === undefined) return ''
  return String(v).trim().slice(0, 30)
}

function applyScavengeSafety(state, raw) {
  const v = raw?.safeToScavenge
  if (typeof v === 'boolean') {
    state.scavengeSafe = v
    state.unsafeReason = v ? '' : normUnsafeReason(raw.unsafeReason) || '此刻局势危险'
  } else {
    // 模型没给判定 → 保持上一回合状态；从未判定过则默认为"安全"（让玩家不至于完全动不了）
    if (state.scavengeSafe === null || state.scavengeSafe === undefined) state.scavengeSafe = true
    if (state.scavengeSafe) state.unsafeReason = ''
  }
}

function applyEvent(state, raw, choiceText) {
  applyStateChanges(state, raw)
  advanceClock(state, raw.timeCostHours ?? raw.timeCost)
  applyQuests(state, raw)
  // 搜刮安全闸门：随每个新事件重新判定（模型才读得懂当前局势是否允许停下来翻找）
  applyScavengeSafety(state, raw)

  // 消耗诉求 → 由玩家点选的选项（放在最前，凸显"这是玩家要做的决定"）
  const consume = raw.isEnding ? null : buildConsumeChoice(state, raw.consumeRequest)
  const baseChoices = raw.isEnding ? [] : normalizeChoices(raw.choices, state)
  const grounded = raw.isEnding
    ? { text: String(raw.narration || '').trim(), choices: [] }
    : groundChoices(String(raw.narration || '').trim(), baseChoices, state)
  const choices = consume ? [consume.choice, ...grounded.choices].slice(0, 5) : grounded.choices

  state.lastEvent = {
    text: grounded.text,
    choices,
  }
  applyMemoryAndTimeline(state, raw)
  state.log.push({
    turn: state.turn,
    kind: 'event',
    text: state.lastEvent.text,
    chosen: choiceText,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
  })

  if (raw.isEnding) {
    state.over = true
    state.ending = {
      title: String(raw.endingTitle || '终局').slice(0, 30),
      text: String(raw.endingText || raw.narration || '').slice(0, 2000),
    }
  }
}

/** 生命/精神/感染触顶时返回兜底结局的触发原因，否则返回 null */
function pendingEndingCause(state) {
  if (state.over) return null
  if (state.stats.infection >= 100) {
    return '主角体内的丧尸病毒完成了尸化，脑干被接管，自我意识彻底消散——他成为了自己曾拼命逃离的东西：一只丧尸。'
  }
  if (state.stats.hp <= 0) return '主角的生命值降至 0，伤势/失血/感染夺走了他的生命。'
  if (state.stats.sanity <= 0) return '主角的精神值降至 0，理智彻底崩溃。'
  return null
}

async function forceEnding(state, cause) {
  try {
    const raw = await chatJSON({
      system: SYSTEM_PROMPT,
      user: buildEndingPrompt(state, cause, makeSeed()),
      config: getConfig(),
    })
    state.over = true
    state.ending = {
      title: String(raw.endingTitle || '终局').slice(0, 30),
      text: String(raw.endingText || '').slice(0, 2000),
    }
  } catch {
    state.over = true
    state.ending =
      state.stats.infection >= 100
        ? {
            title: '尸化',
            text: '最后一点属于"你"的东西，像退潮一样从指尖撤走。视野里的颜色一点点褪成灰白，疼痛消失了，恐惧也消失了。你听见自己的喉咙发出一个陌生的、湿漉漉的声音——那是在呼唤同类。远处，有东西回应了你。',
          }
        : {
            title: state.stats.hp <= 0 ? '力竭' : '崩解',
            text:
              state.stats.hp <= 0
                ? '你的视野边缘开始发黑。雨水落在脸上，已经感觉不到冷了。城北的方向还亮着一点微弱的光，但你再也走不到那里。'
                : '世界在你耳边碎裂成无数噪音。你分不清哪些是真实的脚步，哪些只是自己的心跳。',
          }
  }
  state.lastEvent = { text: state.ending.text, choices: [] }
  state.log.push({
    turn: state.turn,
    kind: 'ending',
    text: state.ending.text,
    chosen: null,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
  })
}

export async function choose(id, choiceId) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)
  const choice = (state.lastEvent?.choices || []).find((c) => c.id === choiceId)
  if (!choice) throw new GameError('无效的选项', 400)

  state.turn += 1
  state.usedThisTurn = null // 新回合重置「使用物品」的次数

  // ⚠ 任务链：玩家所选选项标注了它服务于哪条任务线——
  //   选了支线选项，就把焦点切到那条支线（下一回合的事件将围绕它生成）；
  //   支线了结后 applyQuests 会自动把焦点收回主线。
  applyChoiceFocus(state, choice.quest)

  // ⚠ 「消耗物品」选项：玩家点了才真正扣减——这是玩家自己的决定，不是模型代扣。
  //   扣减由引擎完成（数量 -1，归零则移除），随后掷一次随机事件骰，交给模型生成后果。
  const consumeName = choice.consume?.name
  let raw
  if (consumeName) {
    const item = state.inventory.find((i) => i.name === consumeName)
    if (!item) {
      // 选项已失效（物品在别处被消耗）→ 按普通选项处理，避免卡死
      raw = await generateNextEvent(state, choice.text)
    } else {
      raw = await generateConsumeEvent(state, item, choice.consume.reason)
    }
  } else {
    raw = await generateNextEvent(state, choice.text)
  }

  applyEvent(state, raw, choice.text)

  const cause = pendingEndingCause(state)
  if (cause) await forceEnding(state, cause)

  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

/* ------------------------------ 对外视图 ------------------------------ */

export function publicState(state) {
  return {
    id: state.id,
    turn: state.turn,
    day: state.day,
    minute: normMinute(state.minute),
    clock: formatClock(state.minute),
    timeOfDay: formatClock(state.minute),
    timePhrase: timeOfDayPhrase(state.minute),
    dayPhase: dayPhaseOf(state.minute),
    isNight: isNightMinute(state.minute),
    weather: state.weather
      ? { kind: state.weather.kind, label: state.weather.label, note: state.weather.note, remainH: state.weather.remainH }
      : null,
    collapseStage: collapseStage(state.day),
    location: state.location,
    protagonist: state.protagonist,
    mainQuest: state.mainQuest,
    sideQuests: state.sideQuests,
    // 任务链：第几条主线 / 已完成的主线 / 当前任务焦点（决定下一回合围绕哪条线生成事件）
    mainQuestSeq: state.mainQuestSeq || 1,
    mainQuestHistory: state.mainQuestHistory || [],
    questFocus: questFocusOf(state),
    // 区域地图：已探明的地点节点（界面据此绘制当前区域地图）
    mapNodes: state.mapNodes || [],
    // 行进轨迹：按剧情推进顺序到访的地点名（地图据此画出路线，随剧情不断延长）
    locationTrail: state.locationTrail || [],
    stats: state.stats,
    infectionStage: infectionStage(state.stats.infection),
    inventory: state.inventory,
    conditions: state.conditions,
    allies: state.allies,
    flags: state.flags,
    mutations: state.mutations,
    virusGeneration: 1 + state.mutations.length,
    scavengeCount: state.scavengeCount || 0,
    scavengeHere: state.scavengeSpot === state.location ? state.scavengeSpotCount || 0 : 0,
    scavengeCap: state.scavengeSpot === state.location ? normScavengeCap(state.scavengeCap) : 3,
    scavengeExhausted:
      state.scavengeSpot === state.location &&
      (state.scavengeSpotCount || 0) >= normScavengeCap(state.scavengeCap),
    // 玩家已明确表示"不搜刮此地"（换地点后自动失效）
    scavengeSkipped: state.scavengeSkipSpot === state.location,
    // 局势危险度：仅作界面风险提示，**不再禁止搜刮**
    scavengeSafe: state.scavengeSafe !== false,
    unsafeReason: state.scavengeSafe === false ? state.unsafeReason || '此刻局势危险' : '',
    usedThisTurn: state.usedThisTurn || null,
    canUseItem: !state.over && !state.usedThisTurn,
    canGiveItem: !state.over && !state.usedThisTurn && state.allies.length > 0,
    targetOptions: [TARGET_SELF, ...state.allies.map((a) => a.name), TARGET_HERE],
    useCount: state.useCount || 0,
    memory: state.memory,
    timeline: state.timeline,
    log: state.log,
    choices: state.over ? [] : state.lastEvent?.choices || [],
    narration: state.lastEvent?.text || '',
    over: state.over,
    ending: state.ending,
    canScavenge: !state.over,
    // 睡眠：夜里才开放，地点候选 = 就地 + 已知安全落脚点
    shelters: state.shelters || [],
    canSleep: canSleep(state),
    sleepPlaces: canSleep(state) ? sleepPlaces(state) : [],
    // 制作 / 据点 / 交易 / 技能
    recipes: recipeView(state),
    canCraft: !state.over && !state.usedThisTurn,
    sheltersDetail: shelterView(state),
    tradeOffer: state.tradeOffer || null,
    canTrade: !state.over && !state.usedThisTurn && (state.inventory || []).some((i) => i && (i.tradable || i.category === '食物' || i.category === '药品' || i.category === '弹药')),
    tradePartners: state.allies.map((a) => a.name).filter(Boolean),
    skills: skillView(state),
    craftCount: state.craftCount || 0,
    tradeCount: state.tradeCount || 0,
  }
}

/* ------------------------------ 搜刮 ------------------------------ */

/**
 * 搜刮的**概率模型**（爆率既不能太高也不能太低，且逐次递减）。
 *
 * 设计意图：
 *  · 搜刮上限是**随机 0-3 次**（每次踏进一个地点时现场抽定），所以有的地方根本翻不出东西，
 *    有的地方能翻满三轮——玩家无法用固定预期去规划，只能靠现场判断值不值得翻。
 *  · 每次搜刮是**逐件独立掷骰**，不做"每次必给 N 件"的保底，避免退化成刷子玩法。
 *  · 掉率随搜刮深度**明显下滑**（0.62 / 0.34 / 0.14），越翻越空。
 *  · 深夜/体力濒危/已感染时会再打一个折扣——状态越差，越难翻到有用的东西。
 */

/** 每次搜刮最多尝试开出几件（掷骰次数上限） */
const LOOT_ROLLS_PER_SCAVENGE = 3
/** 按搜刮深度（1/2/3）的单件掉率 */
const LOOT_RATES = [0.62, 0.34, 0.14]
/** 单次搜刮的产出硬上限，防止 e 模型一次塞一堆 */
const LOOT_MAX_PER_SCAVENGE = 3
/** 每次踏进一个地点时，现场抽定的搜刮上限（0/1/2/3，权重递增：翻不了几次的地方更多） */
const SCAVENGE_CAP_WEIGHTS = [0, 1, 1, 2, 2, 2, 3, 3]

/** 归一化搜刮上限：非法值一律回落到 3 */
function normScavengeCap(v) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return 3
  return Math.max(0, Math.min(3, n))
}

/** 抽定一个随机搜刮上限（0-3）。首次踏进某地点时调用一次，之后固定不变。 */
function rollScavengeCap() {
  const w = SCAVENGE_CAP_WEIGHTS
  return w[Math.floor(Math.random() * w.length)]
}

/** 按搜刮深度取单件掉率；深度超出表长时按最后一个档位继续衰减 */
function lootRateForDepth(depth) {
  const d = Math.max(1, Math.floor(Number(depth) || 1))
  if (d <= LOOT_RATES.length) return LOOT_RATES[d - 1]
  return Math.max(0.05, LOOT_RATES[LOOT_RATES.length - 1] * 0.6 ** (d - LOOT_RATES.length))
}

/**
 * 现场掷骰，决定这次搜刮**最多允许开箱几件**（0 件表示这一次注定空手）。
 * 结果随深度递减，并受深夜/体力/感染影响。
 */
function rollScavengePlan(state, depth) {
  const base = lootRateForDepth(depth)
  let rate = base
  if (isNightMinute(state.minute)) rate *= 0.65 // 夜里看不清，翻找效率低
  if ((state.stats.stamina || 0) <= 25) rate *= 0.75 // 体力濒危，动作变形
  if ((state.stats.infection || 0) >= 55) rate *= 0.7 // 终末期，手抖、视线糊
  rate *= weatherLootMod(state) // 天气影响：雾/雨/雪中翻找更难发现小件
  rate *= skillLootMod(state) // 搜刮技能：每级 +6% 掉率
  rate = Math.max(0.05, Math.min(0.92, rate))

  let maxItems = 0
  for (let i = 0; i < LOOT_ROLLS_PER_SCAVENGE; i++) {
    if (Math.random() < rate) maxItems++
  }
  return { maxItems: Math.min(maxItems, LOOT_MAX_PER_SCAVENGE), rate: Math.round(rate * 100) / 100 }
}

/**
 * 搜刮特殊事件（插曲）概率模型。
 *  · 与"搜到几件"完全独立结算：插曲是翻找过程中**额外撞上**的东西（危险或机遇），
 *    不占用本次产出配额，也不额外扣时段与体力——它就发生在这几分钟里。
 *  · 触发概率随局势波动：越危险的地方/深夜/已多次翻找/状态越差，越容易出事（也越容易撞见东西）。
 *  · 倾向（danger / chance）由现场掷骰决定，再交给模型按当前时段与地点裁决具体内容。
 */
const SPECIAL_BASE_RATE = 0.3 // 基线触发概率（三成左右）
const SPECIAL_MAX_RATE = 0.62 // 上限，避免"每次搜刮都出事"，插曲仍然要显得稀有

/** 归一化插曲判定结果，保证字段结构恒可用 */
function normScavengeSpecial(v) {
  if (!v || typeof v !== 'object') return { triggered: false, kind: 'chance', title: '', text: '' }
  const kind = v.kind === 'danger' ? 'danger' : 'chance'
  return {
    triggered: Boolean(v.triggered),
    kind,
    title: v.title ? String(v.title).slice(0, 20) : '',
    text: v.text ? String(v.text) : '',
  }
}

/**
 * 现场掷骰，决定这次搜刮**是否撞上插曲**、以及**偏危险还是偏机遇**。
 * 深夜里人比尸更危险、废墟里机遇与尸体并存——概率与倾向都随局势浮动。
 */
function rollScavengeSpecial(state, depth) {
  let rate = SPECIAL_BASE_RATE
  if (isNightMinute(state.minute)) rate += 0.1 // 夜里出事概率更高
  if (depth >= 2) rate += 0.06 * (depth - 1) // 翻得越久，越容易惊动什么
  if ((state.stats.stamina || 0) <= 25) rate += 0.05 // 体力濒危，反应慢
  if ((state.stats.infection || 0) >= 55) rate += 0.05 // 终末期，判断力下降
  rate = Math.max(0.08, Math.min(SPECIAL_MAX_RATE, rate))

  const triggered = Math.random() < rate
  // 倾向：夜晚/废墟/连续翻找偏危险；白天/首次翻找偏机遇
  let dangerBias = 0.5
  if (isNightMinute(state.minute)) dangerBias += 0.18
  if (depth >= 2) dangerBias += 0.08
  if (isNightMinute(state.minute) && depth >= 3) dangerBias += 0.1
  const kind = Math.random() < dangerBias ? 'danger' : 'chance'

  return { triggered, kind, rate: Math.round(rate * 100) / 100 }
}

/**
 * 把模型返回的 inventoryAdd **按概率裁剪**，实现真正的"概率掉落"。
 * 按 qty 逐件掷骰，命中多少留多少；整件都没命中就从产出里剔除。
 * 注意：玩家主动付出代价的搜刮才需要裁剪，这条链路只服务搜刮。
 */
function pruneLootByChance(items, rate, cap) {
  const out = []
  let budget = cap
  for (const raw of arr(items)) {
    const it = normalizeItem(raw)
    if (!it || budget <= 0) continue
    let kept = 0
    for (let i = 0; i < it.qty && budget > 0; i++) {
      if (Math.random() < rate) {
        kept++
        budget--
      }
    }
    if (kept > 0) out.push({ ...it, qty: kept })
  }
  return out
}

/**
 * 把只解析为部分战利品的搜刮结果，通过 narrative 回填进背包。
 * 模型偶尔会把物品只在叙事里描述、却忘了写进 inventoryAdd（或反之）——两个方向都补一次。
 */
function backfillLootFromNarration(state, raw) {
  const names = arr(raw.inventoryAdd).map((x) => (x && x.name ? String(x.name).trim() : ''))
  if (!names.length) {
    // 叙事里列举了物品但 inventoryAdd 为空：从「、，,」分隔的短句中粗暴提取
    const text = String(raw.narrative || '')
    const m = text.match(/[（(]?([^。；;\n]{2,40}?)[）)]?\s*(?:到手|入手|装进|塞进|收入囊中|进了背包)/)
    if (m) {
      for (const seg of m[1].split(/[、,，和及]/)) {
        const nm = seg.replace(/^(你|我|他|她|找到|翻出|捡到|搜到|拿到|得到了?|发现了?|多了)+/g, '').trim()
        if (nm && nm.length <= 12) {
          const it = normalizeItem({ name: nm, category: '杂物', qty: 1 })
          if (it && !state.inventory.some((i) => i.name === it.name)) state.inventory.push(it)
        }
      }
    }
  }
}

/** 搜刮：玩家主动原地翻找物资。代价 = 1 个时段 + 体力，产出按概率掉落且逐次递减 */
export async function scavenge(id) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)

  // ⚠ 这里**不再有门禁**：搜刮与否完全由玩家自己决定（"搜刮此地" / "不搜刮此地"两个选择）。
  // 局势危险（scavengeSafe === false）只影响代价——提示词已要求模型在危险时给出实质损失。

  // 本次是这一地点的第几次搜刮（1=首次）。必须在自增前算好，否则永远发 1。
  const sameSpot = state.scavengeSpot === state.location
  const depth = (sameSpot ? state.scavengeSpotCount || 0 : 0) + 1

  // 这个地点最多能翻几次：**首次踏进时现场抽定（0-3）**，之后固定不变。
  const cap = normScavengeCap(sameSpot ? state.scavengeCap : rollScavengeCap())

  // 已经翻到上限（含 cap=0 的地点是"什么也翻不出"）：如实告知，且**不再消耗时段与体力**
  if (depth > cap) {
    const text =
      cap <= 0
        ? '你扫视了一圈，这地方根本没有值得下手的东西——空的柜子、被撕烂的包装、几件早被人挑剩的破烂。继续留在这里只是把后背暴露给黑暗。'
        : '这里已经被你翻空了。柜子、抽屉、角落，每一处都留着你自己翻动过的痕迹，再翻一遍只是浪费时间，还会把动静传出去。'
    state.lastEvent = { text, choices: state.lastEvent?.choices?.length ? state.lastEvent.choices : [] }
    state.log.push({
      turn: state.turn,
      kind: 'scavenge',
      text,
      chosen: '（搜刮此地）',
      day: state.day,
      time: formatClock(state.minute),
      weather: weatherLogLabel(state),
      loot: [],
      exhausted: true,
    })
    state.updatedAt = Date.now()
    saveSession(state)
    return publicState(state)
  }

  // 搜刮必须付出代价：推进约 1.5 个游戏小时 + 扣体力（只在真正翻找时结算）
  advanceClock(state, 1.5)
  state.stats.stamina = clamp(state.stats.stamina - (isNightMinute(state.minute) ? 12 : 8))

  // 现场掷骰：这一次最多允许开出几件（0 件 = 注定空手）
  const plan = rollScavengePlan(state, depth)
  // 现场掷骰：这一次是否额外撞上插曲（危险 / 机遇），与产出配额独立结算
  plan.special = rollScavengeSpecial(state, depth)

  gainSkill(state, 'scavenge', 8)

  const raw = await generateScavenge(state, depth, plan)

  // **概率裁剪**：把模型给的产出按掉率逐件重掷，命中多少留多少。
  // 模型结果先照常结算一次，再用裁剪后的清单覆盖背包与日志，保证两者一致。
  const granted = pruneLootByChance(raw.inventoryAdd, plan.rate, plan.maxItems)
  applyStateChanges(state, { ...raw, inventoryAdd: granted })
  applyQuests(state, raw)

  // 同一地点连续搜刮，收益递减（越翻越空）
  if (state.scavengeSpot === state.location) state.scavengeSpotCount = (state.scavengeSpotCount || 0) + 1
  else {
    state.scavengeSpot = state.location
    state.scavengeSpotCount = 1
  }
  state.scavengeCap = cap
  state.scavengeCount = (state.scavengeCount || 0) + 1

  // 插曲：只有"本次确实掷中"且模型确实给出了内容才采纳（模型可能婉拒，避免硬塞）
  const special = plan.special?.triggered ? normScavengeSpecial(raw.scavengeSpecial) : normScavengeSpecial(null)
  const hasSpecial = plan.special?.triggered && special.triggered && Boolean(special.text || special.title)

  // 结果合并进上一事件的叙事流（日志追加为一条独立条目）
  let text = String(raw.narrative || '').trim()
  if (!text) text = granted.length ? '你翻找出了一些还能用的东西。' : '你翻找了一圈，什么也没找到。'
  // 这次注定空手，但模型却写成了"有所收获"——补一句把落差说明白，避免叙事与背包脱节
  if (!granted.length && plan.maxItems === 0) {
    text += '\n（你把每一样东西拿起来又放下——要么已经腐坏，要么根本用不上。这一趟，什么也没能带走。）'
  }
  // 撞上插曲时，把插曲正文并入搜刮叙事（插曲是"翻找途中撞上的"，属于同一次行动）
  if (hasSpecial && special.text) text += `\n\n${special.text}`

  const scavengeChoices = normalizeChoices(raw.choices, state)
  const scavengeGrounded = groundChoices(text, scavengeChoices, state)
  text = scavengeGrounded.text

  state.lastEvent = {
    text,
    choices: scavengeGrounded.choices,
  }
  state.log.push({
    turn: state.turn,
    kind: 'scavenge',
    text,
    chosen: '（搜刮此地）',
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
    loot: granted.map((x) => normalizedLootLabel(x)).filter(Boolean),
    special: hasSpecial ? special.kind : '',
    specialTitle: hasSpecial ? special.title || (special.kind === 'danger' ? '突发状况' : '意外收获') : '',
  })
  applyMemoryAndTimeline(state, raw)

  const cause = pendingEndingCause(state)
  if (cause) await forceEnding(state, cause)

  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

function normalizedLootLabel(item) {
  const it = normalizeItem(item)
  if (!it) return ''
  return it.qty > 1 ? `${it.name}×${it.qty}` : it.name
}

/**
 * 「不搜刮此地」：玩家明确表示不在当前地点翻找。
 * · 不消耗时间与体力——放弃不需要成本；
 * · 只把**当前地点**标记为已放弃（换地点后自动失效），界面据此收起搜刮入口；
 * · 不写日志：这不是一段剧情，只是玩家的一个决定。
 */
export async function skipScavenge(id) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)
  if (state.scavengeSkipSpot === state.location) return publicState(state)

  state.scavengeSkipSpot = state.location
  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

/* ------------------------------ 使用物品 ------------------------------ */

/**
 * 使用背包中的一件物品。每回合限 1 次。
 * 代价 = 1 个时段 + 少量体力（由引擎强制结算）。
 * **必须指定对象**（自己 / 某位同行者 / 就地使用）——对象与方法共同决定后果，
 * 物品的数值效果与**是否触发随机事件**都交给模型裁决：
 *   · 常规使用（吃掉/包扎/服药）→ 只给一段描写 + 数值变化，沿用原有选项。
 *   · 模型判定有意外（罐头变质、药给错人、声响引来丧尸…）→ 现场展开成一个完整事件并给出新选项。
 */
export async function useItem(id, itemName, target) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)
  if (state.usedThisTurn) {
    throw new GameError(`本回合已经使用过「${state.usedThisTurn}」了，推进剧情后才能再用`, 400)
  }

  const name = String(itemName || '').trim()
  const item = state.inventory.find((i) => i.name === name)
  if (!item) throw new GameError('背包中没有这件物品', 400)

  const who = normalizeTarget(state, target)

  // 代价：推进约 0.5 个游戏小时 + 少量体力
  advanceClock(state, 0.5)
  state.stats.stamina = clamp(state.stats.stamina - 4)
  state.usedThisTurn = item.name
  state.useCount = (state.useCount || 0) + 1
  // 武器 / 弹药的使用按「战斗」计经验，其余按「制作」（动手处理一件东西）
  gainSkill(state, item.category === '武器' || item.category === '弹药' ? 'combat' : 'craft', 6)

  const raw = await generateUseItem(state, item, who)

  // 先让模型结算（它可能用 inventoryRemove / setQty 自己扣），再兜底。
  // 顺序反了会扣两次：先减 1，随后模型再 inventoryRemove 整条删掉。
  applyStateChanges(state, raw)

  const consumed = state.inventory.find((i) => i.name === item.name)
  const modelRemoved = arr(raw.inventoryRemove).some((n) => String(n).trim() === item.name)
  const modelSetQty = arr(raw.inventoryAdd).some((it) => it && it.name === item.name && it.setQty !== undefined && it.setQty !== null && it.setQty !== '')
  if (consumed && !modelRemoved && !modelSetQty) {
    consumed.qty = (consumed.qty || 1) - 1
  }
  pruneInventory(state)
  applyQuests(state, raw)
  backfillLootFromNarration(state, raw)

  // 「常规使用」时模型不给新选项（这不代表故事该停下）——此时沿用使用前的原有选项，
  // 让玩家继续面对他原本要面对的局面。否则玩家会卡在一个没有任何按钮可点的死局。
  const previousChoices = state.lastEvent?.choices || []
  const freshChoices = normalizeChoices(raw.choices, state)
  const nextChoices = raw.isEnding ? [] : freshChoices.length ? freshChoices : previousChoices

  const actionLabel = `（使用 ${item.name} → ${who}）`
  const useText = String(raw.narrative || '').trim() || `你用掉了${item.name}。`
  const useGrounded = groundChoices(useText, nextChoices, state)
  state.lastEvent = {
    text: useGrounded.text,
    choices: useGrounded.choices,
  }
  state.log.push({
    turn: state.turn,
    kind: 'useitem',
    text: state.lastEvent.text,
    chosen: actionLabel,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
    used: item.name,
    target: who,
  })
  applyMemoryAndTimeline(state, raw)

  if (raw.isEnding) {
    state.over = true
    state.ending = {
      title: String(raw.endingTitle || '终局').slice(0, 30),
      text: String(raw.endingText || raw.narrative || '').slice(0, 2000),
    }
  }

  const cause = pendingEndingCause(state)
  if (cause) await forceEnding(state, cause)

  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

/**
 * 交出物品：把一件物品交给一个具体的人，换取回报 / 情报 / 人情，或招来抢夺。
 * 与「使用物品」共用**每回合 1 次**的次数限制（都是"停下来处理一件物品"这个动作）。
 */
export async function giveItem(id, itemName, targetName) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)
  if (state.usedThisTurn) {
    throw new GameError(`本回合已经处理过「${state.usedThisTurn}」了，推进剧情后才能再动背包`, 400)
  }

  const name = String(itemName || '').trim()
  const item = state.inventory.find((i) => i.name === name)
  if (!item) throw new GameError('背包中没有这件物品', 400)

  const who = String(targetName || '').trim()
  if (!who) throw new GameError('请指定要把这件东西交给谁', 400)

  // 代价：推进约 0.5 个游戏小时 + 少量体力（交涉本身也在消耗时间）
  advanceClock(state, 0.5)
  state.stats.stamina = clamp(state.stats.stamina - 3)
  state.usedThisTurn = item.name
  state.useCount = (state.useCount || 0) + 1
  gainSkill(state, 'social', 8)

  const raw = await generateGiveItem(state, item, who)

  // 先让模型结算，再兜底。顺序反了会扣两次（先减 1，模型再整条移除）。
  applyStateChanges(state, raw)

  const consumed = state.inventory.find((i) => i.name === item.name)
  const modelRemoved = arr(raw.inventoryRemove).some((n) => String(n).trim() === item.name)
  const modelSetQty = arr(raw.inventoryAdd).some((it) => it && it.name === item.name && it.setQty !== undefined && it.setQty !== null && it.setQty !== '')
  if (consumed && !modelRemoved && !modelSetQty) {
    consumed.qty = (consumed.qty || 1) - 1
  }
  pruneInventory(state)
  applyQuests(state, raw)

  const previousChoices = state.lastEvent?.choices || []
  const freshChoices = normalizeChoices(raw.choices, state)
  const nextChoices = raw.isEnding ? [] : freshChoices.length ? freshChoices : previousChoices

  const actionLabel = `（把 ${item.name} 交给 ${who}）`
  const giveText = String(raw.narrative || '').trim() || `你把${item.name}交了出去。`
  const giveGrounded = groundChoices(giveText, nextChoices, state)
  state.lastEvent = {
    text: giveGrounded.text,
    choices: giveGrounded.choices,
  }
  state.log.push({
    turn: state.turn,
    kind: 'giveitem',
    text: state.lastEvent.text,
    chosen: actionLabel,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
    used: item.name,
    target: who,
  })
  applyMemoryAndTimeline(state, raw)

  if (raw.isEnding) {
    state.over = true
    state.ending = {
      title: String(raw.endingTitle || '终局').slice(0, 30),
      text: String(raw.endingText || raw.narrative || '').slice(0, 2000),
    }
  }

  const cause = pendingEndingCause(state)
  if (cause) await forceEnding(state, cause)

  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

/* ------------------------------ 制作 / 据点 / 交易 / 技能 ------------------------------ */

/** 技能等级：每 40 点经验一级，上限 5。等级只改引擎掌管的乘数，不改叙事。 */
function skillLevel(xp) {
  return Math.max(0, Math.min(5, Math.floor((Number(xp) || 0) / 40)))
}

function skillView(state) {
  const src = state.skills && typeof state.skills === 'object' ? state.skills : {}
  const out = {}
  for (const def of SKILL_DEFS) {
    const xp = Math.max(0, Math.floor(Number(src[def.id]) || 0))
    out[def.id] = { xp, level: skillLevel(xp), label: def.label, effect: def.effect }
  }
  return out
}

/** 累积经验。返回是否升级，供日志点一下。 */
function gainSkill(state, id, amount) {
  if (!SKILL_DEFS.some((d) => d.id === id)) return false
  if (!state.skills || typeof state.skills !== 'object') state.skills = { scavenge: 0, combat: 0, craft: 0, social: 0 }
  const before = skillLevel(state.skills[id])
  state.skills[id] = Math.max(0, Math.floor(Number(state.skills[id]) || 0) + Math.max(0, Math.floor(amount)))
  return skillLevel(state.skills[id]) > before
}

/** 搜刮技能：每级 +6% 掉率（上限仍由 rollScavengePlan 夹到 0.92） */
function skillLootMod(state) {
  return 1 + skillLevel(state.skills?.scavenge) * 0.06
}

function ensureUpgrade(state, name) {
  if (!state.upgrades || typeof state.upgrades !== 'object') state.upgrades = {}
  if (!state.upgrades[name]) state.upgrades[name] = { door: 0, fire: 0, bed: 0, storage: 0 }
  return state.upgrades[name]
}

function upgradeOf(state, name) {
  const u = state.upgrades?.[name]
  return {
    door: u?.door ? 1 : 0,
    fire: u?.fire ? 1 : 0,
    bed: u?.bed ? 1 : 0,
    storage: u?.storage ? 1 : 0,
  }
}

/** 落脚点有效质量：基础质量 + 已装上的加固件（上限 3，睡觉恢复按这个算） */
function effectiveShelterQuality(state, shelter) {
  const base = Math.max(1, Math.min(3, Number(shelter?.quality) || 1))
  const u = upgradeOf(state, shelter?.name)
  const bonus = (u.door ? 1 : 0) + (u.bed ? 1 : 0)
  return Math.max(1, Math.min(3, base + (bonus >= 2 ? 1 : 0)))
}

function shelterView(state) {
  return (state.shelters || []).map((s) => {
    const u = upgradeOf(state, s.name)
    const installed = UPGRADE_SLOTS.filter((slot) => u[slot.id]).map((slot) => slot.label)
    const next = UPGRADE_SLOTS.filter((slot) => !u[slot.id]).map((slot) => ({
      id: slot.id,
      label: slot.label,
      need: (slot.need || []).map((n) => n.label || n.name),
      hours: slot.hours,
      affordable: canAfford(state, slot.need),
    }))
    return {
      name: s.name,
      quality: Math.max(1, Math.min(3, Number(s.quality) || 1)),
      effectiveQuality: effectiveShelterQuality(state, s),
      note: s.note || '',
      upgrades: u,
      installed,
      next,
    }
  })
}

/** 一件物品能不能当这条材料用：分类对上，名字或备注里再命中任一关键词 */
function itemFitsNeed(item, need) {
  if (!item || !need) return false
  if (need.category && item.category !== need.category) return false
  const keys = arr(need.keys).map((k) => String(k)).filter(Boolean)
  if (!keys.length) return true
  const hay = `${item.name || ''}${item.note || ''}`
  return keys.some((k) => hay.includes(k))
}

/** 为每条材料挑一件背包物品。同一件不能被两条材料同时用掉。不够返回 null。 */
function pickMaterials(state, need) {
  const used = new Map()
  const picks = []
  for (const n of need || []) {
    const qty = Math.max(1, Number(n.qty) || 1)
    const hit = (state.inventory || []).find((it) => {
      if (!itemFitsNeed(it, n)) return false
      const left = (Number(it.qty) || 0) - (used.get(it.name) || 0)
      return left >= qty
    })
    if (!hit) return null
    used.set(hit.name, (used.get(hit.name) || 0) + qty)
    picks.push({ name: hit.name, qty, label: n.label || n.name || hit.name })
  }
  return picks
}

function canAfford(state, need) {
  return Boolean(pickMaterials(state, need))
}

/** 扣材料。不够则什么都不扣，返回实际扣掉的清单；不够返回 null。 */
function spendMaterials(state, need) {
  const picks = pickMaterials(state, need)
  if (!picks) return null
  for (const p of picks) {
    const it = state.inventory.find((i) => i.name === p.name)
    if (it) it.qty = (it.qty || 1) - p.qty
  }
  pruneInventory(state)
  return picks
}

function recipeView(state) {
  return RECIPES.map((r) => {
    const picks = pickMaterials(state, r.need)
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      note: r.note,
      hours: r.hours,
      need: (r.need || []).map((n) => n.label || n.name),
      using: picks ? picks.map((p) => (p.qty > 1 ? `${p.name}×${p.qty}` : p.name)) : [],
      affordable: Boolean(picks),
    }
  })
}

function findRecipe(id) {
  return RECIPES.find((r) => r.id === id) || null
}

async function generateCraft(state, recipe) {
  return chatJSON({
    system: SYSTEM_PROMPT,
    user: buildCraftPrompt(state, recipe, makeSeed()),
    config: getConfig(),
  })
}

/**
 * 制作：玩家点选一条配方。
 * 材料够不够、扣几件、花几小时，全部由引擎结算；模型只写这次动手的过程与意外。
 * 成品由引擎直接入包，模型不得再发一件同名成品（避免双倍）。
 */
export async function craft(id, recipeId) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)
  if (state.usedThisTurn) {
    throw new GameError(`本回合已经处理过「${state.usedThisTurn}」了，推进剧情后才能再制作`, 400)
  }
  const recipe = findRecipe(recipeId)
  if (!recipe) throw new GameError('没有这条配方', 400)
  const spent = spendMaterials(state, recipe.need)
  if (!spent) throw new GameError('材料不够', 400)

  advanceClock(state, recipe.hours)
  const craftLv = skillLevel(state.skills?.craft)
  state.stats.stamina = clamp(state.stats.stamina - Math.max(2, 6 - craftLv))
  state.usedThisTurn = recipe.name
  state.craftCount = (state.craftCount || 0) + 1
  const leveled = gainSkill(state, 'craft', 12)

  // 成品先入包：模型漏写也不会让材料凭空消失
  applyStateChanges(state, {
    inventoryAdd: [{ name: recipe.name, category: recipe.category, qty: 1, note: recipe.note, tradable: true }],
  })

  const raw = await generateCraft(state, { ...recipe, spent })
  // 去掉模型重复发放的同名成品，其余结算照常（伤、声响、引来的人）
  const extra = arr(raw.inventoryAdd).filter((it) => !it || String(it.name) !== recipe.name)
  applyStateChanges(state, { ...raw, inventoryAdd: extra })
  applyQuests(state, raw)

  const previousChoices = state.lastEvent?.choices || []
  const freshChoices = normalizeChoices(raw.choices, state)
  const nextChoices = raw.isEnding ? [] : freshChoices.length ? freshChoices : previousChoices
  let text = String(raw.narrative || raw.narration || '').trim() || `你把材料拼成了${recipe.name}。`
  if (leveled) text += `\n（你的手比上次稳。制作升到了 ${skillLevel(state.skills.craft)} 级。）`
  const grounded = groundChoices(text, nextChoices, state)
  state.lastEvent = { text: grounded.text, choices: grounded.choices }
  state.log.push({
    turn: state.turn,
    kind: 'craft',
    text: state.lastEvent.text,
    chosen: `（制作 ${recipe.name}）`,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
    used: recipe.name,
    loot: [recipe.name],
  })
  applyMemoryAndTimeline(state, raw)

  if (raw.isEnding) {
    state.over = true
    state.ending = {
      title: String(raw.endingTitle || '终局').slice(0, 30),
      text: String(raw.endingText || text).slice(0, 2000),
    }
  }
  const cause = pendingEndingCause(state)
  if (cause) await forceEnding(state, cause)

  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

async function generateTrade(state, offer, partner) {
  return chatJSON({
    system: SYSTEM_PROMPT,
    user: buildTradePrompt(state, offer, partner, makeSeed()),
    config: getConfig(),
  })
}

/**
 * 开一笔交易：引擎按背包里标了「可交换」的东西，配一条具体回报。
 * 报价先挂在存档上，玩家点「成交」才真正换手。
 */
export async function offerTrade(id, partnerName) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)

  const partner = String(partnerName || '').trim().slice(0, 24)
  const tradables = (state.inventory || []).filter((i) => i.tradable || i.category === '食物' || i.category === '药品' || i.category === '弹药')
  if (!tradables.length) throw new GameError('背包里没有能拿去换的东西', 400)
  const give = tradables[Math.floor(Math.random() * tradables.length)]
  const returns = [
    { name: '半盒压缩饼干', category: '食物', note: '对方用吃的换' },
    { name: '一瓶浑浊的水', category: '饮水', note: '看着能喝' },
    { name: '三发受潮的子弹', category: '弹药', note: '口径对不上也先留着' },
    { name: '用过的绷带', category: '药品', note: '还能再缠一次' },
    { name: '一张手绘的路口图', category: '杂物', note: '上面画着一条绕路' },
  ]
  // 交涉等级越高，越不容易换到最差的那档
  const social = skillLevel(state.skills?.social)
  const pool = returns.slice(0, Math.min(returns.length, 3 + social))
  const got = pool[Math.floor(Math.random() * pool.length)]
  state.tradeOffer = {
    id: uuid(),
    partner: partner || '路过的人',
    give: { name: give.name, qty: 1 },
    get: { name: got.name, category: got.category, qty: 1, note: got.note, tradable: true },
    intel: social >= 2,
  }
  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

/** 成交：引擎扣一件、发一件，模型写对方的眼神和这笔账以后怎么回来。 */
export async function acceptTrade(id) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)
  const offer = state.tradeOffer
  if (!offer?.give?.name || !offer?.get?.name) throw new GameError('眼前没有一笔待成交的交易', 400)
  if (state.usedThisTurn) {
    throw new GameError(`本回合已经处理过「${state.usedThisTurn}」了，推进剧情后才能再交易`, 400)
  }
  if (!spendMaterials(state, [{ name: offer.give.name, qty: offer.give.qty || 1, keys: [offer.give.name] }])) {
    state.tradeOffer = null
    saveSession(state)
    throw new GameError('你要换出去的东西已经不在背包里', 400)
  }

  advanceClock(state, 0.5)
  state.stats.stamina = clamp(state.stats.stamina - 3)
  state.usedThisTurn = offer.give.name
  state.tradeCount = (state.tradeCount || 0) + 1
  const leveled = gainSkill(state, 'social', 10)
  applyStateChanges(state, { inventoryAdd: [offer.get] })
  if (offer.intel) {
    const mark = `交易情报·${offer.partner}`
    if (!state.flags.includes(mark)) state.flags.push(mark)
  }

  const raw = await generateTrade(state, offer, offer.partner)
  applyStateChanges(state, { ...raw, inventoryRemove: arr(raw.inventoryRemove).filter((n) => String(n) !== offer.give.name) })
  applyQuests(state, raw)

  const previousChoices = state.lastEvent?.choices || []
  const freshChoices = normalizeChoices(raw.choices, state)
  const nextChoices = raw.isEnding ? [] : freshChoices.length ? freshChoices : previousChoices
  let text = String(raw.narrative || raw.narration || '').trim() || `你用${offer.give.name}换到了${offer.get.name}。`
  if (leveled) text += `\n（你看人的眼神稳了一些。交涉升到了 ${skillLevel(state.skills.social)} 级。）`
  const grounded = groundChoices(text, nextChoices, state)
  state.lastEvent = { text: grounded.text, choices: grounded.choices }
  state.log.push({
    turn: state.turn,
    kind: 'trade',
    text: state.lastEvent.text,
    chosen: `（用 ${offer.give.name} 向 ${offer.partner} 换 ${offer.get.name}）`,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
    used: offer.give.name,
    loot: [offer.get.name],
    target: offer.partner,
  })
  applyMemoryAndTimeline(state, raw)
  state.tradeOffer = null

  if (raw.isEnding) {
    state.over = true
    state.ending = {
      title: String(raw.endingTitle || '终局').slice(0, 30),
      text: String(raw.endingText || text).slice(0, 2000),
    }
  }
  const cause = pendingEndingCause(state)
  if (cause) await forceEnding(state, cause)

  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

/** 拒绝报价：不花时间，只把报价清掉。 */
export function declineTrade(id) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  state.tradeOffer = null
  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

async function generateUpgrade(state, shelter, slot) {
  return chatJSON({
    system: SYSTEM_PROMPT,
    user: buildUpgradePrompt(state, shelter, slot, makeSeed()),
    config: getConfig(),
  })
}

/**
 * 加固据点：门 / 火堆 / 床 / 储物，四件各做一次。
 * 材料与 1 小时由引擎扣；质量上限 3，睡觉恢复跟着有效质量走。
 */
export async function upgradeShelter(id, shelterName, slotId) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  if (state.over) throw new GameError('本局已经结束，请开始新的一局', 400)
  if (state.usedThisTurn) {
    throw new GameError(`本回合已经处理过「${state.usedThisTurn}」了，推进剧情后才能再加固`, 400)
  }
  const shelter = (state.shelters || []).find((s) => s.name === shelterName)
  if (!shelter) throw new GameError('还没有这个落脚点', 400)
  const slot = UPGRADE_SLOTS.find((s) => s.id === slotId)
  if (!slot) throw new GameError('没有这种加固', 400)
  const bag = ensureUpgrade(state, shelter.name)
  if (bag[slot.id]) throw new GameError(`这里已经有${slot.label}了`, 400)
  const spent = spendMaterials(state, slot.need)
  if (!spent) throw new GameError('材料不够', 400)

  bag[slot.id] = 1
  advanceClock(state, slot.hours)
  state.stats.stamina = clamp(state.stats.stamina - 8)
  state.usedThisTurn = `${shelter.name}·${slot.label}`
  const leveled = gainSkill(state, 'craft', 10)

  const raw = await generateUpgrade(state, shelter, { ...slot, spent })
  applyStateChanges(state, raw)
  applyQuests(state, raw)
  // 模型可能把落脚点删掉；删了就连加固一起没了，不再强行加回
  if ((state.shelters || []).some((s) => s.name === shelter.name)) ensureUpgrade(state, shelter.name)[slot.id] = 1

  const previousChoices = state.lastEvent?.choices || []
  const freshChoices = normalizeChoices(raw.choices, state)
  const nextChoices = raw.isEnding ? [] : freshChoices.length ? freshChoices : previousChoices
  let text =
    String(raw.narrative || raw.narration || '').trim() ||
    `你在${shelter.name}装上了${slot.label}。`
  if (leveled) text += `\n（动手的次数够了。制作升到了 ${skillLevel(state.skills.craft)} 级。）`
  const grounded = groundChoices(text, nextChoices, state)
  state.lastEvent = { text: grounded.text, choices: grounded.choices }
  state.log.push({
    turn: state.turn,
    kind: 'upgrade',
    text: state.lastEvent.text,
    chosen: `（在 ${shelter.name} 加固：${slot.label}）`,
    day: state.day,
    time: formatClock(state.minute),
    weather: weatherLogLabel(state),
    used: slot.label,
    target: shelter.name,
  })
  applyMemoryAndTimeline(state, raw)

  if (raw.isEnding) {
    state.over = true
    state.ending = {
      title: String(raw.endingTitle || '终局').slice(0, 30),
      text: String(raw.endingText || text).slice(0, 2000),
    }
  }
  const cause = pendingEndingCause(state)
  if (cause) await forceEnding(state, cause)

  state.updatedAt = Date.now()
  saveSession(state)
  return publicState(state)
}

/** 归一化「使用对象」：自己 / 就地使用 / 同行者姓名；非法值一律回落到「自己」 */
function normalizeTarget(state, target) {
  const t = String(target || '').trim()
  if (t === TARGET_HERE) return TARGET_HERE
  if (t && t !== TARGET_SELF && state.allies.some((a) => a.name === t)) return t
  return TARGET_SELF
}

export function getGame(id) {
  const state = loadSession(id)
  if (!state) throw new GameError('存档不存在或已过期', 404)
  return publicState(state)
}

export function deleteGame(id) {
  return deleteSession(id)
}

export function latestGame() {
  const s = latestSession()
  return s ? publicState(s) : null
}
