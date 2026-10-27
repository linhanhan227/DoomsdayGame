import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import StartScreen from './components/StartScreen.jsx'
import GameScreen from './components/GameScreen.jsx'
import SettingsModal from './components/SettingsModal.jsx'

export default function App() {
  const [phase, setPhase] = useState('boot') // boot | menu | playing
  const [settings, setSettings] = useState(null)
  const [latest, setLatest] = useState(null)
  const [game, setGame] = useState(null)
  const [busy, setBusy] = useState(false)
  const [busyHint, setBusyHint] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)

  const notify = useCallback((message, type = 'err') => {
    setToast({ message, type })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 5200)
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const s = await api.getSettings()
      setSettings(s)
      return s
    } catch (e) {
      notify(`读取配置失败：${e.message}`)
      return null
    }
  }, [notify])

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('layout') === 'game') {
      setGame({
        id: 'layout',
        turn: 6,
        day: 4,
        minute: 1320,
        clock: '22:00',
        timeOfDay: '22:00',
        timePhrase: '夜里 22:00',
        dayPhase: '夜晚',
        isNight: true,
        weather: { kind: 'rain', label: '暴雨', note: '雨大得看不清街对面', remainH: 3 },
        collapseStage: '失序',
        location: '城南 · 市立医院住院部三楼东侧被封死的护士站走廊尽头',
        protagonist: { name: '林默', background: '', goal: '' },
        stats: { hp: 64, hunger: 48, thirst: 55, sanity: 41, stamina: 33, infection: 12 },
        infectionStage: '潜伏',
        inventory: [
          { name: '一件被血浸透的旧衬衫', category: '衣物', qty: 1, note: '还能撕', tradable: false },
          { name: '降压药', category: '药品', qty: 2, note: '只剩两粒', fits: '高血压患者', tradable: true },
        ],
        conditions: ['左臂划伤'],
        allies: [{ name: '老周', status: '同行', note: '腿有点瘸' }],
        flags: ['结仇·铁钩帮'],
        mutations: [],
        virusGeneration: 1,
        sheltersDetail: [{ name: '医院值班室', quality: 1, effectiveQuality: 1, note: '门能反锁', upgrades: {}, installed: [], next: [{ id: 'door', label: '加固门', need: ['木板', '钉子或绳'], hours: 1, affordable: false }] }],
        recipes: [{ id: 'bandage', name: '绷带', category: '药品', note: '布条撕开再缠紧', hours: 0.5, need: ['布料'], using: ['一件被血浸透的旧衬衫'], affordable: true }],
        tradeOffer: null,
        canTrade: true,
        tradePartners: ['老周'],
        skills: {
          scavenge: { xp: 12, level: 0, label: '搜刮', effect: '每级搜刮掉率 +6%' },
          combat: { xp: 0, level: 0, label: '战斗', effect: '每级少受 1 点伤害' },
          craft: { xp: 40, level: 1, label: '制作', effect: '每级抵消 1 点感染增量' },
          social: { xp: 0, level: 0, label: '交涉', effect: '等级越高，交易回报越好' },
        },
        mainQuest: { title: '寻妹', stage: '刚离开医院' },
        sideQuests: [{ title: '药房里的敲击声', status: 'active', note: '门后有人' }],
        mapNodes: [],
        locationTrail: [],
        log: [{ turn: 6, kind: 'event', text: '雨顺着破窗灌进来，你把手电压得很低。走廊尽头那扇门还在一下一下地响。', day: 4, time: '22:00', weather: '暴雨' }],
        narration: '雨顺着破窗灌进来。',
        choices: [
          { id: 'A', text: '贴着墙走向那扇还在响的门', basis: '门还在一下一下地响', quest: 'main' },
          { id: 'B', text: '退回楼梯间，把铁门带上', basis: '身后就是楼梯间', quest: 'new' },
        ],
        over: false,
        canScavenge: true,
        scavengeSafe: false,
        unsafeReason: '门后有动静',
        canSleep: true,
        sleepPlaces: [{ name: '就地', label: '就地 · 走廊', quality: 0, note: '' }],
        canUseItem: true,
        canGiveItem: true,
        canCraft: true,
        usedThisTurn: null,
      })
      setPhase('playing')
      return
    }
    ;(async () => {
      try {
        await api.init() // 初始化 SQLite（加载 WASM + 从 IndexedDB 恢复数据库）
      } catch (e) {
        // 最常见的两种原因都指向"资源没拿到"，因此给一句可操作的提示：
        //   1) 浏览器停留在旧版页面（旧 chunk 已随新版发布被清理）；
        //   2) 网络 / CSP 拦截了同源资源请求。
        notify(`本地数据库初始化失败：${e.message}\n若刚更新过版本，请强制刷新页面（Ctrl/Cmd + Shift + R）后重试。`)
      }

      await loadSettings()

      try {
        const l = await api.latest()
        setLatest(l)
      } catch {
        /* 忽略 */
      }
      setPhase('menu')
      // 主页不再主动弹出 AI 设置：是否配置好通道，由「开始游戏」时的校验把关
    })()
  }, [loadSettings, notify])

  // 调试/自检钩子：默认不挂到 window，仅在（a）开发模式，或（b）URL 带 ?selftest=1
  // 这类显式开关下启用。这样既满足"生产构建不暴露 api/game/settings"的安全要求，
  // 又让 scripts/selftest.mjs 能通过一个显式开关驱动应用做端到端自检。
  useEffect(() => {
    const enabled =
      import.meta.env.DEV || /[?&](selftest|e2e)=1/.test(window.location.search)
    if (!enabled) {
      if (window.__ASHES__) delete window.__ASHES__
      return
    }
    window.__ASHES__ = { api, game, phase, settings }
    return () => {
      delete window.__ASHES__
    }
  }, [game, phase, settings])

  const guardReady = useCallback(() => {
    // 离线体验（mock）与已删除的内置通道（codex）都不能开局
    if (settings && (settings.provider === 'mock' || settings.provider === 'codex' || !settings.ready)) {
      notify('请设置 AI 模型后再开始', 'warn')
      setSettingsOpen(true)
      return false
    }
    return true
  }, [settings, notify])

  const startNew = useCallback(async () => {
    if (!guardReady()) return
    setBusy(true)
    try {
      // 开局前先实测一次 AI 通道：不可用则禁止开局，直接提示去设置模型
      setBusyHint('正在校验 AI 通道…')
      await api.testSettings()
      setBusyHint('正在推演开局…')
      const g = await api.newGame()
      setGame(g)
      setPhase('playing')
    } catch (e) {
      notify(`AI 通道不可用，无法开局：${e.message}`, 'warn')
      setSettingsOpen(true)
    } finally {
      setBusy(false)
      setBusyHint('')
    }
  }, [guardReady, notify])

  const continueGame = useCallback(async () => {
    if (!latest) return
    if (!guardReady()) return
    setBusy(true)
    try {
      const g = await api.getGame(latest.id)
      setGame(g)
      setPhase('playing')
    } catch (e) {
      notify(e.message)
      setLatest(null)
    } finally {
      setBusy(false)
    }
  }, [latest, guardReady, notify])

  const travelTo = useCallback(
    async (dest) => {
      if (!game) return
      setBusy(true)
      try {
        const g = await api.travel(game.id, dest)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      } finally {
        setBusy(false)
      }
    },
    [game, notify],
  )

  const keepDate = useCallback(
    async (appointmentId) => {
      if (!game) return
      setBusy(true)
      try {
        const g = await api.keepAppointment(game.id, appointmentId)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      } finally {
        setBusy(false)
      }
    },
    [game, notify],
  )

  const dropItem = useCallback(
    async (name) => {
      if (!game) return
      try {
        const g = await api.dropItem(game.id, name)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      }
    },
    [game, notify],
  )

  const feedAlly = useCallback(
    async (name) => {
      if (!game) return
      try {
        const g = await api.feedAlly(game.id, name)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      }
    },
    [game, notify],
  )

  const choose = useCallback(
    async (choiceId) => {
      if (!game) return
      setBusy(true)
      try {
        const g = await api.choose(game.id, choiceId)
        setGame(g)
      } catch (e) {
        notify(e.message)
      } finally {
        setBusy(false)
      }
    },
    [game, notify],
  )

  const scavenge = useCallback(async () => {
    if (!game) return
    setBusy(true)
    try {
      const g = await api.scavenge(game.id)
      setGame(g)
    } catch (e) {
      notify(e.message)
    } finally {
      setBusy(false)
    }
  }, [game, notify])

  // 「不搜刮此地」：不消耗时间与体力，只是玩家的一个决定
  const skipScavenge = useCallback(async () => {
    if (!game) return
    setBusy(true)
    try {
      const g = await api.skipScavenge(game.id)
      setGame(g)
      notify('🚶 你决定不在这里翻找——换个地方，或继续推进剧情', 'ok')
    } catch (e) {
      notify(e.message)
    } finally {
      setBusy(false)
    }
  }, [game, notify])

  // 睡觉：夜晚的独立行动，玩家自行决定"睡不睡、睡在哪"
  const sleep = useCallback(async (place) => {
    if (!game) return
    setBusy(true)
    try {
      const g = await api.sleep(game.id, place)
      setGame(g)
    } catch (e) {
      notify(e.message, 'warn')
    } finally {
      setBusy(false)
    }
  }, [game, notify])

  const useItem = useCallback(
    async (itemName, target) => {
      if (!game) return
      setBusy(true)
      try {
        const g = await api.useItem(game.id, itemName, target)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      } finally {
        setBusy(false)
      }
    },
    [game, notify],
  )

  const craft = useCallback(
    async (recipeId) => {
      if (!game) return
      setBusy(true)
      try {
        const g = await api.craft(game.id, recipeId)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      } finally {
        setBusy(false)
      }
    },
    [game, notify],
  )

  const offerTrade = useCallback(
    async (partner) => {
      if (!game) return
      setBusy(true)
      try {
        const g = await api.offerTrade(game.id, partner)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      } finally {
        setBusy(false)
      }
    },
    [game, notify],
  )

  const acceptTrade = useCallback(async () => {
    if (!game) return
    setBusy(true)
    try {
      const g = await api.acceptTrade(game.id)
      setGame(g)
    } catch (e) {
      notify(e.message, 'warn')
    } finally {
      setBusy(false)
    }
  }, [game, notify])

  const declineTrade = useCallback(async () => {
    if (!game) return
    try {
      const g = await api.declineTrade(game.id)
      setGame(g)
    } catch (e) {
      notify(e.message, 'warn')
    }
  }, [game, notify])

  const upgradeShelter = useCallback(
    async (shelterName, slotId) => {
      if (!game) return
      setBusy(true)
      try {
        const g = await api.upgradeShelter(game.id, shelterName, slotId)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      } finally {
        setBusy(false)
      }
    },
    [game, notify],
  )

  const giveItem = useCallback(
    async (itemName, targetName) => {
      if (!game) return
      setBusy(true)
      try {
        const g = await api.giveItem(game.id, itemName, targetName)
        setGame(g)
      } catch (e) {
        notify(e.message, 'warn')
      } finally {
        setBusy(false)
      }
    },
    [game, notify],
  )

  const backToMenu = useCallback(async () => {
    setGame(null)
    setPhase('menu')
    try {
      setLatest(await api.latest())
    } catch {
      /* 忽略 */
    }
  }, [])

  const saveSettings = useCallback(
    async (patch) => {
      const saved = await api.saveSettings(patch)
      setSettings(saved)
      return saved
    },
    [],
  )

  /** 数据备份：把整个 SQLite 数据库导出为 .sqlite 文件 */
  const exportDb = useCallback(async () => {
    try {
      const bytes = await api.exportDb()
      const blob = new Blob([bytes], { type: 'application/x-sqlite3' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ashes-remain-${new Date().toISOString().slice(0, 10)}.sqlite`
      a.click()
      URL.revokeObjectURL(url)
      notify('已导出 .sqlite 备份文件', 'ok')
    } catch (e) {
      notify(`导出失败：${e.message}`)
    }
  }, [notify])

  /** 数据导入：用 .sqlite 文件覆盖当前全部存档与配置（需二次确认，导入后刷新） */
  const importDb = useCallback(
    async (file) => {
      if (!window.confirm('⚠️ 导入会覆盖当前全部存档与配置，且不可恢复。确定继续？')) return
      try {
        const buf = new Uint8Array(await file.arrayBuffer())
        await api.importDb(buf)
        notify('导入成功，正在刷新…', 'ok')
        setTimeout(() => window.location.reload(), 700)
      } catch (e) {
        notify(`导入失败：${e.message}`)
      }
    },
    [notify],
  )

  return (
    <div className="screen">
      {phase === 'boot' && (
        <div className="menu">
          <div className="menu-badge">Initializing</div>
          <h1 className="menu-title">灰烬余生</h1>
          <div className="menu-sub">ASHES · REMAIN</div>
        </div>
      )}

      {phase === 'menu' && (
        <StartScreen
          settings={settings}
          latest={latest}
          busy={busy}
          busyHint={busyHint}
          notify={notify}
          onStart={startNew}
          onContinue={continueGame}
          onOpenSettings={() => setSettingsOpen(true)}
          onDiscard={async () => {
            if (latest) await api.remove(latest.id).catch(() => {})
            setLatest(null)
          }}
        />
      )}

      {phase === 'playing' && game && (
        <GameScreen
          game={game}
          busy={busy}
          onChoose={choose}
          onTravel={travelTo}
          onKeep={keepDate}
          onFeed={feedAlly}
          onDrop={dropItem}
          onScavenge={scavenge}
          onSkipScavenge={skipScavenge}
          onSleep={sleep}
          onUseItem={useItem}
          onGiveItem={giveItem}
          onCraft={craft}
          onOfferTrade={offerTrade}
          onAcceptTrade={acceptTrade}
          onDeclineTrade={declineTrade}
          onUpgrade={upgradeShelter}
          onBack={backToMenu}
          onOpenSettings={() => setSettingsOpen(true)}
          onExportDb={exportDb}
          onImportDb={importDb}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
          onTest={(draft) => api.testSettings(draft)}
          notify={notify}
        />
      )}

      {toast && (
        <div className="toast">
          <div className={`banner ${toast.type}`}>{toast.message}</div>
        </div>
      )}
    </div>
  )
}
