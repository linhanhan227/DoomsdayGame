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

/** 两个地图点之间的赶路耗时。网格一格大约 1 小时，夜里再加半小时。 */
export function travelPlan(state, destName, isNight) {
  const nodes = state?.mapNodes || []
  const here = nodes.find((n) => n.name === state.location)
  const dest = nodes.find((n) => n.name === destName)
  if (!here || !dest || here.name === dest.name) return null
  const dist = Math.hypot(Number(dest.x) - Number(here.x), Number(dest.y) - Number(here.y))
  let hours = Math.max(0.5, Math.min(4, Math.round((dist / 112) * 2) / 2))
  if (isNight) hours = Math.min(4, hours + 0.5)
  return {
    dest: dest.name,
    hours,
    stamina: Math.max(4, Math.round(hours * 8)),
  }
}
