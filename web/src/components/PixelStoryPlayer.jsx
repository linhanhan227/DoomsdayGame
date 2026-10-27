import React, { useCallback, useEffect, useRef, useState } from 'react'
import { drawPixelScene } from '../core/pixel-scene.js'

/** 画布逻辑分辨率：按 16:9 低分辨率逐帧绘制，CSS 拉伸放大（image-rendering: pixelated） */
const CANVAS_W = 480
const CANVAS_H = 270

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 像素剧情动画播放器
 * ------------------------------------------------------------------
 * · storyboard 由引擎归一化（core/storyboard.js）：这里只"画"数据，
 *   不执行模型返回的任何代码或地址；
 * · 播放中：Canvas 逐帧绘制两个分镜 + 字幕条 + 「跳过」；
 * · 播完 / 跳过：收起为一行「重播」入口，并通过 onChange('done')
 *   通知对局界面放行选项（每回合先动画、后选项）。
 */
export default function PixelStoryPlayer({ storyboard, onChange }) {
  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const doneRef = useRef(false)
  const [runId, setRunId] = useState(0) // 重播 = 重跑一遍播放 effect
  const [playing, setPlaying] = useState(true)
  const [shotIndex, setShotIndex] = useState(0)

  const shots =
    storyboard && Array.isArray(storyboard.shots) && storyboard.shots.length ? storyboard.shots : null

  // 播放状态变化即上报：播放中隐藏选项，结束后放行
  useEffect(() => {
    onChange?.(shots && !doneRef.current ? 'playing' : 'done')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, shots])

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    cancelAnimationFrame(rafRef.current)
    setPlaying(false)
  }, [])

  useEffect(() => {
    if (!shots) return undefined
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    const reduced = prefersReducedMotion()

    const durations = shots.map((s) => Math.max(1200, Math.min(6000, Number(s.durationMs) || 3000)))
    const total = durations.reduce((a, b) => a + b, 0)
    const start = performance.now()
    doneRef.current = false

    const drawShot = (idx, elapsedMs, progress) => {
      drawPixelScene(
        ctx,
        { ...storyboard, ...shots[idx], durationMs: durations[idx] },
        { time: elapsedMs / 1000, progress, reducedMotion: reduced },
      )
    }

    const frame = (now) => {
      if (doneRef.current) return
      let elapsed = now - start
      if (elapsed >= total) {
        drawShot(shots.length - 1, durations[shots.length - 1], 1)
        finish()
        return
      }
      let idx = 0
      while (idx < shots.length - 1 && elapsed >= durations[idx]) {
        elapsed -= durations[idx]
        idx += 1
      }
      drawShot(idx, elapsed, Math.min(1, elapsed / durations[idx]))
      setShotIndex(idx)
      rafRef.current = requestAnimationFrame(frame)
    }

    rafRef.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafRef.current)
    // storyboard 每回合整体更换；runId 驱动重播
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyboard, runId, shots, finish])

  if (!shots) return null

  const replay = () => {
    setShotIndex(0)
    setPlaying(true)
    setRunId((n) => n + 1)
  }

  const current = shots[Math.min(shotIndex, shots.length - 1)] || {}

  return (
    <figure className={`pixel-player${playing ? '' : ' is-done'}`}>
      {playing ? (
        <>
          <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} aria-label="本回合剧情动画" role="img" />
          <figcaption className="pixel-caption">
            <span className="pixel-shot-tag">
              分镜 {Math.min(shotIndex + 1, shots.length)}/{shots.length}
            </span>
            <span className="pixel-caption-text">{current.caption || '……'}</span>
          </figcaption>
          <div className="pixel-controls">
            <span className="pixel-dots" aria-hidden="true">
              {shots.map((_, i) => (
                <i key={i} className={i <= shotIndex ? 'on' : ''} />
              ))}
            </span>
            <span className="pixel-loc">{storyboard.location || ''}</span>
            <button className="pixel-skip" onClick={finish} title="跳过动画，直接显示选项">
              跳过 ⏭
            </button>
          </div>
        </>
      ) : (
        <button className="pixel-replay" onClick={replay} title="重新播放本回合剧情动画">
          🎬 重播本回合动画
        </button>
      )}
    </figure>
  )
}
