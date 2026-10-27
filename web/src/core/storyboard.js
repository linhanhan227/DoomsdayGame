/**
 * 像素分镜（Pixel Storyboard）· 数据层
 * ------------------------------------------------------------------
 * AI 每回合在剧情 JSON 里给出 pixelStoryboard（恰好 2 个分镜），前端把它
 * 绘制成 Canvas 像素剧情动画：先播动画，播完（或跳过）才显示选项。
 *
 * 职责边界：
 *   · 模型只"描述"画面：场景 / 动作 / 镜头 / 情绪 / 出场人物 / 可见物件 /
 *     光源 / 背景人群 / 环境破损度 / 主角朝向 / 时长——全部来自本回合正文；
 *   · 这里负责把模型输出**归一化**成可安全渲染的数据：白名单枚举、
 *     字数与时长截断、缺失字段按状态快照与叙事正文推断；
 *   · 模型没给分镜（旧存档、漏字段、离线通道）时，从叙事正文自动推导兜底分镜
 *     （含从正文关键词提取物件、光源、人群），保证"每回合先动画后选项"不中断。
 *
 * 渲染层（core/pixel-scene.js + components/PixelStoryPlayer.jsx）只绘制
 * 这里给出的数据，不执行模型返回的任何代码或地址。
 */

const SETTINGS = ['street', 'corridor', 'room', 'rooftop', 'forest', 'station', 'store']
const ACTIONS = ['idle', 'walk', 'run', 'search', 'talk', 'hide', 'fight', 'rest']
const CAMERAS = ['wide', 'push-in', 'pan-left', 'pan-right']
const MOODS = ['quiet', 'tense', 'danger', 'hope']
const FOCUSES = ['none', 'door', 'window', 'car', 'supplies', 'fire', 'stairs']
const ROLES = ['protagonist', 'ally', 'stranger', 'infected']
const WEATHERS = ['clear', 'cloudy', 'overcast', 'fog', 'rain', 'storm', 'thunder', 'snow', 'blizzard']
const LIGHTS = ['none', 'lamp', 'fire', 'flashlight']
const DAMAGES = ['intact', 'damaged', 'ruined']
/** 正文物件 → 画面道具的白名单（与 pixel-scene.js 的 PROP_KEYS 一致） */
const PROPS = ['fire', 'corpse', 'car', 'barricade', 'gun', 'medkit', 'food', 'water', 'flashlight', 'radio', 'map', 'crowbar']

const SHOT_MIN_MS = 1800
const SHOT_MAX_MS = 5000
const DEFAULT_SHOT_MS = 3000
const TOTAL_MAX_MS = 7000
const CAST_MAX = 3
const PROPS_MAX = 3
const CROWD_MAX = 8

function pickEnum(value, list, fallback) {
  const v = String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
  return list.includes(v) ? v : fallback
}

function clipText(v, max) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function clampDuration(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return DEFAULT_SHOT_MS
  return Math.max(SHOT_MIN_MS, Math.min(SHOT_MAX_MS, n))
}

/** 物件清单：白名单过滤 + 去重 + 最多 3 个；空缺时用兜底 */
function normalizeProps(rawProps, fallbackProps) {
  const list = (Array.isArray(rawProps) ? rawProps : [])
    .map((v) => clipText(v, 20).toLowerCase())
    .filter((v) => PROPS.includes(v))
  const out = [...new Set(list)].slice(0, PROPS_MAX)
  if (out.length) return out
  return (Array.isArray(fallbackProps) ? fallbackProps : [])
    .filter((v) => PROPS.includes(v))
    .slice(0, PROPS_MAX)
}

/** 背景人群数量：0-8 收口 */
function clampCrowd(v, fallbackCrowd = 0) {
  const n = Math.round(Number(v))
  if (Number.isFinite(n)) return Math.max(0, Math.min(CROWD_MAX, n))
  const f = Math.round(Number(fallbackCrowd))
  return Number.isFinite(f) ? Math.max(0, Math.min(CROWD_MAX, f)) : 0
}

/** 人物名单：白名单角色 + 最多 3 人 + 主角必须在场 */
function normalizeCast(rawCast, heroName) {
  const list = Array.isArray(rawCast) ? rawCast : []
  const out = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const name = clipText(c.name, 12)
    if (!name) continue
    out.push({ name, role: pickEnum(c.role, ROLES, 'stranger') })
    if (out.length >= CAST_MAX) break
  }
  // 主角必须在场：模型漏写时补上（渲染层按 cast 画人，缺主角画面就空了）
  if (!out.some((c) => c.role === 'protagonist')) {
    out.unshift({ name: heroName, role: 'protagonist' })
    if (out.length > CAST_MAX) out.length = CAST_MAX
  }
  return out
}

