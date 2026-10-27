/** Pure, deterministic pixel-art layer. Captions and playback belong to the caller. */
const WIDTH = 480
const HEIGHT = 270
const VALUES = {
  setting: ['street', 'corridor', 'room', 'rooftop', 'forest', 'station', 'store'],
  action: ['idle', 'walk', 'run', 'search', 'talk', 'hide', 'fight', 'rest'],
  camera: ['wide', 'push-in', 'pan-left', 'pan-right'],
  mood: ['quiet', 'tense', 'danger', 'hope'],
  focus: ['none', 'door', 'window', 'car', 'supplies', 'fire', 'stairs'],
  weather: ['clear', 'cloudy', 'overcast', 'fog', 'rain', 'storm', 'thunder', 'snow', 'blizzard'],
  role: ['protagonist', 'ally', 'stranger', 'infected'],
  light: ['none', 'lamp', 'fire', 'flashlight'],
  damage: ['intact', 'damaged', 'ruined'],
}
/** 正文物件 → 画面道具的白名单（每个都有对应的像素画法） */
const PROP_KEYS = ['fire', 'corpse', 'car', 'barricade', 'gun', 'medkit', 'food', 'water', 'flashlight', 'radio', 'map', 'crowbar']
const PALETTES = {
  night: { sky: '#111c2b', horizon: '#30434e', far: '#1c2d39', wall: '#2a3943', lit: '#3d5058',
    shade: '#17252e', ground: '#29383c', edge: '#617478', glass: '#718d92', leaf: '#304a42',
    leafLit: '#536757', ink: '#0c171f', lamp: '#b7a27b', fog: '#91a6ab' },
  day: { sky: '#82969d', horizon: '#b2b9ae', far: '#627982', wall: '#62767b', lit: '#82928e',
    shade: '#3d535d', ground: '#596966', edge: '#9da9a0', glass: '#b3c7c3', leaf: '#4b6a59',
    leafLit: '#778b68', ink: '#293c46', lamp: '#c8b891', fog: '#c0cecc' },
}
const APERTURES = { corridor: [350, 48, 102, 72], room: [52, 42, 134, 91], store: [40, 64, 135, 87] }
const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const pick = (key, value) => VALUES[key].includes(value) ? value : VALUES[key][0]

function normalize(scene) {
  const source = scene && typeof scene === 'object' ? scene : {}
  const result = Object.fromEntries(Object.keys(VALUES).filter((key) => key !== 'role').map((key) => [key, pick(key, source[key])]))
  result.night = source.night !== false
  result.location = typeof source.location === 'string' ? source.location.slice(0, 160) : ''
  result.cast = (Array.isArray(source.cast) ? source.cast.slice(0, 4) : [])
    .filter((actor) => actor && typeof actor.name === 'string' && actor.name.trim())
    .map((actor) => ({ name: actor.name.trim().slice(0, 80), role: VALUES.role.includes(actor.role) ? actor.role : 'stranger' }))
  // 正文里的具体物件：白名单过滤 + 去重 + 最多 3 个
  result.props = (Array.isArray(source.props) ? source.props : [])
    .map((v) => String(v === undefined || v === null ? '' : v).trim().toLowerCase())
    .filter((v) => PROP_KEYS.includes(v))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3)
  // 背景人群/尸群数量与主角朝向
  const crowd = Math.round(Number(source.crowd))
  result.crowd = Number.isFinite(crowd) ? Math.max(0, Math.min(8, crowd)) : 0
  result.direction = source.direction === 'left' ? 'left' : 'right'
  return result
}

function hash(text) {
  let value = 2166136261
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
  return value >>> 0
}

function rect(ctx, color, x, y, width, height) {
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(0, Math.round(width)), Math.max(0, Math.round(height)))
}

// Scan-converted two-pixel polygons avoid antialiased canvas path edges.
function polygon(ctx, color, points) {
  const top = Math.floor(Math.min(...points.map((point) => point[1])))
  const bottom = Math.ceil(Math.max(...points.map((point) => point[1])))
  ctx.fillStyle = color
  for (let y = top; y < bottom; y += 2) {
    const intersections = []
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [ax, ay] = points[j], [bx, by] = points[i]
      if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) {
        intersections.push(ax + ((y + 0.5 - ay) * (bx - ax)) / (by - ay))
      }
    }
    intersections.sort((a, b) => a - b)
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const left = Math.round(intersections[i])
      ctx.fillRect(left, y, Math.max(0, Math.round(intersections[i + 1]) - left), Math.min(2, bottom - y))
    }
  }
}

function windows(ctx, p, x, y, columns, rows, seed, gap = 17) {
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < columns; col += 1) {
    const value = (seed + col * 11 + row * 7) % 19
    const wx = x + col * gap, wy = y + row * 22
    rect(ctx, p.ink, wx - 1, wy - 1, 10, 14)
    rect(ctx, value < 2 ? p.lamp : p.shade, wx, wy, 8, 11)
    rect(ctx, p.lit, wx, wy + 11, 10, 2)
    if (value === 4) { rect(ctx, p.edge, wx + 2, wy + 2, 2, 3); rect(ctx, p.ink, wx + 4, wy + 5, 4, 3) }
  }
}

