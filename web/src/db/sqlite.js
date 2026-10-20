/**
 * SQLite 持久层（sql.js / WebAssembly）
 * ------------------------------------------------------------------
 * 纯前端运行真正的 SQLite：
 *   · 引擎：sql.js（SQLite 编译为 WASM）。wasm 以 base64 **内联在主包里**
 *     （见 vite.config.js 的 sql-wasm-inline），启动时解码后经 wasmBinary
 *     直接喂给 Emscripten。
 *     —— 内联而非外置：产物**零外部请求**，任何静态托管（含对扩展名/MIME 挑剔、
 *        或会对 .js 做改写的平台）与本地静态服务器都能跑；也不会再出现
 *        "新版发布后旧 chunk 被清、浏览器还跑旧包" 的错配。
 *   · 持久化：把整个 .sqlite 文件字节写入 IndexedDB；启动时读回。
 *   · 表结构为关系型（settings / sessions / log_entries / entities），
 *     而不是把状态塞进一个 JSON blob——存档可查询、可导出、可迁移。
 */
import initSqlJs from 'sql.js'
import wasmBase64 from 'virtual:sql-wasm-base64'

/** base64 → 字节。atob 对 ~880KB 字符串只需几毫秒，不值得异步化 */
function base64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * 取 wasm 字节。内联路径下没有网络、没有解压、没有任何环境相关的 API——
 * 也就没有"某个浏览器/某个托管上跑不起来"的空间。
 */
let wasmBinary = null
function getWasmBinary() {
  if (!wasmBinary) wasmBinary = base64ToBytes(wasmBase64)
  return wasmBinary
}

/** 统一的初始化参数：wasm 字节直接交给 Emscripten，跳过一切网络加载 */
async function sqlJsConfig() {
  return { wasmBinary: getWasmBinary() }
}

const IDB_NAME = 'ashes-remain'
const IDB_STORE = 'files'
const DB_KEY = 'game.sqlite'

let SQL = null
let db = null
let idbPromise = null
let saveTimer = null
let dirty = false

/* ---------------------------- IndexedDB ---------------------------- */

function openIdb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return idbPromise
}

async function idbGet(key) {
  const d = await openIdb()
  return new Promise((resolve, reject) => {
    const r = d.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key)
    r.onsuccess = () => resolve(r.result ?? null)
    r.onerror = () => reject(r.error)
  })
}

