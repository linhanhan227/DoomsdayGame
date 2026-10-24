import React, { useEffect, useMemo, useRef, useState } from 'react'
import EndingScreen from './EndingScreen.jsx'

const TARGET_SELF = '自己'
const TARGET_HERE = '就地使用'

/* 天气图标（与引擎 WEATHERS 的 kind 对应） */
const WEATHER_ICON = {
  clear: '☀',
  cloudy: '⛅',
  overcast: '☁',
  fog: '🌫',
  rain: '🌧',
  storm: '⛈',
  thunder: '🌩',
  snow: '❄',
  blizzard: '🌨',
}
const weatherIcon = (kind) => WEATHER_ICON[kind] || '🌤'

/* 睡觉地点面板：夜里由玩家自己决定"睡不睡、睡在哪"。
   地点质量直接决定恢复量与夜里出事的概率。 */
function SleepPicker({ places, busy, onConfirm, onClose }) {
  const list = places || []
  const [place, setPlace] = useState(list[0]?.name || '')
  const cur = list.find((p) => p.name === place) || list[0]

  const meta = (q) =>
    q >= 3
      ? { label: '稳固', cls: 'q3', icon: '🏠', desc: '有同伴守夜 / 加固过 / 极其隐蔽' }
      : q === 2
        ? { label: '尚可', cls: 'q2', icon: '🏠', desc: '能反锁、有遮挡、暂时没人知道' }
        : q === 1
          ? { label: '勉强', cls: 'q1', icon: '🏠', desc: '能挡风，但门锁不牢、位置暴露' }
          : { label: '就地', cls: 'q0', icon: '🌙', desc: '没有遮挡也没有门锁——任何动静都会先找到你' }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="target-panel" onClick={(e) => e.stopPropagation()}>
        <div className="target-head">
          <div className="target-title">😴 在哪里睡？</div>
          <div className="target-item-note">
            睡到天亮（06:00）。地点越可靠，体力与精神恢复得越多、夜里出事的概率越低；
            就地过夜是最危险的选项——但有时你没得选。
          </div>
          {cur && (
            <div className="target-fits">
              <span>当前选择</span>
              <b>{cur.label}</b>
              <em>——{meta(cur.quality).desc}</em>
            </div>
          )}
        </div>

        <div className="target-list">
          {list.map((p) => {
            const q = meta(p.quality)
            return (
              <button
                key={p.name}
                className={`target-option ${place === p.name ? 'active' : ''}`}
                onClick={() => setPlace(p.name)}
                disabled={busy}
              >
                <span className="target-icon">{q.icon}</span>
                <span className="target-body">
                  <span className="target-name">
                    {p.label}
                    <span className={`sleep-q ${q.cls}`}>{q.label}</span>
                  </span>
                  <span className="target-desc">{p.note || q.desc}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="target-foot">
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            再撑一会儿
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onConfirm(place)}
            disabled={busy || !place}
          >
            {busy ? '正在入睡…' : '在这里睡下'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* 对象选择面板：先选「给谁用 / 交给谁」，再确认动作。
   —— 物品的效果不取决于物品，而取决于对象与方法，这一步不能省。 */
function TargetPicker({ title, item, mode, targets, allies, busy, onConfirm, onClose }) {
  const [target, setTarget] = useState(TARGET_SELF)
  const allyOf = (name) => allies.find((a) => a.name === name)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="target-panel" onClick={(e) => e.stopPropagation()}>
        <div className="target-head">
          <div className="target-title">{title}</div>
          <div className="target-item">
            <span className={`bag-cat-inline`}>{item.category || '杂物'}</span>
            {item.name}
            {item.qty > 1 && <span className="bag-item-qty">×{item.qty}</span>}
          </div>
          {item.note && <div className="target-item-note">{item.note}</div>}
          {item.fits && (
            <div className="target-fits">
              <span>适用对象</span>
              <b>{item.fits}</b>
              <em>——对象不符可能反受其害</em>
            </div>
          )}
          {!item.fits && (
            <div className="target-fits">
              <span>适用对象</span>
              <b>未知</b>
              <em>——世界引擎会按常识现场裁断</em>
            </div>
          )}
        </div>

        <div className="target-list">
          {targets.map((name) => {
            const isSelf = name === TARGET_SELF
            const isHere = name === TARGET_HERE
            const ally = allyOf(name)
            return (
              <button
                key={name}
                className={`target-option ${target === name ? 'active' : ''}`}
                onClick={() => setTarget(name)}
                disabled={busy}
              >
                <span className="target-icon">
                  {isSelf ? '🧍' : isHere ? '🧰' : '👥'}
                </span>
                <span className="target-body">
                  <span className="target-name">
                    {isSelf ? '主角自己' : isHere ? '就地使用' : name}
                  </span>
                  <span className="target-desc">
                    {isSelf
                      ? mode === 'give'
                        ? '（交出时至少需要一个接收方）'
                        : '按主角自己的实际状况裁决，不符适用对象即产生负面后果'
                      : isHere
                        ? mode === 'give'
                          ? '（交出时此项无意义）'
                          : '用在门锁、车辆、火堆、器物等非人对象上，按物理性质裁决'
                        : `${ally?.status || '同行者'}${ally?.note ? ` · ${ally.note}` : ''}`}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="target-foot">
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onConfirm(target)}
            disabled={busy || (mode === 'give' && target === TARGET_HERE)}
          >
            {mode === 'give' ? `把「${item.name}」交给 ${target === TARGET_SELF ? '…' : target}` : `用「${item.name}」（对象：${target}）`}
          </button>
        </div>
      </div>
    </div>
  )
}

/* 打字机：仅用于"最新一段"叙事，营造现场推演的节奏感 */
function Typewriter({ text, speed = 16, onDone }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    if (!text) return
    let i = 0
    const step = Math.max(1, Math.round(text.length / 900)) // 长文加速
    const timer = setInterval(() => {
      i += step
      if (i >= text.length) {
        setN(text.length)
        clearInterval(timer)
        onDone?.()
      } else {
        setN(i)
      }
    }, speed)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, speed])
  return (
    <span>
      {text.slice(0, n)}
      {n < text.length && <span className="caret" />}
    </span>
  )
}

const STAT_META = [
  { key: 'hp', label: '生命', cls: 's-hp' },
  { key: 'hunger', label: '饥饿', cls: 's-hunger' },
  { key: 'thirst', label: '口渴', cls: 's-thirst' },
  { key: 'sanity', label: '精神', cls: 's-sanity' },
  { key: 'stamina', label: '体力', cls: 's-stamina' },
  // 感染：未感染时不占位，一旦感染才出现——把"病毒"做成真实的压迫感
  { key: 'infection', label: '感染', cls: 's-infection', onlyPositive: true },
]

/** 背包分类的展示顺序与配色（未命中者归入「杂物」） */
const CATEGORY_META = [
  { name: '武器', cls: 'cat-weapon' },
  { name: '弹药', cls: 'cat-ammo' },
  { name: '药品', cls: 'cat-med' },
  { name: '食物', cls: 'cat-food' },
  { name: '饮水', cls: 'cat-drink' },
  { name: '工具', cls: 'cat-tool' },
  { name: '衣物', cls: 'cat-cloth' },
  { name: '杂物', cls: 'cat-misc' },
]

/** 按分类把背包分组；返回的组别保持 CATEGORY_META 的顺序，空组不返回 */
function groupInventory(inventory = []) {
  const known = new Set(CATEGORY_META.map((c) => c.name))
  const buckets = new Map()
  for (const it of inventory) {
    const c = known.has(it.category) ? it.category : '杂物'
    if (!buckets.has(c)) buckets.set(c, [])
    buckets.get(c).push(it)
  }
  return CATEGORY_META.filter((c) => buckets.has(c.name)).map((c) => ({
    ...c,
    items: buckets.get(c.name),
  }))
}

/** 顶栏「背包」弹层：背包不再常驻侧栏，点顶栏按钮才展开，节约主界面空间 */
function BagPanel({ game, busy, onPick, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">🎒 背包</div>
          <div className="panel-sub">
            {game.usedThisTurn
              ? `本回合已处理「${game.usedThisTurn}」，推进剧情后才能再动背包`
              : game.inventory.length
                ? '可「使用」或「交出」一件物品（每回合 1 次）'
                : '两手空空'}
          </div>
          <button className="panel-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {game.inventory.length ? (
            <div className="bag">
              {groupInventory(game.inventory).map((grp) => (
                <div className="bag-group" key={grp.name}>
                  <div className={`bag-cat ${grp.cls}`}>{grp.name}</div>
                  {grp.items.map((it) => {
                    const disabled = busy || !game.canUseItem
                    return (
                      <div className="bag-item" key={it.name}>
                        <div className="bag-item-main">
                          <span className="bag-item-title">
                            <span className="bag-item-name">{it.name}</span>
                            {it.qty > 1 && <span className="bag-item-qty">×{it.qty}</span>}
                          </span>
                          <span className="bag-btns">
                            <button
                              className="bag-use"
                              disabled={disabled}
                              onClick={() => onPick({ mode: 'use', item: it })}
                              title={
                                game.usedThisTurn
                                  ? `本回合已经处理过「${game.usedThisTurn}」了`
                                  : '使用这件物品：先选对象，再消耗 0.5 小时与少量体力'
                              }
                            >
                              使用
                            </button>
                            <button
                              className="bag-give"
                              disabled={disabled || !game.canGiveItem}
                              onClick={() => onPick({ mode: 'give', item: it })}
                              title={
                                game.usedThisTurn
                                  ? `本回合已经处理过「${game.usedThisTurn}」了`
                                  : game.canGiveItem
                                    ? '交给某个具体的人，换取回报、情报或人情'
                                    : '身边没有人可以接收'
                              }
                            >
                              交出
                            </button>
                          </span>
                        </div>
                        {(it.fits || it.tradable) && (
                          <div className="bag-item-tags">
                            {it.fits && <span className="bag-item-fits">适用：{it.fits}</span>}
                            {it.tradable && <span className="bag-item-trade-tag">可交换</span>}
                          </div>
                        )}
                        {it.note && <div className="bag-item-note">{it.note}</div>}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">两手空空</div>
          )}
        </div>
        <div className="bag-foot">每回合可使用或交出 1 件物品 · 消耗 0.5 小时与少量体力 · 「使用」需先选定对象</div>
      </div>
    </div>
  )
}

/** 顶栏「剧情标记」弹层：世界目前记住的关键事实与伏笔 */
/** 制作：列出能做和还缺材料的配方。材料按分类匹配，按钮上写明这次会用掉哪几件。 */
function CraftPanel({ game, busy, onCraft, onClose }) {
  const recipes = game.recipes || []
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">🔧 制作</div>
          <div className="panel-sub">
            {game.usedThisTurn ? `本回合已处理「${game.usedThisTurn}」` : '材料够就能做。做成之后本回合不能再动手。'}
          </div>
          <button className="panel-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="panel-body">
          {recipes.map((r) => (
            <div className="bag-item" key={r.id}>
              <div className="bag-item-main">
                <span className="bag-item-title">
                  <span className="bag-item-name">{r.name}</span>
                  <span className="bag-item-qty">{r.category}</span>
                </span>
                <button
                  className="bag-use"
                  disabled={busy || !game.canCraft || !r.affordable}
                  onClick={() => onCraft(r.id)}
                  title={r.affordable ? `用掉 ${r.using.join('、')}，花 ${r.hours} 小时` : `还缺：${r.need.join('、')}`}
                >
                  {r.affordable ? '制作' : '缺材料'}
                </button>
              </div>
              <div className="bag-item-note">
                {r.note} · 需要 {r.need.join('、')}
                {r.using?.length ? ` · 将用 ${r.using.join('、')}` : ''}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 据点：每个已知落脚点能装的四件加固，装过的不再出现。 */
function ShelterPanel({ game, busy, onUpgrade, onClose }) {
  const list = game.sheltersDetail || []
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">🏠 据点</div>
          <div className="panel-sub">门和床都装上之后，这里过夜的质量会高一档，上限 3。</div>
          <button className="panel-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="panel-body">
          {list.length === 0 && <div className="empty">还没有已知的落脚点。叙事里确立一处能过夜的地方之后，它会出现在这里。</div>}
          {list.map((s) => (
            <div className="bag-group" key={s.name}>
              <div className="bag-cat">{s.name} · 质量 {s.effectiveQuality}</div>
              {s.installed?.length > 0 && <div className="bag-item-note">已有：{s.installed.join('、')}</div>}
              {(s.next || []).map((slot) => (
                <div className="bag-item" key={slot.id}>
                  <div className="bag-item-main">
                    <span className="bag-item-name">{slot.label}</span>
                    <button
                      className="bag-use"
                      disabled={busy || !game.canCraft || !slot.affordable}
                      onClick={() => onUpgrade(s.name, slot.id)}
                      title={`需要 ${slot.need.join('、')}，花 ${slot.hours} 小时`}
                    >
                      {slot.affordable ? '加固' : '缺材料'}
                    </button>
                  </div>
                  <div className="bag-item-note">需要 {slot.need.join('、')}</div>
                </div>
              ))}
              {(s.next || []).length === 0 && <div className="empty">这里能装的都装上了</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 交易：先向某人开口要一份报价，再决定成交还是走开。 */
function TradePanel({ game, busy, onOffer, onAccept, onDecline, onClose }) {
  const partners = ['路过的人', ...(game.tradePartners || [])]
  const offer = game.tradeOffer
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">🤝 交易</div>
          <div className="panel-sub">用背包里能换的东西换一件具体的回报。成交才换手。</div>
          <button className="panel-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="panel-body">
          {offer ? (
            <div className="bag-item">
              <div className="bag-item-name">
                {offer.partner} 要用你的「{offer.give?.name}」换「{offer.get?.name}」
              </div>
              <div className="bag-item-note">{offer.get?.note || ''}</div>
              <span className="bag-btns">
                <button className="bag-use" disabled={busy || !game.canCraft} onClick={onAccept}>成交</button>
                <button className="bag-give" disabled={busy} onClick={onDecline}>走开</button>
              </span>
            </div>
          ) : (
            partners.map((name) => (
              <div className="bag-item" key={name}>
                <div className="bag-item-main">
                  <span className="bag-item-name">{name}</span>
                  <button className="bag-use" disabled={busy || !game.canTrade} onClick={() => onOffer(name)}>
                    开口
                  </button>
                </div>
              </div>
            ))
          )}
          {!game.canTrade && !offer && <div className="empty">背包里没有能拿去换的食物、药品、弹药，或标了可交换的东西。</div>}
        </div>
      </div>
    </div>
  )
}

/** 技能：四项经验与等级。等级由引擎结算，这里只展示。 */
function SkillsPanel({ skills, onClose }) {
  const list = skills || {}
  const order = ['scavenge', 'combat', 'craft', 'social']
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">📈 技能</div>
          <div className="panel-sub">每 40 点经验升一级，上限 5 级。升级只改掉率、受伤、感染和交易，不改剧情。</div>
          <button className="panel-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="panel-body">
          {order.map((id) => {
            const s = list[id] || { xp: 0, level: 0, label: id, effect: '' }
            return (
              <div className="bag-item" key={id}>
                <div className="bag-item-main">
                  <span className="bag-item-name">{s.label}</span>
                  <span className="bag-item-qty">{s.level} 级 · {s.xp} 经验</span>
                </div>
                <div className="bag-item-note">{s.effect}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function FlagsPanel({ flags, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">🚩 剧情标记</div>
          <div className="panel-sub">世界目前记住的关键事实与伏笔（共 {flags.length} 条）</div>
          <button className="panel-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="chips">
            {flags.map((f) => (
              <span className="chip" key={f}>
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 顶栏「状况」弹层：身体与精神状况（异常状态清单） */
function ConditionsPanel({ conditions, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">🩹 身体与精神状况</div>
          <div className="panel-sub">
            {conditions.length ? `当前 ${conditions.length} 项异常状态` : '各项体征平稳'}
          </div>
          <button className="panel-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {conditions.length ? (
            <div className="chips">
              {conditions.map((c) => (
                <span className="chip warn" key={c}>
                  {c}
                </span>
              ))}
            </div>
          ) : (
            <div className="empty">暂无异常</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 顶栏「病毒」弹层：感染状态 + 病毒谱系（两者同属病毒线，合并收纳） */
function VirusPanel({ game, onClose }) {
  const infected = game.stats.infection > 0
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">🧬 病毒与感染</div>
          <div className="panel-sub">
            {infected ? `感染值 ${game.stats.infection}/100 · 病程：${game.infectionStage}` : '尚未感染'}
          </div>
          <button className="panel-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {infected && (
            <div className="virus-section">
              <div className="virus-label">感染状态 · K-17</div>
              <div className="s-infection">
                <div className="stat-bar" style={{ marginTop: 8 }}>
                  <div className="stat-fill" style={{ width: `${game.stats.infection}%` }} />
                </div>
              </div>
              <div className="infection-note">感染值 {game.stats.infection}/100 · 达到 100 将不可逆尸化</div>
            </div>
          )}
          {game.mutations?.length > 0 && (
            <div className="virus-section">
              <div className="virus-label">病毒谱系 · G{game.virusGeneration}</div>
              {game.mutations.map((m) => (
                <div className="mutation" key={m.name}>
                  <div className="mutation-name">{m.name}</div>
                  {m.traits && <div className="mutation-traits">{m.traits}</div>}
                  {m.note && <div className="mutation-note">首次出现：{m.note}</div>}
                </div>
              ))}
            </div>
          )}
          {!infected && !(game.mutations?.length > 0) && <div className="empty">尚无病毒迹象</div>}
        </div>
      </div>
    </div>
  )
}

/** 顶栏「同行者」弹层：当前同行的人与其状态 */
function AlliesPanel({ allies, canFeed, busy, onFeed, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="bag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">👥 同行者</div>
          <div className="panel-sub">{allies.length ? `同行 ${allies.length} 人` : '目前独自一人'}</div>
          <button className="panel-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {allies.length ? (
            <div className="ally-list">
              {allies.map((a) => (
                <div className="ally-row" key={a.name}>
                  <b>{a.name}</b>
                  <span>
                    {a.status}
                    {a.hunger != null ? ` · 饥饿 ${a.hunger}` : ''}
                    {a.infection ? ` · 感染 ${a.infection}` : ''}
                    {a.note ? ` · ${a.note}` : ''}
                  </span>
                  {canFeed && (
                    <button className="bag-use" disabled={busy} onClick={() => onFeed(a.name)}>
                      分一口吃的
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">独自一人</div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ==================================================================
   区域地图（绘制式，非文字地图）
   ------------------------------------------------------------------
   地图不是"地点清单"，而是一张**画出来的图**：
     · 地形（街区 / 街道 / 未探明区）由会话 id 播种生成——同一局地形稳定不变，换一局换一张图；
     · 每个已探明地点是地图上的一个节点，节点位置由引擎分配（引擎负责"在哪"，界面负责"怎么画"）；
     · 当前位置高亮并带脉冲环；已知落脚点单独标记；从当前位置到各落脚点画出虚线路径。
   节点只包含引擎给出的纯数据（name / type / x / y / shelter / visits），
   图标与配色一律在这里决定，保持引擎与界面解耦。
   ================================================================== */

/** 地图画布尺寸（与引擎的槽位坐标范围对应） */
const MAP_W = 640
const MAP_H = 420

/** 地点类型 → 徽标字符 + 配色（一个汉字最稳，任何字体都能渲染） */
const NODE_TYPE_META = {
  hospital: { glyph: '医', label: '医疗', color: '#7fd1a8' },
  market: { glyph: '商', label: '商超', color: '#d9b25e' },
  police: { glyph: '警', label: '警务', color: '#6fa8dc' },
  military: { glyph: '军', label: '军事', color: '#9aa7bd' },
  school: { glyph: '学', label: '学校', color: '#b39ddb' },
  transit: { glyph: '交', label: '交通', color: '#7fb2c4' },
  fuel: { glyph: '油', label: '加油', color: '#e0a06a' },
  factory: { glyph: '工', label: '工业', color: '#a3aaa4' },
  office: { glyph: '政', label: '机构', color: '#9fb6c9' },
  park: { glyph: '园', label: '开阔地', color: '#86d96b' },
  home: { glyph: '宅', label: '居住', color: '#c9a882' },
  other: { glyph: '地', label: '其他', color: '#8b968f' },
}
const nodeMeta = (type) => NODE_TYPE_META[type] || NODE_TYPE_META.other

/**
 * 地图上的短标签：长地名（如「城南 · 市立医院 · 急诊走廊」）在图上会互相压字，
 * 因此只取最后一段并截断；完整名称通过 <title> 悬浮显示。
 */
function shortLabel(name) {
  const full = String(name || '')
  const parts = full.split(/[·・/|>→]/).map((s) => s.trim()).filter(Boolean)
  let s = parts.length > 1 ? parts[parts.length - 1] : full.trim()
  if (!s) s = full.trim()
  return s.length > 8 ? `${s.slice(0, 8)}…` : s
}

/** 以字符串播种的确定性随机数（mulberry32）：同一局的地形每次都一样 */
function makeRng(seedStr) {
  let h = 2166136261 >>> 0
  const s = String(seedStr || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return () => {
    h = (h + 0x6d2b79f5) >>> 0
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 生成城市地形骨架：街区块 + 街道网（纯装饰，不参与任何判定） */
function buildTerrain(seed) {
  const rng = makeRng(seed)
  const blocks = []
  for (let i = 0; i < 11; i++) {
    const w = 58 + rng() * 74
    const h = 42 + rng() * 56
    blocks.push({
      x: Math.round(18 + rng() * (MAP_W - w - 36)),
      y: Math.round(18 + rng() * (MAP_H - h - 36)),
      w: Math.round(w),
      h: Math.round(h),
      hi: rng() > 0.62,
    })
  }
  const roads = []
  // 纵向街道
  for (let i = 1; i <= 3; i++) {
    const x = Math.round(48 + i * 148 + (rng() - 0.5) * 26)
    roads.push({ x1: x, y1: 12, x2: x, y2: MAP_H - 12, w: Math.round(10 + rng() * 7) })
  }
  // 横向街道
  for (let i = 1; i <= 2; i++) {
    const y = Math.round(56 + i * 122 + (rng() - 0.5) * 22)
    roads.push({ x1: 12, y1: y, x2: MAP_W - 12, y2: y, w: Math.round(9 + rng() * 6) })
  }
  return { blocks, roads }
}

/** 区域地图主体：一张 SVG 绘制的地图 */
function WorldMap({ game }) {
  const nodes = game.mapNodes || []
  const terrain = useMemo(() => buildTerrain(game.id), [game.id])
  const current = nodes.find((n) => n.name === game.location) || null
  const shelters = nodes.filter((n) => n.shelter && n.name !== game.location)
  const presentTypes = [...new Set(nodes.map((n) => n.type))]

  // 行进轨迹：按剧情推进顺序取出到访节点的坐标（跳过已不在图上的节点与连续重复点）。
  // 这就是"地图随剧情发展更新当前位置"的可视化——每移动一次，路线就延长一段。
  const trail = useMemo(() => {
    const byName = new Map(nodes.map((n) => [n.name, n]))
    const pts = []
    for (const name of game.locationTrail || []) {
      const n = byName.get(name)
      if (!n) continue
      const last = pts[pts.length - 1]
      if (last && last.name === n.name) continue
      pts.push(n)
    }
    return pts
  }, [game.locationTrail, nodes])

  return (
    <>
      <div className="map-wrap">
        <svg className="worldmap" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="当前区域地图">
          <defs>
            <pattern id="mapFog" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="10" height="10" fill="#0b100e" />
              <line x1="0" y1="0" x2="0" y2="10" stroke="#1b2420" strokeWidth="3" />
            </pattern>
            <radialGradient id="mapVignette" cx="50%" cy="50%" r="72%">
              <stop offset="60%" stopColor="#000" stopOpacity="0" />
              <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
            </radialGradient>
          </defs>

          {/* 底图 */}
          <rect x="0" y="0" width={MAP_W} height={MAP_H} fill="#0e1412" />

          {/* 街区 */}
          <g>
            {terrain.blocks.map((b, i) => (
              <rect
                key={`b${i}`}
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx="3"
                className={b.hi ? 'map-block-hi' : 'map-block'}
              />
            ))}
          </g>

          {/* 街道 */}
          <g>
            {terrain.roads.map((r, i) => (
              <line
                key={`r${i}`}
                x1={r.x1}
                y1={r.y1}
                x2={r.x2}
                y2={r.y2}
                stroke="#1f2823"
                strokeWidth={r.w}
                strokeLinecap="round"
              />
            ))}
            {terrain.roads.map((r, i) => (
              <line
                key={`rc${i}`}
                x1={r.x1}
                y1={r.y1}
                x2={r.x2}
                y2={r.y2}
                stroke="#2a342e"
                strokeWidth="1"
                strokeDasharray="8 10"
                strokeLinecap="round"
              />
            ))}
          </g>

          {/* 未探明区域：四边留出雾区，传达"这张图还不完整" */}
          <g className="map-fog">
            <rect x="0" y="0" width={MAP_W} height="16" fill="url(#mapFog)" />
            <rect x="0" y={MAP_H - 16} width={MAP_W} height="16" fill="url(#mapFog)" />
            <rect x="0" y="0" width="16" height={MAP_H} fill="url(#mapFog)" />
            <rect x={MAP_W - 16} y="0" width="16" height={MAP_H} fill="url(#mapFog)" />
          </g>

          {/* 当前位置 → 各落脚点的虚线路径 */}
          <g>
            {current &&
              shelters.map((s) => (
                <line
                  key={`p-${s.name}`}
                  x1={current.x}
                  y1={current.y}
                  x2={s.x}
                  y2={s.y}
                  className="map-route"
                />
              ))}
          </g>

          {/* 行进轨迹：按剧情推进顺序把到访地点连起来——地图随剧情发展不断延长 */}
          {trail.length > 1 && (
            <g>
              <polyline className="map-trail" points={trail.map((p) => `${p.x},${p.y}`).join(' ')} />
              {trail.slice(0, -1).map((p, i) => (
                <circle key={`tw${i}`} className="map-trail-dot" cx={p.x} cy={p.y} r="2.6" />
              ))}
            </g>
          )}

          {/* 地点节点 */}
          <g>
            {nodes.map((n) => {
              const meta = nodeMeta(n.type)
              const isCur = n.name === game.location
              return (
                <g key={n.name}>
                  <title>{`${n.name}（${meta.label}${n.shelter ? ' · 已知落脚点' : ''}${n.visits > 1 ? ` · 到过 ${n.visits} 次` : ''}）`}</title>
                  {isCur && <circle cx={n.x} cy={n.y} r="19" className="map-current-ring" />}
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={isCur ? 12 : 9}
                    fill={meta.color}
                    fillOpacity={isCur ? 1 : n.visits > 0 ? 0.86 : 0.5}
                    stroke={isCur ? '#ffd9bd' : '#0a0c0b'}
                    strokeWidth={isCur ? 2 : 1.5}
                  />
                  <text x={n.x} y={n.y + 4} textAnchor="middle" className="map-node-glyph" fill="#0a0c0b">
                    {meta.glyph}
                  </text>
                  <text x={n.x} y={n.y + (isCur ? 28 : 24)} textAnchor="middle" className="map-node-label">
                    {shortLabel(n.name)}
                  </text>
                  {isCur ? (
                    <text x={n.x} y={n.y - 20} textAnchor="middle" className="map-node-cur">
                      当前位置
                    </text>
                  ) : n.shelter ? (
                    <text x={n.x} y={n.y - 17} textAnchor="middle" className="map-node-tag">
                      ⌂ 落脚点
                    </text>
                  ) : null}
                </g>
              )
            })}
          </g>

          {/* 晕影 + 指北针 */}
          <rect x="0" y="0" width={MAP_W} height={MAP_H} fill="url(#mapVignette)" pointerEvents="none" />
          <g className="map-compass" transform={`translate(${MAP_W - 40} 40)`}>
            <circle r="15" />
            <path d="M0,-11 L4.5,4 L0,0.5 L-4.5,4 Z" />
            <text y="-19" textAnchor="middle">N</text>
          </g>
        </svg>
      </div>

      <div className="map-legend">
        {presentTypes.map((t) => {
          const m = nodeMeta(t)
          return (
            <span className="map-legend-item" key={t}>
              <span className="map-legend-dot" style={{ background: m.color }}>
                {m.glyph}
              </span>
              {m.label}
            </span>
          )
        })}
        <span className="map-legend-item">
          <span className="map-legend-dot map-legend-cur">◎</span>当前位置
        </span>
        <span className="map-legend-item">
          <span className="map-legend-dot map-legend-home">⌂</span>已知落脚点
        </span>
        <span className="map-legend-item">
          <span className="map-legend-dot map-legend-trail">〰</span>行进轨迹
        </span>
      </div>
    </>
  )
}

/** 顶栏「地图」弹层：绘制当前区域地图（非文字地图） */
function MapPanel({ game, busy, onTravel, onClose }) {
  const nodes = game.mapNodes || []
  const shelters = nodes.filter((n) => n.shelter)
  const trailLen = (game.locationTrail || []).length
  return (
    <div className="overlay" onClick={onClose}>
      <div className="map-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title">🗺 区域地图</div>
          <div className="panel-sub">
            当前所在：{game.location} · 已探明 {nodes.length} 处，落脚点 {shelters.length} 处
            {trailLen > 1 ? ` · 已走过 ${trailLen} 段路` : ''}
          </div>
          <button className="panel-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="panel-body map-body">
          {nodes.length ? (
            <>
              <WorldMap game={game} />
              <div className="chips" style={{ marginTop: 12 }}>
                {(game.travelTargets || []).map((t) => (
                  <button
                    className="btn btn-ghost btn-sm"
                    key={t.name}
                    disabled={busy}
                    onClick={() => {
                      onTravel(t.name)
                      onClose()
                    }}
                    title={`大约 ${t.hours} 小时，消耗 ${t.stamina} 点体力`}
                  >
                    前往 {t.name} · {t.hours} 小时
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">地图上还没有任何记录——你尚未探明这片区域的任何地方。</div>
          )}
        </div>
        <div className="bag-foot">
          地图随剧情发展：每移动一次，<b>当前位置</b>就跟着变，走过的路会连成一条轨迹；每抵达或听说一处新地点，它就会出现在图上。
          虚线表示从这里通往各个已知落脚点的路。
        </div>
      </div>
    </div>
  )
}

export default function GameScreen({
  game,
  busy,
  onChoose,
  onTravel,
  onKeep,
  onFeed,
  onScavenge,
  onSkipScavenge,
  onSleep,
  onUseItem,
  onGiveItem,
  onCraft,
  onOfferTrade,
  onAcceptTrade,
  onDeclineTrade,
  onUpgrade,
  onBack,
  onOpenSettings,
  onExportDb,
  onImportDb,
}) {
  const endRef = useRef(null)
  const [typing, setTyping] = useState(false)
  const [picker, setPicker] = useState(null) // { mode:'use'|'give', item }
  const [panel, setPanel] = useState(null) // 'bag' | 'flags' | 'conditions' | 'allies' | 'virus'：顶栏收纳面板
  const [sleepOpen, setSleepOpen] = useState(false) // 睡觉地点面板
  const log = game.log || []
  const sleepPlaces = game.sleepPlaces || []

  // 主界面只展示最新一回合的事件（含本回合的搜刮 / 用物条目），往期回合不再堆积占位
  const lastTurn = log.length ? log[log.length - 1].turn : null
  const visibleLog = lastTurn === null ? [] : log.filter((e) => e.turn === lastTurn)

  useEffect(() => {
    if (game.narration) setTyping(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.turn, game.id])

  useEffect(() => {
    if (!typing) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [typing, log.length, busy])

  // 背包里的对象候选：自己 / 每位同行者 / 就地使用
  const targetOptions = [TARGET_SELF, ...(game.allies || []).map((a) => a.name), TARGET_HERE]

  const confirmPicker = (target) => {
    if (!picker) return
    if (picker.mode === 'give') onGiveItem(picker.item.name, target)
    else onUseItem(picker.item.name, target)
    setPicker(null)
    setPanel(null) // 动作已发出，收起背包面板，让结果叙事直接可见
  }

  return (
    <div className={`game ${game.isNight ? 'is-night' : ''}`}>
      <div className="topbar">
        <div className="topbar-row topbar-main">
          <div className="topbar-meta">
            <span>
              爆发第 <b>{game.day}</b> 天
            </span>
            <span>{game.collapseStage}</span>
            <span
              className={`phase-chip ${game.isNight ? 'night' : game.dayPhase === '黄昏' ? 'dusk' : 'day'}`}
              title={game.timePhrase || ''}
            >
              {game.isNight ? '🌙' : game.dayPhase === '黄昏' ? '🌆' : '☀'} {game.clock || game.timeOfDay}
              <span className="phase-sub">{game.dayPhase}</span>
            </span>
            {game.weather && (
              <span className={`weather-chip w-${game.weather.kind}`} title={game.weather.note || ''}>
                {weatherIcon(game.weather.kind)} {game.weather.label}
              </span>
            )}
            <span className="loc-chip">📍 {game.location}</span>
            {game.protagonist && <span>🧍 {game.protagonist.name}</span>}
            <span>回合 {game.turn}</span>
            {game.mutations?.length > 0 && (
              <span>
                🧬 病毒世代 <b>G{game.virusGeneration}</b>
              </span>
            )}
          </div>
          <div className="topbar-spacer" />
          <div className="stats">
            {STAT_META.filter((s) => !s.onlyPositive || (game.stats[s.key] ?? 0) > 0).map((s) => {
              const v = game.stats[s.key] ?? 0
              const label = s.key === 'infection' ? `感染·${game.infectionStage}` : s.label
              return (
                <div className={`stat ${s.cls}`} key={s.key}>
                  <div className="stat-head">
                    <b>{label}</b>
                    <span>{v}</span>
                  </div>
                  <div className="stat-bar">
                    <div className="stat-fill" style={{ width: `${v}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="topbar-row topbar-sub">
          <div className="topbar-sub-group">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setPanel('bag')}
              title="打开背包：使用或交出物品"
            >
              🎒 背包<span className="btn-badge">{game.inventory.length}</span>
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPanel('craft')} title="用背包里的材料做东西">
              🔧 制作
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPanel('shelter')} title="给已知落脚点装门、火堆、床、储物">
              🏠 据点<span className="btn-badge">{(game.sheltersDetail || []).length}</span>
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPanel('trade')} title="用东西换东西或情报">
              🤝 交易
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPanel('skills')} title="搜刮、战斗、制作、交涉的等级">
              📈 技能
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setPanel('map')}
              title="查看当前区域地图：已探明的地点、落脚点与你的位置"
            >
              🗺 地图<span className="btn-badge">{(game.mapNodes || []).length}</span>
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setPanel('conditions')}
              title="查看身体与精神状况"
            >
              🩹 状况<span className="btn-badge">{game.conditions.length}</span>
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPanel('allies')} title="查看同行者">
              👥 同行者<span className="btn-badge">{game.allies.length}</span>
            </button>
            {(game.stats.infection > 0 || game.mutations?.length > 0) && (
              <button className="btn btn-ghost btn-sm" onClick={() => setPanel('virus')} title="查看感染状态与病毒谱系">
                🧬 病毒
                <span className="btn-badge">
                  {game.mutations?.length > 0 ? `G${game.virusGeneration}` : game.stats.infection}
                </span>
              </button>
            )}
            {game.flags?.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => setPanel('flags')} title="查看剧情标记">
                🚩 剧情标记<span className="btn-badge">{game.flags.length}</span>
              </button>
            )}
          </div>
          <div className="topbar-sub-group">
            <button
              className="btn btn-ghost btn-sm"
              onClick={onExportDb}
              disabled={busy}
              title="导出全部存档与配置为 .sqlite 文件（可用于备份或换设备迁移）"
            >
              💾 备份
            </button>
            <label
              className="btn btn-ghost btn-sm db-file-label"
              title="从 .sqlite 文件恢复全部存档与配置（会覆盖当前数据）"
            >
              📥 导入
              <input
                type="file"
                accept=".sqlite,.db,application/octet-stream,application/x-sqlite3"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) onImportDb(file)
                }}
              />
            </label>
            <button className="btn btn-ghost btn-sm" onClick={onOpenSettings}>
              设置
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onBack}>
              主菜单
            </button>
          </div>
        </div>
      </div>

      <div className="body">
        <div className="story">
          {visibleLog.map((entry, i) => {
            const isLast = i === visibleLog.length - 1
            const isEndingEntry = entry.kind === 'ending'
            const isScavengeEntry = entry.kind === 'scavenge'
            const isUseEntry = entry.kind === 'useitem'
            const isGiveEntry = entry.kind === 'giveitem'
            const isCraftEntry = entry.kind === 'craft'
            const isTradeEntry = entry.kind === 'trade'
            const isUpgradeEntry = entry.kind === 'upgrade'
            const isAction = isScavengeEntry || isUseEntry || isGiveEntry || isCraftEntry || isTradeEntry || isUpgradeEntry
            const isQuestEntry = entry.kind === 'quest'
            return (
              <div className={`log-entry kind-${entry.kind || 'event'}`} key={`${game.id}-${i}-${entry.turn}`}>
                <div className="log-turn">
                  {isEndingEntry
                    ? '—— 终局 ——'
                    : isScavengeEntry
                      ? '搜刮'
                      : isUseEntry
                        ? '使用物品'
                        : isGiveEntry
                          ? '交出物品'
                          : isCraftEntry
                            ? '制作'
                            : isTradeEntry
                              ? '交易'
                              : isUpgradeEntry
                                ? '加固据点'
                                : isQuestEntry
                                  ? '任务链'
                            : entry.kind === 'opening'
                              ? '开局'
                              : `第 ${entry.turn} 回合`}
                  {entry.day
                    ? ` ｜ 爆发第 ${entry.day} 天 · ${entry.time || ''}${
                        entry.weather ? ` · ${entry.weather}` : ''
                      }`
                    : ''}
                </div>
                {entry.chosen && !isAction && <div className="log-chosen">你的选择：{entry.chosen}</div>}
                <div className={`narration ${isEndingEntry ? 'ending-text' : ''}`}>
                  {isLast && !game.over ? (
                    <Typewriter text={entry.text} onDone={() => setTyping(false)} />
                  ) : (
                    entry.text
                  )}
                </div>
                {isScavengeEntry && entry.loot?.length > 0 && (
                  <div className="log-loot">
                    <span>搜得：</span>
                    {entry.loot.map((l) => (
                      <span className="log-loot-chip" key={l}>
                        {l}
                      </span>
                    ))}
                  </div>
                )}
                {isScavengeEntry && entry.special && (
                  <div className={`log-special special-${entry.special}`}>
                    <span className="log-special-kind">
                      {entry.special === 'danger' ? '⚡ 突发状况' : '✦ 意外收获'}
                    </span>
                    {entry.specialTitle && <span className="log-special-title">{entry.specialTitle}</span>}
                  </div>
                )}
                {isUseEntry && entry.used && (
                  <div className="log-loot">
                    <span>已用：</span>
                    <span className="log-use-chip">{entry.used}</span>
                    {entry.target && <span className="log-target-chip">→ {entry.target}</span>}
                  </div>
                )}
                {isGiveEntry && entry.used && (
                  <div className="log-loot">
                    <span>交出：</span>
                    <span className="log-use-chip">{entry.used}</span>
                    {entry.target && <span className="log-target-chip">→ {entry.target}</span>}
                  </div>
                )}
              </div>
            )
          })}

          {!game.over && (
            <div className="choices">
              {busy || typing ? (
                <div className="thinking">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  {busy ? '世界正在推演下一步…' : '……'}
                </div>
              ) : (
                <>
                  {game.choices.map((c) => (
                    <button
                      key={c.id}
                      className={`choice${c.consume ? ' choice-consume' : ''}`}
                      onClick={() => onChoose(c.id)}
                      disabled={busy}
                    >
                      <span className="choice-key">{c.consume ? '⚠' : c.id}</span>
                      <span className="choice-body">
                        <span className="choice-text">{c.text}</span>
                        {c.basis ? <span className="choice-basis">依据：{c.basis}</span> : null}
                      </span>
                    </button>
                  ))}
                  {game.dueAppointment && (
                    <button
                      className="btn btn-scavenge btn-sm"
                      disabled={busy}
                      onClick={() => onKeep(game.dueAppointment.id)}
                    >
                      赴约 · {game.dueAppointment.who}
                      <span className="aux-hint">{game.dueAppointment.note}</span>
                    </button>
                  )}
                  <div className="aux-actions">
                    {!game.over && (
                      <div className="aux-row">
                        <button
                          className={`btn btn-scavenge btn-sm${game.scavengeSafe ? '' : ' is-risky'}`}
                          onClick={onScavenge}
                          disabled={busy || game.scavengeExhausted || game.scavengeSkipped}
                          title={
                            game.scavengeExhausted
                              ? '这个地点已经没有任何可翻的东西了'
                              : game.scavengeSkipped
                                ? '你已经决定不在这里翻找（换个地点后可重新选择）'
                                : game.scavengeSafe
                                  ? '翻找此地物资：消耗 1.5 小时与体力，产出按概率掉落，可能一无所获'
                                  : `局势危险${game.unsafeReason ? `（${game.unsafeReason}）` : ''}——搜刮很可能付出代价，但仍由你决定`
                          }
                        >
                          {game.scavengeExhausted
                            ? '🔍 此地已搜空'
                            : game.scavengeSkipped
                              ? '🚶 此地已放弃'
                              : '🔍 搜刮此地'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm btn-skip-scavenge"
                          onClick={onSkipScavenge}
                          disabled={busy || game.scavengeExhausted || game.scavengeSkipped}
                          title="放弃在当前地点翻找：不消耗时间与体力"
                        >
                          🚶 不搜刮此地
                        </button>
                        {game.canSleep && (
                          <button
                            className="btn btn-sleep btn-sm"
                            onClick={() => setSleepOpen(true)}
                            disabled={busy}
                            title="睡到天亮（06:00）。睡在哪里，由你决定——地点越可靠，恢复越多、夜里越安全"
                          >
                            😴 睡觉
                            <span className="aux-hint">
                              {sleepPlaces.length > 1
                                ? `睡到天亮 06:00 · ${sleepPlaces.length} 个地点可选`
                                : '睡到天亮 06:00 · 目前只能就地过夜'}
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                    <span className={`aux-note ${game.canUseItem ? '' : 'spent'}`}>
                      {game.canUseItem
                        ? '🎒 点顶栏「背包」可使用或交出一件物品（本回合 1 次）'
                        : `🎒 本回合已处理「${game.usedThisTurn}」`}
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <aside className="side">
          <div className="card">
            <h4>主角</h4>
            {game.protagonist ? (
              <>
                <div className="kv">
                  <span>姓名</span>
                  <b>{game.protagonist.name}</b>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 6 }}>
                  {game.protagonist.background}
                </div>
                <div style={{ fontSize: 13, color: 'var(--rust-soft)', marginTop: 8 }}>
                  目标：{game.protagonist.goal}
                </div>
              </>
            ) : (
              <div className="empty">未知</div>
            )}
          </div>

          {game.mainQuest && (
            <div className="card mainquest-card">
              <h4>主线 · 第 {game.mainQuestSeq || 1} 条</h4>
              <div className="mq-title">{game.mainQuest.title}</div>
              {game.mainQuest.stage && <div className="mq-stage">进展：{game.mainQuest.stage}</div>}
              {game.mainQuest.note && <div className="mq-note">线索：{game.mainQuest.note}</div>}
              {game.questFocus?.type === 'main' && <div className="focus-tag">当前进行</div>}
              {game.mainQuestHistory?.length > 0 && (
                <div className="mq-done">已完成：{game.mainQuestHistory.map((h) => h.title).join('、')}</div>
              )}
            </div>
          )}

          {game.sideQuests?.length > 0 && (
            <div className="card">
              <h4>支线</h4>
              {game.sideQuests
                .filter((q) => q.status === 'active')
                .map((q) => (
                  <div className="quest" key={q.id}>
                    <div className="quest-title">
                      {q.title}
                      {game.questFocus?.type === 'side' && game.questFocus.title === q.title && (
                        <span className="focus-tag inline">当前进行</span>
                      )}
                    </div>
                    {q.note && <div className="quest-note">{q.note}</div>}
                    {q.giver && <div className="quest-giver">来源：{q.giver}</div>}
                  </div>
                ))}
              {game.sideQuests.filter((q) => q.status === 'active').length === 0 && (
                <div className="empty">暂无进行中的支线</div>
              )}
              {game.sideQuests.some((q) => q.status !== 'active') && (
                <div className="quest-closed">
                  已了结：
                  {game.sideQuests
                    .filter((q) => q.status !== 'active')
                    .map((q) => q.title)
                    .join('、')}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {panel === 'bag' && (
        <BagPanel game={game} busy={busy} onPick={setPicker} onClose={() => setPanel(null)} />
      )}
      {panel === 'craft' && (
        <CraftPanel game={game} busy={busy} onCraft={(id) => { setPanel(null); onCraft(id) }} onClose={() => setPanel(null)} />
      )}
      {panel === 'shelter' && (
        <ShelterPanel game={game} busy={busy} onUpgrade={(name, slot) => { setPanel(null); onUpgrade(name, slot) }} onClose={() => setPanel(null)} />
      )}
      {panel === 'trade' && (
        <TradePanel
          game={game}
          busy={busy}
          onOffer={onOfferTrade}
          onAccept={() => { setPanel(null); onAcceptTrade() }}
          onDecline={() => { onDeclineTrade() }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'skills' && <SkillsPanel skills={game.skills} onClose={() => setPanel(null)} />}
      {panel === 'map' && (
        <MapPanel game={game} busy={busy} onTravel={onTravel} onClose={() => setPanel(null)} />
      )}
      {panel === 'flags' && <FlagsPanel flags={game.flags} onClose={() => setPanel(null)} />}
      {panel === 'conditions' && (
        <ConditionsPanel conditions={game.conditions} onClose={() => setPanel(null)} />
      )}
      {panel === 'allies' && (
        <AlliesPanel
          allies={game.allies}
          canFeed={game.canFeed}
          busy={busy}
          onFeed={onFeed}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'virus' && <VirusPanel game={game} onClose={() => setPanel(null)} />}

      {sleepOpen && (
        <SleepPicker
          places={sleepPlaces}
          busy={busy}
          onConfirm={(place) => {
            setSleepOpen(false)
            onSleep(place)
          }}
          onClose={() => setSleepOpen(false)}
        />
      )}

      {picker && (
        <TargetPicker
          title={picker.mode === 'give' ? '把东西交给谁？' : '这件东西给谁用？'}
          item={picker.item}
          mode={picker.mode}
          targets={targetOptions}
          allies={game.allies || []}
          busy={busy}
          onConfirm={confirmPicker}
          onClose={() => setPicker(null)}
        />
      )}

      {game.over && game.ending && (
        <EndingScreen ending={game.ending} game={game} onRestart={onBack} />
      )}
    </div>
  )
}