function backdrop(ctx, s, p, seed, time) {
  rect(ctx, p.sky, -64, -40, 608, 340)
  rect(ctx, p.horizon, -64, 104, 608, 100)
  rect(ctx, p.far, -64, 149, 608, 55)
  if (s.weather === 'clear') {
    rect(ctx, s.night ? '#9eada9' : '#cbc5a8', 386, 29, 14, 12)
    rect(ctx, p.sky, 382, 27, 10, 9)
    if (s.night) for (let i = 0; i < 13; i += 1) rect(ctx, p.edge, (seed % 67 + i * 83) % 480, 14 + i * 13 % 63, 1, 1)
  } else {
    const drift = Math.floor(time * 1.5) % 96
    for (let i = -1; i < 7; i += 1) {
      rect(ctx, p.far, i * 96 + drift, 24 + i * i % 4 * 11, 100, 10)
      rect(ctx, p.far, i * 96 + drift + 16, 18 + i * i % 4 * 11, 58, 8)
    }
  }
  for (let i = -1; i < 12; i += 1) {
    const value = hash(`${seed}:${i}`), x = i * 51, h = 35 + value % 71
    if (s.setting === 'forest') {
      rect(ctx, p.far, x + 22, 86, 7, 118)
      polygon(ctx, p.shade, [[x - 9, 153], [x + 25, 43 + value % 32], [x + 58, 153]])
    } else {
      rect(ctx, i % 2 ? p.far : p.shade, x, 181 - h, 45, h)
      rect(ctx, p.far, x + 9, 173 - h, 21, 9)
      if (i % 3 === 0) rect(ctx, p.edge, x + 23, 158 - h, 1, 16)
      for (let j = 0; j < 4; j += 1) rect(ctx, p.lit, x + 8 + j * 8, 191 - h, 2, 3)
    }
  }
}

