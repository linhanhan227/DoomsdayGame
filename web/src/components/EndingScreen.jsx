import React, { useEffect, useState } from 'react'

export default function EndingScreen({ ending, game, onRestart }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 260)
    return () => clearTimeout(t)
  }, [])

  if (!show) return null

  return (
    <div className="ending-overlay">
      <div className="ending-card">
        <div className="ending-tag">THIS RUN HAS ENDED</div>
        <h2 className="ending-title">{ending.title || '终局'}</h2>
        <div className="ending-body">{ending.text}</div>

        <div className="ending-stats">
          <span>
            撑过 <b>{game.day}</b> 天
          </span>
          <span>
            经历 <b>{game.turn}</b> 个抉择
          </span>
          <span>
            最终抵达 <b>{game.location}</b>
          </span>
        </div>

        {game.memory && (
          <div style={{ fontSize: 13, color: 'var(--text-faint)', marginBottom: 28, lineHeight: 1.9 }}>
            {game.memory}
          </div>
        )}

        <button className="btn btn-primary" onClick={onRestart}>
          再活一次
        </button>
      </div>
    </div>
  )
}