async function idbPut(key, value) {
  const d = await openIdb()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

async function idbDel(key) {
  const d = await openIdb()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

/* ---------------------------- 表结构 ---------------------------- */

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  turn        INTEGER NOT NULL DEFAULT 0,
  day         INTEGER NOT NULL DEFAULT 1,
  minute      INTEGER NOT NULL DEFAULT 360,
  weather     TEXT,
  location    TEXT    NOT NULL DEFAULT '',
  over        INTEGER NOT NULL DEFAULT 0,
  memory      TEXT    NOT NULL DEFAULT '',
  protagonist TEXT,
  stats       TEXT    NOT NULL DEFAULT '{}',
  main_quest  TEXT,
  ending      TEXT,
  last_event   TEXT,
  scavenge_count      INTEGER NOT NULL DEFAULT 0,
  scavenge_spot       TEXT,
  scavenge_spot_count INTEGER NOT NULL DEFAULT 0,
  scavenge_cap        INTEGER NOT NULL DEFAULT 3,
  scavenge_skip_spot  TEXT,
  scavenge_safe       INTEGER,
  unsafe_reason       TEXT,
  used_this_turn      TEXT,
  use_count           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS log_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL,
  turn       INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  chosen     TEXT,
  day        INTEGER,
  time       TEXT,
  loot       TEXT,
  used       TEXT,
  target     TEXT,
  special    TEXT,
  weather    TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}',
  ord        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_log_session     ON log_entries(session_id, id);
CREATE INDEX IF NOT EXISTS idx_entities_session ON entities(session_id, kind, ord);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`

/* ---------------------------- 增量迁移 ---------------------------- */

/** 旧存档升级：补齐后来新增的列（SQLite 无 ADD COLUMN IF NOT EXISTS，只能先探测） */
function migrate() {
  const cols = (table) => {
    try {
      return all(`PRAGMA table_info(${table})`).map((c) => c.name)
    } catch {
      return []
    }
  }
  const addIfMissing = (table, col, decl) => {
    if (!cols(table).includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  }
  addIfMissing('log_entries', 'loot', 'TEXT')
  addIfMissing('log_entries', 'used', 'TEXT')
  addIfMissing('log_entries', 'target', 'TEXT')
  addIfMissing('log_entries', 'special', 'TEXT')
  addIfMissing('log_entries', 'weather', 'TEXT')
  addIfMissing('sessions', 'scavenge_count', 'INTEGER NOT NULL DEFAULT 0')
  addIfMissing('sessions', 'scavenge_spot', 'TEXT')
  addIfMissing('sessions', 'scavenge_spot_count', 'INTEGER NOT NULL DEFAULT 0')
  addIfMissing('sessions', 'scavenge_cap', 'INTEGER NOT NULL DEFAULT 3')
  addIfMissing('sessions', 'scavenge_skip_spot', 'TEXT')
  addIfMissing('sessions', 'scavenge_safe', 'INTEGER')
  addIfMissing('sessions', 'unsafe_reason', 'TEXT')
  addIfMissing('sessions', 'used_this_turn', 'TEXT')
  addIfMissing('sessions', 'use_count', 'INTEGER NOT NULL DEFAULT 0')
  addIfMissing('sessions', 'minute', 'INTEGER NOT NULL DEFAULT 360')
  addIfMissing('sessions', 'weather', 'TEXT')
}

/* ---------------------------- 生命周期 ---------------------------- */

export async function initDb() {
  if (db) return db
  SQL = await initSqlJs(await sqlJsConfig())
  const saved = await idbGet(DB_KEY)
  db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database()
  db.run(SCHEMA)
  migrate()
  if (!saved) await flush()
  // 页面隐藏/关闭前尽量落盘
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('beforeunload', () => {
    if (dirty) {
      try {
        const bytes = db.export()
        // 同步尽力写入（IndexedDB 异步，这里仅触发一次）
        idbPut(DB_KEY, bytes)
      } catch {
        /* 忽略 */
      }
    }
  })
  return db
}

export function getDb() {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

/* ---------------------------- 查询封装 ---------------------------- */

export function run(sql, params = []) {
  getDb().run(sql, params)
  scheduleSave()
}

export function all(sql, params = []) {
  const stmt = getDb().prepare(sql)
  try {
    stmt.bind(params)
    const out = []
    while (stmt.step()) out.push(stmt.getAsObject())
    return out
  } finally {
    stmt.free()
  }
}

export function get(sql, params = []) {
  return all(sql, params)[0] || null
}

export function lastInsertId() {
  const r = get('SELECT last_insert_rowid() AS id')
  return r ? r.id : null
}

/* ---------------------------- 落盘 ---------------------------- */

export function scheduleSave() {
  dirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    flush()
  }, 150)
}

export async function flush() {
  if (!db) return
  clearTimeout(saveTimer)
  try {
    const bytes = db.export()
    await idbPut(DB_KEY, bytes)
    dirty = false
  } catch (err) {
    console.error('[sqlite] 落盘失败：', err)
  }
}

/** 导出 .sqlite 文件字节（用于下载备份） */
export function exportBytes() {
  return getDb().export()
}

/** 用外部 .sqlite 字节替换当前数据库（用于导入备份） */
export async function importBytes(bytes) {
  if (!SQL) SQL = await initSqlJs(await sqlJsConfig())
  const next = new SQL.Database(new Uint8Array(bytes))
  next.run(SCHEMA) // 兼容旧版本/缺表的情况
  db = next
  migrate()
  await flush()
  return db
}

/** 清空数据库（危险操作，需调用方二次确认） */
export async function resetDb() {
  getDb().run('DROP TABLE IF EXISTS entities; DROP TABLE IF EXISTS log_entries; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS settings;')
  getDb().run(SCHEMA)
  await flush()
}