function environment(ctx, s, p, seed) {
  rect(ctx, p.ground, -64, 196, 608, 90)
  if (APERTURES[s.setting]) {
    rect(ctx, p.wall, -64, -24, 608, 221)
    rect(ctx, p.shade, -64, 129, 608, 65)
    rect(ctx, p.edge, -64, 127, 608, 3)
    const [x, y, w, h] = APERTURES[s.setting]
    rect(ctx, p.ink, x - 5, y - 5, w + 10, h + 10)
    rect(ctx, p.sky, x, y, w, h)
    rect(ctx, p.far, x, y + h - 25, w, 25)
    rect(ctx, p.lit, x + w / 2, y, 4, h)
    rect(ctx, p.lit, x, y + h / 2, w, 3)
    rect(ctx, p.edge, x - 6, y + h, w + 12, 4)
    polygon(ctx, p.lit, [[x, 196], [x + w, 196], [x + w + 52, 239], [x + 16, 239]])
  }
  switch (s.setting) {
    case 'street':
      for (const [x, y, w, h] of [[-28, 54, 137, 145], [116, 81, 111, 118], [375, 42, 132, 157]]) {
        rect(ctx, p.wall, x, y, w, h); rect(ctx, p.lit, x, y, w, 5)
        rect(ctx, p.shade, x + w - 12, y + 5, 12, h - 5)
        windows(ctx, p, x + 14, y + 17, 5, 4, seed + x)
        rect(ctx, p.ink, x + 20, 162, 35, 37)
        rect(ctx, p.lit, x + 17, 156, 42, 6)
      }
      rect(ctx, p.shade, -20, 196, 540, 9)
      rect(ctx, p.edge, -20, 196, 540, 2)
      for (let x = -20; x < 540; x += 92) rect(ctx, p.lit, x, 241, 44, 3)
      rect(ctx, p.ink, 78, 91, 4, 110); rect(ctx, p.ink, 78, 89, 28, 4)
      rect(ctx, p.lamp, 95, 93, 12, 3)
      ctx.globalAlpha = 0.09
      polygon(ctx, p.lamp, [[96, 99], [108, 99], [148, 207], [51, 207]])
      ctx.globalAlpha = 1
      break
    case 'corridor':
      polygon(ctx, p.lit, [[-32, 0], [176, 57], [304, 57], [512, 0]])
      rect(ctx, p.wall, 176, 57, 128, 138)
      rect(ctx, p.ink, 210, 86, 61, 109); rect(ctx, p.lit, 215, 90, 51, 102)
      rect(ctx, p.shade, 220, 99, 41, 34); rect(ctx, p.edge, 238, 90, 2, 101)
      rect(ctx, p.accent, 220, 65, 40, 10)
      rect(ctx, p.lamp, 228, 25, 26, 3); rect(ctx, p.lamp, 232, 48, 18, 2)
      for (const x of [24, 103, 315, 422]) {
        rect(ctx, p.ink, x, 138, 33, 58); rect(ctx, p.wall, x + 3, 142, 26, 52)
        rect(ctx, p.glass, x + 8, 147, 16, 16); rect(ctx, p.edge, x + 24, 175, 3, 2)
      }
      rect(ctx, p.accent, 67, 68, 22, 7); rect(ctx, p.accent, 75, 60, 6, 23)
      for (let x = -60; x < 570; x += 60) polygon(ctx, p.shade, [[240, 195], [x, 270], [x + 2, 270]])
      for (const y of [208, 228, 254]) rect(ctx, p.shade, -32, y, 544, 2)
      rect(ctx, p.edge, 58, 180, 63, 5); rect(ctx, p.lit, 62, 172, 51, 8)
      rect(ctx, p.ink, 64, 185, 3, 15); rect(ctx, p.ink, 109, 185, 3, 15)
      break
    case 'room':
      rect(ctx, p.lit, 26, 39, 17, 107); rect(ctx, p.lit, 195, 39, 17, 107)
      rect(ctx, p.shade, 230, 38, 74, 56); rect(ctx, p.lit, 235, 43, 64, 46)
      polygon(ctx, p.leaf, [[237, 84], [258, 57], [274, 73], [289, 60], [298, 85]])
      rect(ctx, p.ink, 43, 183, 112, 31); rect(ctx, p.leaf, 46, 169, 106, 33)
      rect(ctx, p.leafLit, 53, 177, 91, 16); rect(ctx, p.shade, 96, 176, 3, 18)
      rect(ctx, p.lit, 190, 183, 55, 6); rect(ctx, p.ink, 194, 189, 4, 23)
      rect(ctx, p.ink, 236, 189, 4, 23); rect(ctx, p.lamp, 206, 172, 12, 10)
      for (let y = 205; y < 270; y += 16) rect(ctx, p.shade, -32, y, 544, 1)
      break
    case 'rooftop':
      rect(ctx, p.wall, -32, 176, 544, 24); rect(ctx, p.edge, -32, 176, 544, 4)
      rect(ctx, p.wall, 28, 104, 113, 96); rect(ctx, p.lit, 23, 99, 123, 7)
      rect(ctx, p.ink, 64, 127, 43, 73); rect(ctx, p.shade, 68, 131, 35, 67)
      rect(ctx, p.lamp, 94, 164, 3, 3)
      rect(ctx, p.edge, 89, 42, 3, 57); rect(ctx, p.edge, 66, 53, 49, 2)
      rect(ctx, p.edge, 76, 65, 31, 2)
      rect(ctx, p.shade, 386, 157, 52, 42); rect(ctx, p.lit, 382, 152, 59, 7)
      for (let y = 164; y < 190; y += 6) rect(ctx, p.edge, 393, y, 36, 2)
      for (let x = 18; x < 480; x += 57) rect(ctx, p.shade, x, 219, 28, 2)
      break
    case 'forest':
      for (const [x, h] of [[32, 137], [115, 120], [398, 150], [460, 139]]) {
        rect(ctx, p.ink, x, 204 - h, 14, h)
        rect(ctx, p.wall, x + 9, 212 - h, 4, h - 8)
        polygon(ctx, p.leaf, [[x - 35, 153], [x + 7, 26], [x + 52, 153]])
        polygon(ctx, p.leafLit, [[x + 9, 64], [x + 26, 135], [x + 8, 120]])
      }
      polygon(ctx, p.lit, [[221, 191], [260, 191], [356, 270], [122, 270]])
      for (let i = 0; i < 42; i += 1) {
        const x = (i * 73 + seed % 41) % 480, y = 205 + i * 17 % 60
        if (x < 154 || x > 335) { rect(ctx, p.leaf, x, y, 12, 3); rect(ctx, p.leafLit, x + 4, y - 5, 2, 7) }
      }
      rect(ctx, p.shade, 58, 215, 72, 14); rect(ctx, p.wall, 61, 216, 11, 10)
      break
    case 'station':
      rect(ctx, p.wall, 65, 134, 340, 61); rect(ctx, p.lit, 65, 132, 340, 7)
      for (let x = 79; x < 400; x += 43) { rect(ctx, p.ink, x, 146, 32, 23); rect(ctx, p.glass, x + 3, 149, 26, 16) }
      rect(ctx, p.accent, 65, 177, 340, 4); rect(ctx, p.ink, 65, 190, 340, 8)
      rect(ctx, p.shade, -32, 85, 544, 14); rect(ctx, p.edge, -32, 84, 544, 3)
      for (const x of [21, 165, 445]) { rect(ctx, p.wall, x, 99, 8, 110); rect(ctx, p.lit, x, 99, 2, 110) }
      rect(ctx, p.ink, 255, 60, 88, 22); rect(ctx, p.accent, 263, 67, 50, 3)
      rect(ctx, p.edge, 263, 74, 32, 2); rect(ctx, p.lamp, 223, 62, 19, 19)
      rect(ctx, p.ink, 232, 65, 2, 8); rect(ctx, p.ink, 232, 71, 6, 2)
      rect(ctx, p.wall, 47, 192, 90, 5); rect(ctx, p.ink, 52, 197, 4, 13)
      rect(ctx, p.ink, 128, 197, 4, 13); rect(ctx, p.lamp, -32, 234, 544, 3)
      break
    case 'store':
      rect(ctx, p.lamp, 218, 25, 204, 18); rect(ctx, p.wall, 230, 31, 126, 4)
      rect(ctx, p.lit, 34, 55, 147, 8)
      for (let x = 40; x < 175; x += 24) rect(ctx, p.accent, x, 55, 10, 12)
      for (let row = 0; row < 3; row += 1) {
        const y = 68 + row * 39
        rect(ctx, p.ink, 224, y, 214, 30)
        for (let col = 0; col < 13; col += 1) if ((col + row + seed) % 5 !== 0) {
          rect(ctx, [p.leafLit, p.lamp, p.lit][col % 3], 230 + col * 16, y + 10 + col % 3 * 3, 9, 16 - col % 3 * 3)
          rect(ctx, p.edge, 232 + col * 16, y + 12 + col % 3 * 3, 5, 2)
        }
        rect(ctx, p.edge, 222, y + 30, 218, 3)
      }
      rect(ctx, p.shade, 41, 184, 124, 39); rect(ctx, p.lit, 37, 181, 132, 6)
      rect(ctx, p.ink, 105, 165, 27, 16); rect(ctx, p.glass, 109, 168, 18, 7)
      break
  }
  for (let i = 0; i < 17; i += 1) rect(ctx, i % 3 ? p.shade : p.lit, (seed % 37 + i * 97) % 480, 209 + i * 13 % 55, 3 + i % 6, 2)
}

