import React, { useState } from 'react'
import { api } from '../api.js'

// cors: true = 已验证支持浏览器直连（会返回 Access-Control-Allow-Origin）
const PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', cors: true },
  { label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', cors: true },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', cors: true },
  { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', cors: true },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', cors: true },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', cors: true },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', cors: false },
]

const FALLBACK_URL = PRESETS[0].baseUrl
const FALLBACK_MODEL = PRESETS[0].model

export default function SettingsModal({ settings, onClose, onSave, onTest, notify }) {
  const [draft, setDraft] = useState(() => {
    // 离线体验（mock）与已删除的内置通道（codex）都回落到玩家自己填写的 OpenAI 兼容配置
    const legacy = settings?.provider === 'mock' || settings?.provider === 'codex'
    return {
      provider: legacy || !settings?.provider ? 'openai' : settings.provider,
      customName: settings?.customName || '',
      baseUrl: settings?.baseUrl || FALLBACK_URL,
      model: settings?.model || FALLBACK_MODEL,
      apiKey: '',
      temperature: Math.max(0, Math.min(1, Number(settings?.temperature ?? 1) || 1)),
      corsProxy:
        settings?.corsProxy === 'corsio' || settings?.corsProxy === 'custom' || settings?.corsProxy === 'same'
          ? settings.corsProxy
          : 'off',
      corsProxyCustom: settings?.corsProxyCustom || '',
    }
  })
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)
  const [busyDb, setBusyDb] = useState(false)
  const [dbMsg, setDbMsg] = useState(null)

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }))

  const applyPreset = (p) => {
    setDraft((d) => ({ ...d, provider: 'openai', baseUrl: p.baseUrl, model: p.model }))
    setResult(null)
  }

  const useCustom = () => {
    setDraft((d) => ({
      ...d,
      provider: 'custom',
      customName: d.customName || '',
      // 留空便于直接粘贴自己的地址；若已有值则保留，方便在此基础上改
      baseUrl: d.provider === 'custom' ? d.baseUrl : '',
      model: d.provider === 'custom' ? d.model : '',
    }))
    setResult(null)
  }

  const handleTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      const r = await onTest(draft)
      setResult({ ok: true, msg: `连通成功 · 模型 ${r.model} · 返回：${r.sample}` })
    } catch (e) {
      setResult({ ok: false, msg: e.message })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      notify('配置已保存', 'ok')
      onClose()
    } catch (e) {
      notify(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleExport = async () => {
    setBusyDb(true)
    setDbMsg(null)
    try {
      const bytes = await api.exportDb()
      const blob = new Blob([bytes], { type: 'application/x-sqlite3' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ashes-remain-${new Date().toISOString().slice(0, 10)}.sqlite`
      a.click()
      URL.revokeObjectURL(url)
      setDbMsg({ ok: true, msg: '已导出 .sqlite 文件，可用于备份或迁移。' })
    } catch (e) {
      setDbMsg({ ok: false, msg: e.message })
    } finally {
      setBusyDb(false)
    }
  }

  const handleImport = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusyDb(true)
    setDbMsg(null)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      await api.importDb(buf)
      setDbMsg({ ok: true, msg: '导入成功，正在刷新…' })
      setTimeout(() => window.location.reload(), 700)
    } catch (err) {
      setDbMsg({ ok: false, msg: `导入失败：${err.message}` })
    } finally {
      setBusyDb(false)
    }
  }

  const handleReset = async () => {
    if (!window.confirm('⚠️ 此操作会删除全部存档与配置，且不可恢复。确定继续？')) return
    setBusyDb(true)
    setDbMsg(null)
    try {
      await api.resetDb()
      setDbMsg({ ok: true, msg: '已清空，正在刷新…' })
      setTimeout(() => window.location.reload(), 700)
    } catch (err) {
      setDbMsg({ ok: false, msg: err.message })
    } finally {
      setBusyDb(false)
    }
  }

  const isCustom = draft.provider === 'custom'

  // 即时格式校验：URL 合法、Key 已填或已配置、模型非空。校验未过则禁用保存/测试。
  const urlError = (() => {
    const v = (draft.baseUrl || '').trim()
    if (!v) return '请填写 Base URL'
    try {
      const u = new URL(v)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Base URL 须以 http:// 或 https:// 开头'
      return null
    } catch {
      return 'Base URL 不是合法的 URL'
    }
  })()
  const keyError = (draft.apiKey.trim() || settings?.hasKey) ? null : '请填写 API Key（留空代表不改已保存的 Key，但当前尚未配置任何 Key）'
  const modelError = (draft.model || '').trim() ? null : '请填写模型名'
  const formValid = !urlError && !keyError && !modelError
  const errStyle = { color: '#c0392b', fontSize: 12, marginTop: 4 }

  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>AI 通道设置</h3>
        <p className="hint">
          游戏的事件、结局全部由大模型现场生成。本作<b>没有数据后端</b>：配置与存档都保存在本地 <b>SQLite</b> 数据库中
          （持久化于浏览器 IndexedDB），模型请求默认由浏览器直连服务商。
          <br />
          注意：浏览器直连要求服务商允许 CORS。本版默认<b>关闭</b>跨域中转，请求直接发给服务商。
        </p>

        <div className="field">
          <label>通道类型</label>
          <select
            value={draft.provider}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'custom') useCustom()
              else {
                setDraft((d) => ({
                  ...d,
                  provider: 'openai',
                  baseUrl: d.provider === 'openai' ? d.baseUrl : FALLBACK_URL,
                  model: d.provider === 'openai' ? d.model : FALLBACK_MODEL,
                }))
                setResult(null)
              }
            }}
          >
            <option value="openai">预设 · DeepSeek / OpenAI / Moonshot 等（OpenAI 兼容）</option>
            <option value="custom">自定义 · OpenAI 接口（/v1/chat/completions）</option>
          </select>
          <div className="sub">没有可用的 AI 模型时无法开始游戏，请先配置并测试通过。</div>
        </div>

        <>
          <div className="preset-row">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={`btn btn-sm ${!isCustom && draft.baseUrl === p.baseUrl ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => applyPreset(p)}
                title={p.cors ? '已验证支持浏览器直连' : '未验证浏览器直连，可开启跨域中转'}
              >
                {p.label}
                <span className={p.cors ? 'cors-ok' : 'cors-no'}>{p.cors ? '✓' : '⚠'}</span>
              </button>
            ))}
            <button className={`btn btn-sm ${isCustom ? 'btn-primary' : 'btn-ghost'}`} onClick={useCustom}>
              ✎ 自定义接口
            </button>
          </div>
          <div className="cors-legend">
            <span className="cors-ok">✓</span> 已验证支持浏览器直连（无需中转）　
            <span className="cors-no">⚠</span> 未验证直连，可开启<b>跨域中转</b>访问
          </div>

          {isCustom && (
            <div className="field">
              <label>接口名称（可选，仅用于界面识别）</label>
              <input
                value={draft.customName}
                onChange={(e) => set('customName', e.target.value)}
                placeholder="例如：公司内网网关 / 自建 vLLM / 中转服务"
              />
              <div className="sub">便于你在多个自定义接口之间辨认，不影响调用</div>
            </div>
          )}

          <div className="field">
            <label>Base URL</label>
            <input
              value={draft.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
              placeholder={isCustom ? 'https://api.openai.com/v1' : 'https://api.deepseek.com/v1'}
              style={urlError ? { borderColor: '#c0392b' } : undefined}
            />
            <div className="sub">
              {isCustom
                ? '按 OpenAI 接口调用：可填域名、以 /v1 结尾的地址，或完整的 /v1/chat/completions。请求使用 Bearer 鉴权，正文为 model 与 messages。'
                : '需包含版本路径（通常以 /v1 结尾）。已经写成 /chat/completions 时不会再拼一次。'}
            </div>
            {urlError && <div style={errStyle}>{urlError}</div>}
          </div>

          <div className="field">
            <label>模型名</label>
            <input
              value={draft.model}
              onChange={(e) => set('model', e.target.value)}
              placeholder={isCustom ? '例如：deepseek-chat / qwen2.5-72b-instruct' : 'deepseek-chat'}
              style={modelError ? { borderColor: '#c0392b' } : undefined}
            />
            {modelError && <div style={errStyle}>{modelError}</div>}
          </div>

          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder={settings?.hasKey ? '已配置（留空则保持不变）' : 'sk-...'}
              style={keyError && !settings?.hasKey ? { borderColor: '#c0392b' } : undefined}
            />
            <div className="sub">留空表示不修改已保存的 Key。Key 只保存在你本机的 SQLite 里，不会上传。</div>
            {keyError && <div style={errStyle}>{keyError}</div>}
          </div>

          <div className="field">
            <label>温度（越高越随机）· {Number(draft.temperature).toFixed(2)}</label>
            <div className="temp-scale"><span>0</span><span>1</span></div>
            <input
              className="temp-range"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={draft.temperature}
              onChange={(e) => set('temperature', Number(e.target.value))}
            />
            <div className="sub">滑到最右就是 1，也是这个接口允许的最高温度。末日叙事建议 0.9 ~ 1。</div>
          </div>

          <div className="field">
            <label>跨域中转（CORS）</label>
            <select value={draft.corsProxy} onChange={(e) => set('corsProxy', e.target.value)}>
              <option value="off">关闭 · 直连服务商（默认）</option>
              <option value="same">同源中转 · 本站 /api/cors</option>
              <option value="corsio">cors.io · https://cors.io/?url=</option>
              <option value="custom">自定义中转前缀</option>
            </select>
            <div className="sub">
              默认浏览器直连服务商，不经过任何代理。服务商未返回 CORS 头时，用<b>同源中转</b>（部署在带服务端的实例上才有）或
              cors.io。直连被拦且本站带服务端时，会自动改走同源中转一次。
            </div>
            {draft.corsProxy === 'same' && (
              <div className="banner ok" style={{ marginTop: 8 }}>
                请求由<b>本站服务端</b>转发（<code>/api/cors</code>），不经过第三方。若页面是纯静态托管打开的，这条通道不可用。
              </div>
            )}
            {draft.corsProxy && draft.corsProxy !== 'off' && draft.corsProxy !== 'same' && (
              <div className="banner warn" style={{ marginTop: 8 }}>
                ⚠ 当前请求经中转服务转发：请求（含 <b>API Key</b>）会经过第三方服务器。
                若你的服务商支持直连，请把上面改为「关闭」。
              </div>
            )}
            {draft.corsProxy === 'custom' && (
              <input
                style={{ marginTop: 8 }}
                value={draft.corsProxyCustom}
                onChange={(e) => set('corsProxyCustom', e.target.value)}
                placeholder="https://cors.io/?url="
              />
            )}
          </div>
        </>

        {result && <div className={`banner ${result.ok ? 'ok' : 'err'}`}>{result.msg}</div>}

        <div className="db-section">
          <h4 className="db-title">存档数据库 · SQLite</h4>
          <p className="db-hint">所有存档与配置都存放在本地 SQLite 数据库中。可导出 .sqlite 备份，或换设备时导入。</p>
          <div className="preset-row">
            <button className="btn btn-ghost btn-sm" onClick={handleExport} disabled={busyDb}>
              导出 .sqlite
            </button>
            <label className="btn btn-ghost btn-sm db-file-label">
              导入 .sqlite
              <input
                type="file"
                accept=".sqlite,.db,application/octet-stream,application/x-sqlite3"
                onChange={handleImport}
                disabled={busyDb}
              />
            </label>
            <button className="btn btn-ghost btn-sm" onClick={handleReset} disabled={busyDb}>
              清空全部存档
            </button>
          </div>
          {dbMsg && <div className={`banner ${dbMsg.ok ? 'ok' : 'err'}`}>{dbMsg.msg}</div>}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={handleTest} disabled={testing || !formValid}>
            {testing ? '测试中…' : '测试连通性'}
          </button>
          <button className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !formValid}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