/** 单个分镜归一化：任何非法值都落到安全默认，绝不抛错 */
function normalizeShot(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const fb = fallback || {}
  return {
    caption: clipText(src.caption, 26) || clipText(fb.caption, 26),
    setting: pickEnum(src.setting, SETTINGS, pickEnum(fb.setting, SETTINGS, 'street')),
    action: pickEnum(src.action, ACTIONS, pickEnum(fb.action, ACTIONS, 'idle')),
    camera: pickEnum(src.camera, CAMERAS, pickEnum(fb.camera, CAMERAS, 'wide')),
    mood: pickEnum(src.mood, MOODS, pickEnum(fb.mood, MOODS, 'tense')),
    focus: pickEnum(src.focus, FOCUSES, pickEnum(fb.focus, FOCUSES, 'none')),
    cast: normalizeCast(src.cast, fb.heroName || ''),
    props: normalizeProps(src.props, fb.props),
    crowd: clampCrowd(src.crowd, fb.crowd),
    light: pickEnum(src.light, LIGHTS, pickEnum(fb.light, LIGHTS, 'none')),
    damage: pickEnum(src.damage, DAMAGES, pickEnum(fb.damage, DAMAGES, 'damaged')),
    direction: pickEnum(src.direction, ['left', 'right'], pickEnum(fb.direction, ['left', 'right'], 'right')),
    durationMs: clampDuration(src.durationMs),
  }
}

/** 两幕总时长收口：超出上限时逐段削最长的一幕，兜底永不低于单幕下限 */
function capTotalDuration(shots) {
  const total = () => shots.reduce((s, x) => s + x.durationMs, 0)
  let guard = 40
  while (total() > TOTAL_MAX_MS && guard-- > 0) {
    const longest = shots.reduce((a, b) => (b.durationMs > a.durationMs ? b : a))
    if (longest.durationMs <= SHOT_MIN_MS + 200) break
    longest.durationMs = Math.max(SHOT_MIN_MS, longest.durationMs - 200)
  }
  return shots
}

/* ---------------------------- 兜底推导（模型没给分镜时） ---------------------------- */