function focusObject(ctx, s, p, time) {
  const x = 337, y = 220
  switch (s.focus) {
    case 'door':
      rect(ctx, p.wall, x - 9, y - 93, 69, 93); rect(ctx, p.ink, x, y - 88, 49, 88)
      rect(ctx, p.lit, x + 4, y - 84, 40, 82); rect(ctx, p.shade, x + 9, y - 75, 30, 39)
      rect(ctx, p.lamp, x + 34, y - 36, 4, 3); rect(ctx, p.accent, x + 7, y - 94, 35, 4)
      break
    case 'window':
      rect(ctx, p.wall, x - 14, 60, 111, 92); rect(ctx, p.ink, x - 8, 67, 99, 78)
      rect(ctx, p.sky, x - 4, 71, 91, 68); rect(ctx, p.far, x - 4, 114, 91, 25)
      rect(ctx, p.glass, x + 1, 76, 3, 29); rect(ctx, p.lit, x + 40, 71, 4, 68)
      rect(ctx, p.lit, x - 4, 104, 91, 4); rect(ctx, p.edge, x - 12, 143, 107, 5)
      polygon(ctx, p.edge, [[x + 77, 77], [x + 70, 91], [x + 80, 87]])
      break
    case 'car':
      polygon(ctx, p.ink, [[x - 18, y - 17], [x - 7, y - 33], [x + 11, y - 36], [x + 27, y - 61], [x + 70, y - 61], [x + 89, y - 35], [x + 107, y - 27], [x + 107, y - 7], [x - 18, y - 7]])
      rect(ctx, p.leaf, x - 13, y - 30, 114, 20)
      polygon(ctx, p.glass, [[x + 16, y - 36], [x + 31, y - 55], [x + 63, y - 55], [x + 78, y - 36]])
      rect(ctx, p.ink, x + 48, y - 56, 3, 25)
      for (const offset of [1, 77]) { rect(ctx, p.ink, x + offset, y - 17, 19, 20); rect(ctx, p.lit, x + offset + 5, y - 12, 9, 9) }
      rect(ctx, p.lamp, x + 93, y - 27, 8, 4); rect(ctx, p.edge, x - 14, y - 10, 117, 3)
      break
    case 'supplies':
      for (const [dx, dy, w] of [[-14, 0, 36], [24, 0, 34], [1, -23, 29]]) {
        rect(ctx, p.ink, x + dx, y - 26 + dy, w, 27); rect(ctx, p.wall, x + dx + 2, y - 24 + dy, w - 4, 23)
        rect(ctx, p.lamp, x + dx + w / 2 - 2, y - 24 + dy, 4, 23)
        rect(ctx, p.edge, x + dx + 5, y - 17 + dy, 8, 5)
      }
      rect(ctx, p.leafLit, x + 62, y - 21, 11, 21); rect(ctx, p.edge, x + 64, y - 25, 7, 5)
      break
    case 'fire': {
      ctx.globalAlpha = 0.12
      polygon(ctx, p.lamp, [[x - 36, y + 5], [x + 17, y - 22], [x + 74, y + 5]])
      ctx.globalAlpha = 1
      rect(ctx, p.ink, x - 3, y - 4, 43, 6); rect(ctx, p.wall, x + 1, y - 2, 36, 3)
      const bend = Math.round(Math.sin(time * 2) * 3)
      polygon(ctx, '#a87953', [[x + 2, y - 5], [x + 9, y - 25], [x + 18 + bend, y - 38], [x + 22, y - 22], [x + 32, y - 29], [x + 39, y - 5]])
      polygon(ctx, '#c3a875', [[x + 12, y - 5], [x + 22, y - 24], [x + 30, y - 5]])
      break
    }
    case 'stairs':
      for (let i = 0; i < 5; i += 1) {
        rect(ctx, p.shade, x + i * 17, y - (i + 1) * 12, 20, (i + 1) * 12)
        rect(ctx, p.edge, x + i * 17, y - (i + 1) * 12, 20, 3)
      }
      polygon(ctx, p.lit, [[x - 2, y - 40], [x + 89, y - 98], [x + 89, y - 94], [x - 2, y - 36]])
      rect(ctx, p.lit, x - 2, y - 37, 3, 37); rect(ctx, p.lit, x + 86, y - 96, 3, 39)
      break
  }
}

