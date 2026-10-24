import React, { useRef, useState } from 'react'
import { api } from '../api.js'

function providerLabel(s) {
  if (!s) return ''
  if (s.provider === 'mock' || s.provider === 'codex') return '暂未设置 AI 模型'
  if (s.provider === 'custom') return `自定义接口${s.customName ? `（${s.customName}）` : ''}`
  return 'OpenAI 兼容'
}

export default function StartScreen({
  settings,
  latest,
  busy,
  busyHint,
  notify,
  onStart,
  onContinue,
  onOpenSettings,
  onDiscard,
}) {
  const ready = settings?.ready
  const canResume = latest && !latest.over
  const lastEnded = latest && latest.over
  const fileRef = useRef(null)
  const [importing, setImporting] = useState(false)

  // 主页直接导入 .sqlite 存档：与设置面板内的导入共用同一条通道
  const handleImport = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      await api.importDb(buf)
      notify?.('存档导入成功，正在刷新…', 'ok')
      setTimeout(() => window.location.reload(), 700)
    } catch (err) {
      notify?.(`导入失败：${err.message}`)
      setImporting(false)
    }
  }

  return (
    <div className="menu">
      <div className="menu-badge">Zombie Survival · Text RPG</div>
      <h1 className="menu-title">灰烬余生</h1>
      <div className="menu-sub">ASHES · REMAIN</div>

      <p className="menu-desc">
        K-17 爆发的第一天，世界还在假装一切正常。
        <br />
        这里没有预设的剧本，也没有写好的结局——
        <br />
        你迈出的每一步，都由这个世界的引擎在此刻为你现推。
      </p>

      <div className="menu-actions">
        <button className="btn btn-primary" onClick={onStart} disabled={busy || importing}>
          {busy ? busyHint || '正在推演开局…' : '开始新的一局'}
        </button>

        {canResume && (
          <button className="btn" onClick={onContinue} disabled={busy || importing}>
            继续上次 · 第 {latest.day} 天 {latest.location}
          </button>
        )}

        {lastEnded && (
          <button className="btn btn-ghost" onClick={onDiscard} disabled={busy || importing}>
            清除上次的结局记录
          </button>
        )}

        <button className="btn btn-ghost" onClick={onOpenSettings} disabled={importing}>
          {ready ? 'AI 通道设置' : '⚠ 配置 AI 通道'}
        </button>

        <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={importing}>
          {importing ? '导入中…' : '📥 导入存档（.sqlite）'}
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden-file-input"
          accept=".sqlite,.db,application/octet-stream,application/x-sqlite3"
          onChange={handleImport}
        />
      </div>

      <div className="menu-foot">
        {settings
          ? `${providerLabel(settings)} · ${settings.model || '未设置模型'} · ${ready ? '就绪' : '未就绪'}`
          : '正在初始化本地数据库…'}
      </div>
    </div>
  )
}
