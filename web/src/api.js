/**
 * 前端门面：把「SQLite + 游戏引擎」包装成与原先 HTTP 版一致的调用签名。
 * 纯静态模式下不再有后端，所有调用都在浏览器内完成。
 */
import { initDb, flush, exportBytes, importBytes, resetDb } from './db/sqlite.js'
import { getPublicConfig, saveConfig, getConfig, countSessions } from './db/store.js'
import {
  newGame,
  choose,
  scavenge,
  skipScavenge,
  sleep as engineSleep,
  useItem,
  giveItem,
  getGame,
  deleteGame,
  latestGame,
} from './core/engine.js'
import { testConnection } from './core/llm.js'

let booted = false

async function ensure() {
  if (!booted) {
    await initDb()
    booted = true
  }
}

export const api = {
  init: ensure,

  health: async () => {
    await ensure()
    const c = getPublicConfig()
    return { ok: true, ready: c.ready, provider: c.provider }
  },

  getSettings: async () => {
    await ensure()
    return getPublicConfig()
  },

  saveSettings: async (patch) => {
    await ensure()
    return saveConfig(patch)
  },

  testSettings: async (draft = {}) => {
    await ensure()
    const cfg = { ...getConfig() }
    if (draft.baseUrl) cfg.baseUrl = String(draft.baseUrl).trim().replace(/\/+$/, '')
    if (draft.model) cfg.model = String(draft.model).trim()
    if (draft.provider) cfg.provider = String(draft.provider)
    if (draft.corsProxy !== undefined) cfg.corsProxy = String(draft.corsProxy).trim()
    if (draft.corsProxyCustom !== undefined) cfg.corsProxyCustom = String(draft.corsProxyCustom).trim()
    if (typeof draft.apiKey === 'string' && draft.apiKey.trim() !== '') cfg.apiKey = draft.apiKey.trim()
    return testConnection(cfg)
  },

  newGame: async () => {
    await ensure()
    return newGame()
  },

  latest: async () => {
    await ensure()
    return latestGame()
  },

  getGame: async (id) => {
    await ensure()
    return getGame(id)
  },

  choose: async (id, choiceId) => {
    await ensure()
    return choose(id, choiceId)
  },

  scavenge: async (id) => {
    await ensure()
    return scavenge(id)
  },

  /** 「不搜刮此地」：玩家明确放弃在当前地点翻找（不消耗时间与体力） */
  skipScavenge: async (id) => {
    await ensure()
    return skipScavenge(id)
  },

  /** 睡觉：夜晚的独立行动，需指定地点（就地 / 已知的安全落脚点） */
  sleep: async (id, place) => {
    await ensure()
    return engineSleep(id, place)
  },

  useItem: async (id, itemName, target) => {
    await ensure()
    return useItem(id, itemName, target)
  },

  giveItem: async (id, itemName, targetName) => {
    await ensure()
    return giveItem(id, itemName, targetName)
  },

  remove: async (id) => {
    await ensure()
    return { ok: deleteGame(id) }
  },

  /* ---------- 存档数据库（SQLite 文件） ---------- */

  dbStats: async () => {
    await ensure()
    return { sessions: countSessions() }
  },

  /** 导出 .sqlite 文件字节，用于下载备份 */
  exportDb: async () => {
    await ensure()
    await flush()
    return exportBytes()
  },

  /** 导入 .sqlite 文件字节 */
  importDb: async (bytes) => {
    await ensure()
    await importBytes(bytes)
  },

  resetDb: async () => {
    await ensure()
    await resetDb()
  },

  flush: async () => {
    await ensure()
    await flush()
  },
}