function person(ctx, actor, x, y, action, time, reduced, p, index, facing) {
  const seed = hash(actor.name), infected = actor.role === 'infected'
  const coat = ['#697e7a', '#857669', '#627b8e', '#8b8270', '#717082'][seed % 5]
  const skin = infected ? '#879381' : ['#c3a28b', '#a88672', '#d0b39a', '#907b6b'][seed % 4]
  const hair = ['#34302d', '#4e4036', '#252c32', '#6b6256'][(seed >>> 4) % 4]
  const moving = action === 'walk' || action === 'run'
  const phase = reduced ? 0 : Math.floor(time * (action === 'run' ? 8 : 5) + index) % 4
  const stride = moving ? (reduced ? 0 : [0, 1, 0, -1][phase]) * (action === 'run' ? 10 : 6) : 0
  const low = action === 'rest' ? 15 : action === 'hide' ? 12 : 0
  const lean = action === 'search' ? 7 : action === 'run' ? 4 : infected ? 3 : 0
  const bob = moving && !reduced && phase % 2 ? -2 : 0
  const top = -52 + low + bob, hip = -20 + low / 2 + bob
  ctx.save()
  ctx.translate(Math.round(x), Math.round(y)); ctx.scale(facing, 1)
  rect(ctx, p.ink, -16, 0, 34, 3)
  if (action === 'rest') { rect(ctx, p.wall, -13, -15, 25, 5); rect(ctx, p.ink, -11, -10, 3, 12); rect(ctx, p.ink, 9, -10, 3, 12) }
  const limb = (color, ax, ay, bx, by, width = 5) => polygon(ctx, color, [[ax - width / 2, ay], [ax + width / 2, ay], [bx + width / 2, by], [bx - width / 2, by]])
  for (const side of [-1, 1]) {
    const foot = side * 5 + stride * side
    const knee = low ? 13 + side * 3 : foot / 2
    limb(p.ink, side * 5, hip, knee, -9, 8); limb(p.ink, knee, -9, low ? knee - 2 : foot, 0, 7)
    limb('#48565d', side * 5, hip, knee, -9, 4)
    rect(ctx, p.ink, (low ? knee - 2 : foot) - 3, -2, 11, 4)
  }
  // Backpacks, hair and coat are name-seeded, never regenerated between frames.
  rect(ctx, p.ink, -14 + lean, top + 17, 10, 23)
  rect(ctx, infected ? p.shade : '#756e54', -13 + lean, top + 19, 8, 17)
  rect(ctx, p.edge, -12 + lean, top + 21, 5, 2)
  polygon(ctx, p.ink, [[-9 + lean, top + 14], [9 + lean, top + 14], [12, hip + 2], [-10, hip + 2]])
  polygon(ctx, coat, [[-7 + lean, top + 16], [7 + lean, top + 16], [9, hip], [-8, hip]])
  rect(ctx, p.edge, -7 + lean, top + 16, 3, 16); rect(ctx, p.ink, 3 + lean, top + 18, 2, 10)
  rect(ctx, p.ink, -7 + lean, top, 17, 17); rect(ctx, skin, -4 + lean, top + 4, 12, 11)
  rect(ctx, hair, -6 + lean, top + 1, 15, 5); rect(ctx, hair, -6 + lean, top + 4, 4, 8 + seed % 4)
  rect(ctx, skin, 8 + lean, top + 8, 3, 4); rect(ctx, p.ink, 5 + lean, top + 7, 2, 2)
  rect(ctx, p.lamp, -4 + lean, top + 1, 7, 1)
  rect(ctx, actor.role === 'protagonist' ? p.accent : coat, -5 + lean, top + 14, 14, 3)
  const gesture = !reduced && Math.sin(time * 2.5) > 0 ? 2 : 0
  let handX = 10 - stride / 2, handY = hip - 1
  if (action === 'search') { handX = 28; handY = top + 31 + gesture }
  if (action === 'talk') { handX = 19; handY = top + 23 - gesture }
  if (action === 'fight') { handX = 18; handY = top + 12 + gesture }
  if (action === 'hide' || action === 'rest') { handX = 16; handY = hip + 3 }
  limb(p.ink, 7 + lean, top + 21, handX - 2, handY, 7)
  limb(coat, 7 + lean, top + 21, handX - 2, handY, 4)
  rect(ctx, skin, handX - 2, handY - 2, 5, 5)
  if (action === 'fight') { limb(p.ink, -4 + lean, top + 22, 10, top + 18, 6); rect(ctx, skin, 9, top + 16, 5, 5) }
  ctx.restore()
}

