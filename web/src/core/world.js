/**
 * 可数的世界规则：约定、赶路、伤口、同行者。
 * 不调用模型，也不碰存档。引擎负责把结果写进状态。
 */

export function absMinute(state) {
  const day = Math.max(1, Math.floor(Number(state?.day) || 1))
  const minute = Math.max(0, Math.floor(Number(state?.minute) || 0))
  return (day - 1) * 1440 + minute
}

export function isWoundName(name) {
  return /伤|咬|流血|骨折|扭|烫|划/.test(String(name || ''))
}

/** 新伤登记，已经包扎或不在状况列表里的伤删掉 */
export function syncWounds(state) {
  if (!Array.isArray(state.wounds)) state.wounds = []
  const names = new Set((state.conditions || []).map((c) => String(c)))
  for (const name of names) {
    if (!isWoundName(name)) continue
    if (!state.wounds.some((w) => w.name === name)) {
      state.wounds.push({ name, hours: 0, tended: false })
    }
  }
  state.wounds = state.wounds.filter((w) => names.has(w.name))
}

/**
 * 没包扎的伤每满 4 小时掉 3 点生命。咬伤额外加 2 点感染。
 * 返回本段实际造成的变化，供日志使用。
 */
export function tickWounds(state, hours) {
  const h = Number(hours) || 0
  if (h <= 0) return { hp: 0, infection: 0, notes: [] }
  syncWounds(state)
  let hp = 0
  let infection = 0
  const notes = []
  for (const w of state.wounds) {
    if (w.tended) {
      w.hours += h
      continue
    }
    const before = Math.floor((w.hours || 0) / 4)
    w.hours = (w.hours || 0) + h
    const steps = Math.floor(w.hours / 4) - before
    if (steps <= 0) continue
    hp -= steps * 3
    notes.push(`${w.name}又裂开了`)
    if (/咬/.test(w.name)) {
      infection += steps * 2
      notes.push('咬伤往里走')
    }
  }
  return { hp, infection, notes }
}

export function tendWounds(state) {
  syncWounds(state)
  for (const w of state.wounds) w.tended = true
}

export function syncAllies(state) {
  for (const a of state.allies || []) {
    if (!a || !a.name) continue
    if (a.hunger === undefined || a.hunger === null) a.hunger = 20
    if (a.infection === undefined || a.infection === null) a.infection = 0
    a.hunger = Math.max(0, Math.min(100, Math.round(Number(a.hunger) || 0)))
    a.infection = Math.max(0, Math.min(100, Math.round(Number(a.infection) || 0)))
    if (a.infection < 15 && /咬|感染|尸/.test(`${a.status || ''}${a.note || ''}`)) a.infection = 15
  }
}

/**
 * 同行者随时间变饿。已经感染的人继续尸化，到 100 离队。
 * 饥饿到顶只记一笔，不直接把人删掉。
 */
export function tickAllies(state, hours) {
  const h = Number(hours) || 0
  const notes = []
  const removed = []
  if (h <= 0) return { notes, removed }
  syncAllies(state)
  for (const a of [...(state.allies || [])]) {
    a.hunger = Math.min(100, a.hunger + Math.round(h * 4))
    if (a.hunger >= 100) notes.push(`${a.name}饿得快站不住`)
    if (a.infection > 0) {
      a.infection = Math.min(100, a.infection + Math.round(h * 3))
      if (a.infection >= 100) {
        removed.push(a.name)
        notes.push(`${a.name}在你身边尸化了`)
      }
    }
  }
  if (removed.length) {
    state.allies = state.allies.filter((a) => !removed.includes(a.name))
  }
  return { notes, removed }
}

export function feedAlly(state, name) {
  syncAllies(state)
  const ally = (state.allies || []).find((a) => a.name === name)
  if (!ally) return { ok: false, reason: '这个人不在身边' }
  const food = (state.inventory || []).find((i) => i && i.category === '食物' && Number(i.qty) > 0)
  if (!food) return { ok: false, reason: '背包里没有能分的食物' }
  food.qty = Number(food.qty) - 1
  ally.hunger = Math.max(0, ally.hunger - 40)
  return { ok: true, food: food.name, hunger: ally.hunger }
}

export function addAppointment(state, raw) {
  if (!Array.isArray(state.appointments)) state.appointments = []
  const who = String(raw?.who || raw?.name || '').trim().slice(0, 24)
  const note = String(raw?.note || '').trim().slice(0, 40)
  let inHours = Number(raw?.inHours)
  if (!Number.isFinite(inHours)) inHours = 8
  inHours = Math.max(1, Math.min(48, inHours))
  if (!who || !note) return null
  const open = state.appointments.filter((a) => a.status === 'open')
  if (open.length >= 3) return null
  if (open.some((a) => a.who === who && a.note === note)) return null
  const item = {
    id: `${absMinute(state)}-${who}`,
    who,
    note,
    due: absMinute(state) + Math.round(inHours * 60),
    status: 'open',
  }
  state.appointments.push(item)
  if (state.appointments.length > 8) {
    state.appointments = state.appointments.filter((a) => a.status === 'open').slice(-3)
  }
  return item
}