/** 按句末标点切句（不用正则后行断言，兼容旧内核） */
function splitSentences(text) {
  const out = []
  let buf = ''
  for (const ch of String(text || '').replace(/\s+/g, ' ')) {
    buf += ch
    if ('。！？!?…'.includes(ch)) {
      out.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(Boolean)
}

const SETTING_HINTS = [
  ['corridor', /医院|急诊|病房|诊室|走廊|护士|住院|诊所|卫生室|挂号/],
  ['station', /车站|地铁|站台|公交|火车|机场|码头|隧道/],
  ['store', /店|超市|商场|药房|药店|仓库|货架|柜台|市场/],
  ['rooftop', /楼顶|天台|屋顶|塔吊/],
  ['forest', /树林|林子|森林|公园|田野|山上|野外|草地|河边/],
  ['room', /屋|家|厨房|卧室|值班室|出租|公寓|宾馆|旅馆|地下室|室内/],
]

const ACTION_HINTS = [
  ['run', /跑|逃|追|冲|奔/],
  ['hide', /躲|藏|屏住|蹲|趴|缩在|潜/],
  ['fight', /搏|挥|砸|砍|刺|开枪|射击|扭打/],
  ['search', /搜|翻|找|摸|掏/],
  ['talk', /说|喊|问|答|开口|聊|谈|交涉|商量/],
  ['rest', /睡|躺|合眼|歇|休息|喘/],
  ['walk', /走|赶路|前往|迈|挪|穿过/],
]

/** 正文关键词 → 可绘制的画面物件（与渲染器道具库一一对应） */
const PROP_HINTS = [
  ['fire', /火堆|生火|篝火|火光|点火|火烧/],
  ['corpse', /尸体|遗体|死尸|半具|尸斑/],
  ['car', /面包车|轿车|卡车|公交|警车|救护车|汽车|一辆车/],
  ['barricade', /路障|障碍|拒马|封死的|堆起的/],
  ['gun', /枪|手枪|步枪|猎枪|霰弹/],
  ['medkit', /药|绷带|纱布|急救|抗生素|试剂盒/],
  ['food', /罐头|食物|饼干|干粮|吃的|口粮/],
  ['water', /水壶|水瓶|瓶装水|饮用水|半瓶水|杯子里的水/],
  ['flashlight', /手电|电筒/],
  ['radio', /收音机|电台|对讲机/],
  ['map', /地图|图纸|示意图|路线图/],
  ['crowbar', /撬棍|铁棍|扳手|匕首|刀/],
]

function settingOf(text) {
  for (const [key, re] of SETTING_HINTS) if (re.test(text)) return key
  return 'street'
}

function actionOf(text) {
  for (const [key, re] of ACTION_HINTS) if (re.test(text)) return key
  return 'idle'
}

function moodOf(text) {
  if (/尸|血|咬|嘶吼|枪|逼近|扑|威胁|危险|火|塌/.test(text)) return 'danger'
  if (/亮|光|灯|笑|活|救|信号|天亮|呼应/.test(text)) return 'hope'
  if (/门|响|动静|黑|风|影子|寂静/.test(text)) return 'tense'
  return 'quiet'
}

function focusOf(text) {
  if (/门/.test(text)) return 'door'
  if (/窗/.test(text)) return 'window'
  if (/车/.test(text)) return 'car'
  if (/火/.test(text)) return 'fire'
  if (/梯|阶/.test(text)) return 'stairs'
  if (/药|食物|罐头|水|弹|枪|包|物资/.test(text)) return 'supplies'
  return 'none'
}

/** 从一段正文里提取最多 3 个可绘制物件 */
function propsOf(text) {
  const out = []
  for (const [key, re] of PROP_HINTS) {
    if (re.test(text) && !out.includes(key)) out.push(key)
    if (out.length >= PROPS_MAX) break
  }
  return out
}

/** 光源：正文里真实出现的才画（火 > 手电 > 灯） */
function lightOf(text, props) {
  if ((props || []).includes('fire') || /火堆|篝火|火光|点火/.test(text)) return 'fire'
  if (/手电|电筒|手电筒/.test(text)) return 'flashlight'
  if (/灯|灯光|路灯|应急灯|日光灯/.test(text)) return 'lamp'
  return 'none'
}

/** 背景人群/尸群：正文提到成群的人或尸才给数量（确定性伪随机，避免每次重绘跳变） */
function crowdOf(text) {
  if (!/尸群|尸潮|人群|一群|成群|一群人|幸存者们| Cluster /i.test(text)) return 0
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0
  return 2 + (h % 4)
}

/** 主角朝向：正文写明向左才朝左，其余默认朝右 */
function directionOf(text) {
  return /向左|往左|朝左|左转/.test(text) ? 'left' : 'right'
}

/** 环境破损度：与引擎的【崩塌时间线】天数对应 */
function damageOf(day) {
  const d = Math.max(1, Number(day) || 1)
  if (d <= 2) return 'intact'
  if (d <= 9) return 'damaged'
  return 'ruined'
}

/** 从叙事正文推导两幕兜底分镜（前半句 → 第一幕，后半句 → 第二幕，各自提取物件/光源/人群） */
function deriveShots(text, env, heroName) {
  const sentences = splitSentences(text)
  const mid = Math.max(1, Math.ceil(sentences.length / 2))
  const firstHalf = sentences.slice(0, mid).join(' ') || '你在末日中前行'
  const secondHalf = sentences.slice(mid).join(' ') || firstHalf
  const sample = sentences.join(' ')
  const base = {
    setting: settingOf(sample),
    action: actionOf(sample),
    mood: moodOf(sample),
    focus: focusOf(sample),
    damage: env.damage,
  }
  const shotOf = (part, caption, camera, durationMs) => {
    const props = propsOf(part)
    return {
      caption: clipText(caption, 20) || '末日现场',
      ...base,
      camera,
      cast: normalizeCast([], heroName),
      props,
      crowd: crowdOf(part),
      light: lightOf(part, props),
      direction: directionOf(part),
      durationMs,
    }
  }
  return [
    shotOf(firstHalf, sentences[0] || '', 'wide', 3000),
    shotOf(secondHalf, sentences[sentences.length - 1] || sentences[0] || '', 'push-in', 3200),
  ]
}

/* ---------------------------- 对外入口 ---------------------------- */

/**
 * 归一化一回合的像素分镜。
 * @param raw  模型原始回包（读 raw.pixelStoryboard；正文取 narration / narrative）
 * @param state 引擎状态快照（昼夜 / 天气 / 地点 / 主角名 / 崩塌天数以引擎为准）
 */
export function normalizeStoryboard(raw, state = {}) {
  const minute = Number(state.minute)
  const night = Number.isFinite(minute) ? nightOf(minute) : true
  const weather = WEATHERS.includes(state.weather?.kind) ? state.weather.kind : 'overcast'
  const location = clipText(state.location, 40) || '未知地点'
  const heroName = clipText(state.protagonist?.name, 12) || '你'
  const damage = damageOf(state.day)
  const text = String((raw && (raw.narration || raw.narrative)) || '')
  const env = { night, weather, location, damage }

  const derived = deriveShots(text, env, heroName)
  const rawShots = raw && raw.pixelStoryboard && Array.isArray(raw.pixelStoryboard.shots)
    ? raw.pixelStoryboard.shots.filter(Boolean)
    : []

  const shots = capTotalDuration([
    normalizeShot(rawShots[0], { ...derived[0], heroName }),
    normalizeShot(rawShots[1] || derived[1], { ...derived[1], heroName }),
  ])

  return { version: 1, ...env, shots }
}

/** 昼夜判定（与引擎 prompt.js 的 DUSK/NIGHT 阈值一致，独立实现避免循环依赖） */
function nightOf(minute) {
  const m = ((Number(minute) % 1440) + 1440) % 1440
  return m >= 18 * 60 || m < 6 * 60
}