function cast(ctx, s, p, time, progress, reduced) {
  const protagonist = Math.max(0, s.cast.findIndex((actor) => actor.role === 'protagonist'))
  const walking = s.action === 'walk' || s.action === 'run'
  const travel = walking ? (progress - 0.5) * (s.action === 'run' ? 92 : 68) : 0
  const leadX = s.action === 'search' && s.focus !== 'none' ? 304 : s.action === 'hide' ? 317 : 282
  let companion = 0, infected = 0
  const dirFacing = s.direction === 'left' ? -1 : 1
  const actors = s.cast.map((actor, index) => {
    const lead = index === protagonist
    const hostile = actor.role === 'infected' && !lead
    const x = hostile ? 387 + infected++ * 24 : lead ? leadX + travel : leadX - (++companion * 38) + travel
    const action = lead || (walking && !hostile) ? s.action : hostile && s.action === 'fight' ? 'fight' : 'idle'
    return { actor, index, x, y: lead ? 222 : 217 - index % 2 * 3, action, facing: hostile ? -1 : lead && s.action === 'talk' && s.cast.length > 1 ? -1 : dirFacing }
  })
  actors.sort((a, b) => a.y - b.y)
  for (const item of actors) person(ctx, item.actor, item.x, item.y, item.action, time, reduced, p, item.index, item.facing)
}

/* ------- 正文驱动的画面元素：物件道具 / 背景人群 / 破损度 / 光源 ------- */

const PROP_SLOTS = [70, 148, 218]
const GROUND_Y = 222

/** 单个物件道具的像素画法（位置钉在地面槽位，避开焦点与主角活动区） */
function drawProp(ctx, key, x, gy, p, t) {
  switch (key) {
    case 'fire': {
      ctx.globalAlpha = 0.12
      polygon(ctx, p.lamp, [[x - 14, gy + 2], [x + 12, gy - 18], [x + 36, gy + 2]])
      ctx.globalAlpha = 1
      rect(ctx, p.ink, x - 2, gy - 3, 26, 4)
      const bend = Math.round(Math.sin(t * 2.4) * 2)
      polygon(ctx, '#a87953', [[x, gy - 3], [x + 6, gy - 16], [x + 12 + bend, gy - 24], [x + 15, gy - 13], [x + 21, gy - 3]])
      polygon(ctx, '#c3a875', [[x + 7, gy - 3], [x + 13, gy - 15], [x + 19, gy - 3]])
      break
    }
    case 'corpse':
      polygon(ctx, p.shade, [[x, gy], [x + 2, gy - 9], [x + 26, gy - 12], [x + 40, gy - 4], [x + 40, gy]])
      rect(ctx, p.shade, x + 30, gy - 17, 11, 6)
      rect(ctx, p.ink, x + 5, gy - 7, 20, 2)
      break
    case 'car':
      polygon(ctx, p.ink, [[x - 4, gy - 8], [x - 4, gy - 16], [x + 5, gy - 25], [x + 21, gy - 25], [x + 29, gy - 37], [x + 52, gy - 37], [x + 63, gy - 24], [x + 68, gy - 17], [x + 68, gy - 8]])
      rect(ctx, p.leaf, x, gy - 21, 64, 12)
      polygon(ctx, p.glass, [[x + 23, gy - 24], [x + 31, gy - 34], [x + 49, gy - 34], [x + 56, gy - 24]])
      for (const wx of [10, 44]) { rect(ctx, p.ink, x + wx, gy - 13, 11, 11); rect(ctx, p.lit, x + wx + 2, gy - 11, 7, 7) }
      break
    case 'barricade':
      rect(ctx, p.wall, x - 2, gy - 26, 8, 26)
      rect(ctx, p.wall, x + 34, gy - 26, 8, 26)
      rect(ctx, p.shade, x - 8, gy - 21, 58, 6)
      rect(ctx, p.shade, x - 6, gy - 11, 54, 6)
      rect(ctx, p.ink, x + 6, gy - 30, 20, 8)
      break
    case 'gun':
      polygon(ctx, p.shade, [[x + 2, gy], [x + 30, gy - 29], [x + 34, gy - 26], [x + 6, gy]])
      rect(ctx, p.shade, x + 26, gy - 31, 9, 4)
      break
    case 'medkit':
      rect(ctx, p.ink, x, gy - 16, 26, 16)
      rect(ctx, p.wall, x + 2, gy - 14, 22, 12)
      rect(ctx, '#b15a4e', x + 10, gy - 13, 6, 10)
      rect(ctx, '#b15a4e', x + 8, gy - 11, 10, 6)
      break
    case 'food':
      rect(ctx, p.shade, x, gy - 12, 12, 12)
      rect(ctx, p.lamp, x + 2, gy - 8, 8, 3)
      rect(ctx, p.shade, x + 14, gy - 12, 12, 12)
      rect(ctx, p.shade, x + 7, gy - 22, 12, 10)
      break
    case 'water':
      rect(ctx, p.glass, x, gy - 18, 8, 18)
      rect(ctx, p.edge, x + 1, gy - 13, 6, 9)
      rect(ctx, p.glass, x + 10, gy - 12, 7, 12)
      rect(ctx, p.ink, x + 2, gy - 21, 4, 3)
      break
    case 'flashlight':
      rect(ctx, p.ink, x, gy - 4, 16, 5)
      rect(ctx, p.lamp, x + 14, gy - 5, 5, 7)
      break
    case 'radio':
      rect(ctx, p.ink, x, gy - 14, 24, 14)
      rect(ctx, p.shade, x + 2, gy - 12, 12, 10)
      rect(ctx, p.edge, x + 16, gy - 11, 5, 2)
      rect(ctx, p.ink, x + 20, gy - 26, 1, 12)
      rect(ctx, p.lamp, x + 19, gy - 27, 3, 2)
      break
    case 'map':
      polygon(ctx, p.lit, [[x, gy], [x + 3, gy - 10], [x + 20, gy - 12], [x + 26, gy - 3], [x + 24, gy]])
      rect(ctx, p.accent, x + 6, gy - 8, 13, 1)
      rect(ctx, p.accent, x + 8, gy - 5, 10, 1)
      break
    case 'crowbar':
      polygon(ctx, p.shade, [[x + 2, gy], [x + 18, gy - 30], [x + 22, gy - 29], [x + 6, gy]])
      rect(ctx, p.shade, x + 16, gy - 33, 9, 3)
      break
  }
}