/** 到点仍 open 的可以赴约；超过 2 小时还没去，记成爽约 */
export function tickAppointments(state) {
  const now = absMinute(state)
  const missed = []
  for (const a of state.appointments || []) {
    if (a.status !== 'open') continue
    if (now >= a.due + 120) {
      a.status = 'missed'
      missed.push(a)
    }
  }
  return missed
}

export function dueAppointment(state) {
  const now = absMinute(state)
  return (state.appointments || []).find((a) => a.status === 'open' && now >= a.due) || null
}

export function appointmentLines(state) {
  const now = absMinute(state)
  return (state.appointments || [])
    .filter((a) => a.status !== 'kept')
    .slice(-3)
    .map((a) => {
      if (a.status === 'missed') return `${a.who}：${a.note}（你没去）`
      const left = a.due - now
      if (left <= 0) return `${a.who}：${a.note}（到点了）`
      const h = Math.max(1, Math.round(left / 60))
      return `${a.who}：${a.note}（约 ${h} 小时后）`
    })
}

const LOUD_NAME = /枪|开火|瓶|爆|砸|锤|砍|叫|喊|玻璃/
const QUIET_WEATHER = /雨|雷|雪|雾/

/** 一件物品占多少负重。数量多的小东西按件算，单件大东西按 2。 */
export function itemWeight(item) {
  if (!item) return 0
  const qty = Math.max(1, Math.floor(Number(item.qty) || 1))
  if (/箱|柜|桶|床|门|柜/.test(item.name || '')) return 2 * qty
  return qty
}

export function carryOf(state) {
  const load = (state?.inventory || []).reduce((sum, it) => sum + itemWeight(it), 0)
  const cap = 12 + ((state?.upgrades && Object.values(state.upgrades).some((u) => u && u.storage)) ? 4 : 0)
  return { load, cap, over: load > cap }
}

export function dropItem(state, name) {
  const item = (state.inventory || []).find((i) => i && i.name === name)
  if (!item) return { ok: false, reason: '背包里没有这件东西' }
  item.qty = (Number(item.qty) || 1) - 1
  return { ok: true, name: item.name }
}

/** 这一下有多响。雨、雪、雾、雷会盖掉一部分。 */
export function noiseOf(kind, itemName, weatherLabel) {
  let n = 1
  if (kind === 'scavenge') n = 3
  else if (kind === 'craft' || kind === 'upgrade') n = 3
  else if (kind === 'use' && LOUD_NAME.test(itemName || '')) n = 5
  else if (kind === 'use') n = 1
  else if (kind === 'fire') n = 2
  if (QUIET_WEATHER.test(weatherLabel || '')) n = Math.max(0, n - 2)
  return n
}

export function addNoise(state, amount) {
  const n = Math.max(0, Math.round(Number(amount) || 0))
  state.noise = Math.max(0, Math.min(10, Math.round(Number(state.noise) || 0) + n))
  return state.noise
}

/** 每过一小时，声响掉 1。掉到 0 就不再被人听见。 */
export function tickNoise(state, hours) {
  const steps = Math.floor(Number(hours) || 0)
  if (steps <= 0) return state.noise || 0
  state.noise = Math.max(0, Math.round(Number(state.noise) || 0) - steps)
  return state.noise
}

export function noiseLine(state) {
  const n = Math.round(Number(state?.noise) || 0)
  if (n <= 0) return '安静'
  if (n <= 3) return '有一点动静'
  if (n <= 6) return '外面听得见'
  return '很响，会把东西引过来'
}

const FUEL_NEED = { label: '燃料', category: '杂物', keys: ['柴', '木', '纸', '油', '炭'] }

export function fuelNeed() {
  return FUEL_NEED
}

/** 夜里有火的落脚点，每过一夜烧一份燃料。没有就灭。 */
export function burnFires(state, crossedNight, pick) {
  const notes = []
  if (!crossedNight) return notes
  const upgrades = state.upgrades || {}
  for (const [place, u] of Object.entries(upgrades)) {
    if (!u?.fire) continue
    const spent = typeof pick === 'function' ? pick(state, [FUEL_NEED]) : null
    if (spent) notes.push(`${place}的火还在`)
    else {
      u.fire = 0
      notes.push(`${place}的火灭了`)
    }
  }
  return notes
}

export function rememberDeath(state) {
  const who = String(state?.protagonist?.name || '一个没留下名字的人').slice(0, 12)
  const where = String(state?.location || '不知道的地方').slice(0, 16)
  const title = String(state?.ending?.title || '死在这里').slice(0, 8)
  return `${who}死在${where}，${title}`.slice(0, 40)
}

/** 两个地图点之间的赶路耗时。网格一格大约 1 小时，夜里再加半小时。 */
export function travelPlan(state, destName, isNight) {
  const nodes = state?.mapNodes || []
  const here = nodes.find((n) => n.name === state.location)
  const dest = nodes.find((n) => n.name === destName)
  if (!here || !dest || here.name === dest.name) return null
  const dist = Math.hypot(Number(dest.x) - Number(here.x), Number(dest.y) - Number(here.y))
  let hours = Math.max(0.5, Math.min(4, Math.round((dist / 112) * 2) / 2))
  if (isNight) hours = Math.min(4, hours + 0.5)
  if (carryOf(state).over) hours = Math.min(4, hours + 0.5)
  return {
    dest: dest.name,
    hours,
    stamina: Math.max(4, Math.round(hours * 8)),
  }
}
