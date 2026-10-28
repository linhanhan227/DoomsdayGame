import React, { useCallback, useEffect, useRef, useState } from 'react'
import { drawPixelPlot } from '../core/pixel-scene.js'

/** 画布逻辑分辨率：按 16:9 低分辨率逐帧绘制，CSS 拉伸放大（image-rendering: pixelated） */
const CANVAS_W = 480
const CANVAS_H = 270

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 像素剧情动画播放器
 * ------------------------------------------------------------------
 * · plot 由引擎归一化（core/plot.js）：这里只"画"数据，
 *   不执行模型返回的任何代码或地址；
 * · 播放中：Canvas 逐帧绘制各"剧情节点" + 字幕条 + 「跳过」；
 * · 播完 / 跳过：收起为一行「重播」入口，并通过 onChange('done')
 *   通知对局界面放行选项（每回合先动画、后选项）。
 * · 兼容旧存档：节点字段可能叫 shots 而非 beats。
 */
export default function PixelPlotPlayer({ plot, onChange }) {
  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const doneRef = useRef(false)
  const [runId, setRunId] = useState(0) // 重播 = 重跑一遍播放 effect
  const [playing, setPlaying] = useState(true)
  const [beatIndex, setBeatIndex] = useState(0)

  const beats =
    plot && Array.isArray(plot.beats) && plot.beats.length
      ? plot.beats
      : plot && Array.isArray(plot.shots) && plot.shots.length
        ? plot.shots
        : null

  // 播放状态变化即上报：播放中隐藏选项，结束后放行
  useEffect(() => {
    onChange?.(beats && !doneRef.current ? 'playing' : 'done')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, beats])

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    cancelAnimationFrame(rafRef.current)
    setPlaying(false)
  }, [])

  useEffect(() => {
    if (!beats) return undefined
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    const reduced = prefersReducedMotion()

    const durations = beats.map((b) => Math.max(1200, Math.min(6000, Number(b.durationMs) || 3000)))
    const total = durations.reduce((a, b) => a + b, 0)
    const start = performance.now()
    doneRef.current = false

    const drawBeat = (idx, elapsedMs, progress) => {
      drawPixelPlot(
        ctx,
        { ...plot, ...beats[idx], durationMs: durations[idx] },
        { time: elapsedMs / 1000, progress, reducedMotion: reduced },
      )
    }

    const frame = (now) => {
      if (doneRef.current) return
      let elapsed = now - start
      if (elapsed >= total) {
        drawBeat(beats.length - 1, durations[beats.length - 1], 1)
        finish()
        return
      }
      let idx = 0
      while (idx < beats.length - 1 && elapsed >= durations[idx]) {
        elapsed -= durations[idx]
        idx += 1
      }
      drawBeat(idx, elapsed, Math.min(1, elapsed / durations[idx]))
      setBeatIndex(idx)
      rafRef.current = requestAnimationFrame(frame)
    }

    rafRef.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafRef.current)
    // plot 每回合整体更换；runId 驱动重播
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot, runId, beats, finish])

  if (!beats) return null

  const replay = () => {
    // onChange effect 比播放 effect 先执行；必须先清完成标记，父层才会收到 playing 并隐藏选项
    doneRef.current = false
    setBeatIndex(0)
    setPlaying(true)
    setRunId((n) => n + 1)
  }

  const current = beats[Math.min(beatIndex, beats.length - 1)] || {}

  return (
    <figure className={`pixel-player${playing ? '' : ' is-done'}`}>
      {playing ? (
        <>
          <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} aria-label="本回合剧情动画" role="img" />
          <figcaption className="pixel-caption">
            <span className="pixel-shot-tag">
              剧情节点 {Math.min(beatIndex + 1, beats.length)}/{beats.length}
            </span>
            <span className="pixel-caption-text">{current.caption || '……'}</span>
          </figcaption>
          <div className="pixel-controls">
            <span className="pixel-dots" aria-hidden="true">
              {beats.map((_, i) => (
                <i key={i} className={i <= beatIndex ? 'on' : ''} />
              ))}
            </span>
            <span className="pixel-loc">{plot.location || ''}</span>
            <button className="pixel-skip" onClick={finish} title="跳过动画，直接显示选项">
              跳过 ⏭
            </button>
          </div>
        </>
      ) : (
        <button className="pixel-replay" onClick={replay} title="重新播放本回合剧情动画">
          🎬 重播本回合剧情
        </button>
      )}
    </figure>
  )
}