/** 背景人群/尸群剪影（画在主角层之后排之前，永远处于背景） */
function crowdFigures(ctx, s, p, t, seed) {
  for (let i = 0; i < s.crowd; i += 1) {
    const v = hash(`${seed}:crowd${i}`)
    const x = 18 + (v % 441)
    const y = 214 - ((v >>> 5) % 10)
    const sway = Math.round(Math.sin(t * 1.4 + i * 1.7))
    const lean = v % 3 === 0 ? 3 : 0
    rect(ctx, p.shade, x + lean, y - 26 + sway, 8, 26)
    rect(ctx, p.shade, x + 1 + lean, y - 33 + sway, 6, 7)
    if (v % 4 === 0) rect(ctx, p.shade, x - 4, y - 20 + sway, 5, 2)
  }
}

/** 物件 + 人群层 */
function sceneProps(ctx, s, p, t, seed) {
  crowdFigures(ctx, s, p, t, seed)
  s.props.forEach((key, i) => drawProp(ctx, key, PROP_SLOTS[i % PROP_SLOTS.length] + (i >= PROP_SLOTS.length ? 10 : 0), GROUND_Y, p, t))
}

/** 环境破损度：碎裂痕 → 瓦砾堆 → 塌落板（随【崩塌时间线】天数递进） */
function damageOverlay(ctx, s, p, seed) {
  if (s.damage === 'intact') return
  const heavy = s.damage === 'ruined'
  const piles = heavy ? [[14, 96], [186, 76]] : [[22, 72]]
  for (const [x, w] of piles) {
    polygon(ctx, p.shade, [[x, GROUND_Y], [x + w / 2, GROUND_Y - (heavy ? 22 : 11)], [x + w, GROUND_Y]])
    rect(ctx, p.shade, x + w / 3, GROUND_Y - 4, 6, 4)
  }
  for (let i = 0; i < (heavy ? 5 : 2); i += 1) {
    const x = 26 + ((seed % 61 + i * 137) % 424)
    const y = 62 + (i * 43) % 92
    rect(ctx, p.ink, x, y, 15, 1)
    rect(ctx, p.ink, x + 7, y - 4, 1, 9)
  }
  if (heavy) {
    polygon(ctx, p.shade, [[326, 44], [404, 100], [395, 105], [322, 50]])
    for (let i = 0; i < 7; i += 1) rect(ctx, p.shade, 30 + (i * 53 + seed % 17) % 424, 226, 9, 3)
  }
}

/** 光源：吊灯光锥 / 火光晕 / 手电光束（叠在人物之上，低透明度不频闪） */
function lightGlow(ctx, s, p, t) {
  if (s.light === 'none') return
  ctx.globalAlpha = 0.1
  if (s.light === 'lamp') {
    const flick = Math.sin(t * 0.7) > -0.85 ? 1 : 0.55
    ctx.globalAlpha = 0.1 * flick
    polygon(ctx, p.lamp, [[222, 26], [262, 26], [332, 212], [156, 212]])
    rect(ctx, p.lamp, 238, 20, 10, 6)
  } else if (s.light === 'fire') {
    polygon(ctx, p.lamp, [[222, 186], [292, 128], [362, 186], [292, 244]])
  } else if (s.light === 'flashlight') {
    const dir = s.direction === 'left' ? -1 : 1
    const x0 = dir === 1 ? 302 : 262
    polygon(ctx, p.glass, [[x0, 178], [x0 + dir * 188, 148], [x0 + dir * 188, 234], [x0, 198]])
  }
  ctx.globalAlpha = 1
}

function weather(ctx, s, p, time) {
  const rain = ['rain', 'storm', 'thunder'].includes(s.weather)
  const snow = ['snow', 'blizzard'].includes(s.weather)
  const heavy = ['storm', 'thunder', 'blizzard'].includes(s.weather)
  ctx.save()
  if (APERTURES[s.setting]) {
    ctx.beginPath(); ctx.rect(...APERTURES[s.setting])
    if (s.focus === 'window') ctx.rect(333, 71, 91, 68)
    ctx.clip()
  }
  // Thunder uses steady storm lighting, never lightning flashes or pulsing alpha.
  if (rain || snow) {
    ctx.globalAlpha = snow ? 0.55 : 0.32
    for (let i = 0; i < (heavy ? 108 : 63); i += 1) {
      const speed = snow ? 12 + i % 7 : 78 + i % 31
      const y = ((i * 67 + time * speed) % 318) - 24
      const x = ((i * 97 + time * (heavy ? 23 : 7)) % 584) - 52
      if (snow) rect(ctx, p.fog, x, y, i % 4 === 0 ? 3 : 2, 2)
      else { rect(ctx, p.glass, x, y, 1, 5); rect(ctx, p.glass, x - 1, y + 5, 1, 4) }
    }
  }
  if (s.weather === 'fog' || heavy) {
    ctx.globalAlpha = s.weather === 'fog' ? 0.13 : 0.06
    for (let i = 0; i < 5; i += 1) {
      const x = ((i * 137 + time * 5) % 720) - 220
      rect(ctx, p.fog, x, 120 + i * 25, 280, 17)
      rect(ctx, p.fog, x + 32, 115 + i * 25, 216, 27)
    }
  }
  ctx.restore()
}

function foreground(ctx, s, p) {
  if (s.setting === 'forest') {
    rect(ctx, p.ink, -9, 8, 26, 262); rect(ctx, p.ink, 463, 25, 25, 245)
    polygon(ctx, p.ink, [[-5, 55], [89, 17], [87, 25], [10, 77]])
    for (const x of [25, 65, 410, 450]) polygon(ctx, p.ink, [[x - 18, 270], [x - 11, 239], [x, 260], [x + 15, 246], [x + 20, 270]])
  } else if (s.setting === 'station') {
    rect(ctx, p.ink, -32, 244, 544, 26)
    for (let x = -20; x < 520; x += 33) rect(ctx, p.wall, x, 247, 13, 23)
    rect(ctx, p.edge, -32, 248, 544, 3); rect(ctx, p.edge, -32, 264, 544, 3)
  } else {
    rect(ctx, p.ink, -15, 242, 53, 28); rect(ctx, p.shade, -10, 238, 44, 6)
    rect(ctx, p.ink, 455, 250, 42, 20); rect(ctx, p.wall, 459, 246, 25, 4)
  }
}

/** Draw one 480×270 composition, letterboxed to ctx.canvas; no retained state or I/O. */
export function drawPixelScene(ctx, scene, { time = 0, progress = 0, reducedMotion = false } = {}) {
  if (!ctx || !ctx.canvas) return
  const width = finite(ctx.canvas.width), height = finite(ctx.canvas.height)
  if (width <= 0 || height <= 0) return
  const s = normalize(scene), seed = hash(`${s.setting}:${s.location}`)
  const p = { ...PALETTES[s.night ? 'night' : 'day'], accent: { quiet: '#90a6a5', tense: '#b09b73', danger: '#b17c6b', hope: '#a6b99a' }[s.mood] }
  const t = reducedMotion ? 0 : Math.max(0, finite(time)) % 86400
  const frameProgress = reducedMotion ? 0.5 : Math.max(0, Math.min(1, finite(progress)))
  const zoom = !reducedMotion && s.camera === 'push-in' ? 1 + frameProgress * 0.065 : 1
  const pan = !reducedMotion && s.camera.startsWith('pan-') ? Math.round((frameProgress - 0.5) * 18) * (s.camera === 'pan-left' ? 1 : -1) : 0
  const scale = Math.min(width / WIDTH, height / HEIGHT)
  ctx.save()
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
    ctx.imageSmoothingEnabled = false; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.filter = 'none'
    ctx.clearRect(0, 0, width, height)
    rect(ctx, p.ink, 0, 0, width, height)
    ctx.translate(Math.round((width - WIDTH * scale) / 2), Math.round((height - HEIGHT * scale) / 2)); ctx.scale(scale, scale)
    ctx.beginPath(); ctx.rect(0, 0, WIDTH, HEIGHT); ctx.clip()
    ctx.translate(WIDTH / 2, HEIGHT / 2); ctx.scale(zoom, zoom); ctx.translate(-WIDTH / 2, -HEIGHT / 2)
    ctx.save(); ctx.translate(Math.round(pan * 0.35), 0); backdrop(ctx, s, p, seed, t); ctx.restore()
    ctx.translate(pan, 0)
    environment(ctx, s, p, seed)
    damageOverlay(ctx, s, p, seed)
    focusObject(ctx, s, p, t)
    sceneProps(ctx, s, p, t, seed)
    cast(ctx, s, p, t, frameProgress, !!reducedMotion)
    lightGlow(ctx, s, p, t)
    foreground(ctx, s, p)
    weather(ctx, s, p, t)
  } finally {
    ctx.restore()
  }
}
