import { useCallback, useEffect, useMemo, useState } from 'react'
import { DURATION_PRESETS, GAMES, PLAYER_PRESETS, VIBES, recommendGames } from './games'
import './theme.css'
import './App.css'

const SCREENS = { HOME: 'home', PICKER: 'picker', DETAIL: 'gameDetail', LOBBY: 'lobby', ROUND: 'round', RESULTS: 'results', SETTINGS: 'settings' }

const START_PLAYERS = [
  { id: 'host', name: 'Вы', emoji: '😎', ready: true },
  { id: 'anya', name: 'Аня', emoji: '✨', ready: true },
  { id: 'dima', name: 'Дима', emoji: '🕶️', ready: false },
  { id: 'sasha', name: 'Саша', emoji: '🎧', ready: true },
]

const ASSET_LINKS = [
  { name: 'IconScout 3D', url: 'https://iconscout.com/' },
  { name: 'Icons8 Glossy', url: 'https://icons8.com/clipart/flat/glossy' },
  { name: 'Fuwatale 3D Icons', url: 'https://www.fuwatale.com/' },
  { name: 'ThreeDicons', url: 'https://threedicons.com/pricing' },
]

export default function App() {
  const [screen, setScreen] = useState(SCREENS.HOME)
  const [history, setHistory] = useState([])
  const [selectedGameId, setSelectedGameId] = useState('whoofus')
  const [picker, setPicker] = useState({ players: 'medium', vibe: 'warmup', duration: 'medium' })
  const [players, setPlayers] = useState(START_PLAYERS)
  const [roundIndex, setRoundIndex] = useState(0)
  const [reaction, setReaction] = useState(null)
  const [shared, setShared] = useState(false)
  const [settings, setSettings] = useState({ mode: 'Один телефон', rounds: 6, privacy: 'По ссылке' })

  const selectedGame = useMemo(() => GAMES.find(g => g.id === selectedGameId) || GAMES[0], [selectedGameId])
  const recommendations = useMemo(() => recommendGames(picker), [picker])
  const currentPrompt = selectedGame.samplePrompts[roundIndex % selectedGame.samplePrompts.length]
  const everyoneReady = players.every(p => p.ready)

  const navigate = useCallback((next, gameId) => {
    if (gameId) setSelectedGameId(gameId)
    setScreen(cur => { setHistory(h => [...h, cur]); return next })
  }, [])

  const goBack = useCallback(() => {
    setHistory(h => {
      const next = [...h]
      const prev = next.pop()
      setScreen(prev || SCREENS.HOME)
      return next
    })
  }, [])

  const goHome = useCallback(() => { setHistory([]); setScreen(SCREENS.HOME) }, [])

  const haptic = useCallback((type = 'selection') => {
    try {
      const tg = window.Telegram?.WebApp
      if (!tg?.HapticFeedback) return
      if (type === 'success') tg.HapticFeedback.notificationOccurred('success')
      else if (type === 'impact') tg.HapticFeedback.impactOccurred('light')
      else tg.HapticFeedback.selectionChanged()
    } catch {}
  }, [])

  const openGame = useCallback((gameId) => { haptic(); navigate(SCREENS.DETAIL, gameId) }, [haptic, navigate])

  const startQuickMix = useCallback(() => {
    const game = recommendGames(picker)[0] || GAMES[0]
    setSelectedGameId(game.id)
    setPlayers(START_PLAYERS); setRoundIndex(0); setReaction(null)
    haptic('impact'); navigate(SCREENS.LOBBY, game.id)
  }, [haptic, navigate, picker])

  const createLobby = useCallback((mode = 'Один телефон') => {
    setSettings(s => ({ ...s, mode }))
    setPlayers(START_PLAYERS); setRoundIndex(0); setReaction(null)
    haptic('impact'); navigate(SCREENS.LOBBY)
  }, [haptic, navigate])

  const startRound = useCallback(() => { setReaction(null); haptic('success'); navigate(SCREENS.ROUND) }, [haptic, navigate])

  const nextRound = useCallback(() => {
    if (roundIndex >= selectedGame.samplePrompts.length - 1) { haptic('success'); navigate(SCREENS.RESULTS); return }
    setRoundIndex(i => i + 1); setReaction(null); haptic('impact')
  }, [haptic, navigate, roundIndex, selectedGame])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.ready(); tg.expand()
    try {
      tg.setHeaderColor?.('secondary_bg_color')
      const root = document.documentElement
      const t = tg.themeParams || {}
      Object.entries(t).forEach(([k,v]) => { if(v) root.style.setProperty(`--tg-theme-${k.replaceAll('_','-')}`, v) })
    } catch {}
  }, [])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    try {
      if (screen === SCREENS.HOME) tg.BackButton?.hide()
      else { tg.BackButton?.show(); tg.BackButton?.onClick(goBack) }
      if (screen === SCREENS.LOBBY || screen === SCREENS.ROUND) tg.enableClosingConfirmation?.()
      else tg.disableClosingConfirmation?.()
    } catch {}
    return () => { try { tg.BackButton?.offClick?.(goBack) } catch {} }
  }, [goBack, screen])

  const isHome = screen === SCREENS.HOME || screen === SCREENS.RESULTS

  return (
    <div className="app-shell">
      {isHome && (
        <div className="atmosphere" aria-hidden="true">
          <span className="aura aura-1" /><span className="aura aura-2" />
          <span className="float-dot dot-1" /><span className="float-dot dot-2" /><span className="float-dot dot-3" />
        </div>
      )}

      <header className="app-header" role="banner">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">PU</div>
          <div>
            <div className="brand-name">PartyUp</div>
            <div className="brand-sub">Умный ведущий вечеринки</div>
          </div>
        </div>
        <div className="header-actions">
          {screen !== SCREENS.HOME && (
            <button className="icon-btn" onClick={goHome} aria-label="На главную">🏠</button>
          )}
          <button className="icon-btn" onClick={() => navigate(SCREENS.SETTINGS)} aria-label="Настройки">⚙️</button>
        </div>
      </header>

      <main className="screen-frame" key={screen}>
        {screen === SCREENS.HOME && <HomeScreen picker={picker} setPicker={setPicker} recommendations={recommendations} onQuickMix={startQuickMix} onPicker={() => navigate(SCREENS.PICKER)} onGame={openGame} />}
        {screen === SCREENS.PICKER && <PickerScreen picker={picker} setPicker={setPicker} recommendations={recommendations} onSelect={openGame} />}
        {screen === SCREENS.DETAIL && <GameDetailScreen game={selectedGame} onPlay={createLobby} />}
        {screen === SCREENS.LOBBY && <LobbyScreen game={selectedGame} players={players} setPlayers={setPlayers} settings={settings} onStart={startRound} everyoneReady={everyoneReady} onSettings={() => navigate(SCREENS.SETTINGS)} />}
        {screen === SCREENS.ROUND && <RoundScreen game={selectedGame} prompt={currentPrompt} roundIndex={roundIndex} total={selectedGame.samplePrompts.length} players={players} reaction={reaction} setReaction={setReaction} onNext={nextRound} haptic={haptic} />}
        {screen === SCREENS.RESULTS && <ResultsScreen game={selectedGame} players={players} shared={shared} setShared={setShared} onAgain={() => { setRoundIndex(0); navigate(SCREENS.ROUND) }} onHome={goHome} />}
        {screen === SCREENS.SETTINGS && <SettingsScreen settings={settings} setSettings={setSettings} onBack={goBack} />}
      </main>
    </div>
  )
}

/* ─── HomeScreen ─────────────────────────────────────────── */
function HomeScreen({ picker, setPicker, recommendations, onQuickMix, onPicker, onGame }) {
  const activeVibe = VIBES.find(v => v.id === picker.vibe) || VIBES[0]
  const hot = GAMES.filter(g => g.hot).slice(0, 6)
  return (
    <div>
      <div className="hero-card">
        <p className="eyebrow">🎉 Добро пожаловать</p>
        <h1>Запусти вечеринку</h1>
        <p className="lead">Умный ведущий — подберёт игру, проведёт раунд, подведёт смешные итоги.</p>
        <div className="hero-actions">
          <button className="btn-primary" onClick={onQuickMix}>
            <span>🚀</span> Быстрый микс
          </button>
          <button className="btn-secondary" onClick={onPicker}>
            <span>🎯</span> Подобрать игру
          </button>
        </div>
      </div>

      <div className="section-header">
        <span className="section-title">Вайб вечера</span>
        <span className="tag tag-accent">{activeVibe.icon} {activeVibe.label}</span>
      </div>
      <div className="vibe-scroll" role="listbox" aria-label="Выбор атмосферы">
        {VIBES.map(v => (
          <button
            key={v.id} role="option"
            className={`vibe-chip ${v.id === picker.vibe ? 'is-active' : ''}`}
            onClick={() => { setPicker(p => ({...p, vibe: v.id})) }}
            aria-selected={v.id === picker.vibe}
          >
            <span>{v.icon}</span>
            <span>{v.label}</span>
          </button>
        ))}
      </div>

      <div className="section-header" style={{marginTop: 28}}>
        <span className="section-title">🔥 Популярно</span>
      </div>
      <div className="game-list">
        {hot.map(g => (
          <button key={g.id} className="game-row-item" onClick={() => onGame(g.id)}>
            <div className="game-icon-token" aria-hidden="true">{g.emoji}</div>
            <div className="game-row-text">
              <div className="game-row-title">{g.title}{g.hot && <span className="hot-badge">HOT</span>}</div>
              <div className="game-row-sub">{g.short} · {g.players} чел.</div>
            </div>
            <span className="game-row-arrow" aria-hidden="true">›</span>
          </button>
        ))}
      </div>

      <div className="asset-note-block" style={{marginTop: 24}}>
        <strong>🎨 Иконки-заглушки:</strong> сейчас emoji. Для релиза рекомендуем 3D-паки: {ASSET_LINKS.map((l,i) => <span key={l.name}><a href={l.url} target="_blank" rel="noreferrer">{l.name}</a>{i < ASSET_LINKS.length-1 ? ', ' : ''}</span>)}.
      </div>
    </div>
  )
}

/* ─── PickerScreen ───────────────────────────────────────── */
function PickerScreen({ picker, setPicker, recommendations, onSelect }) {
  const [step, setStep] = useState(0) // 0: players, 1: vibe, 2: duration / results

  const steps = [
    {
      title: 'Сколько вас?',
      options: PLAYER_PRESETS.map(p => ({ id: p.id, icon: p.icon, label: p.label, desc: `${p.range[0]}–${p.range[1]} человек` })),
      key: 'players',
    },
    {
      title: 'Какой вайб?',
      options: VIBES.map(v => ({ id: v.id, icon: v.icon, label: v.label, desc: v.hint })),
      key: 'vibe',
    },
    {
      title: 'Сколько времени?',
      options: DURATION_PRESETS.map(d => ({ id: d.id, icon: d.icon, label: d.label, desc: '' })),
      key: 'duration',
    },
  ]

  const cur = steps[step]
  const isLast = step === steps.length - 1

  const handleSelect = (id) => {
    setPicker(p => ({ ...p, [cur.key]: id }))
    if (!isLast) { setStep(s => s + 1) }
  }

  if (step >= steps.length) {
    return <RecommendResults recommendations={recommendations} onSelect={onSelect} onReset={() => setStep(0)} />
  }

  return (
    <div>
      <div className="picker-steps" role="progressbar" aria-valuenow={step+1} aria-valuemax={steps.length}>
        {steps.map((_, i) => <div key={i} className={`step-dot ${i <= step ? 'done' : ''}`} />)}
      </div>
      <p className="eyebrow">Шаг {step+1} из {steps.length}</p>
      <h2 style={{marginBottom: 16}}>{cur.title}</h2>
      <div className="picker-option-grid">
        {cur.options.map(o => (
          <button
            key={o.id}
            className={`picker-option ${picker[cur.key] === o.id ? 'is-selected' : ''}`}
            onClick={() => handleSelect(o.id)}
            aria-pressed={picker[cur.key] === o.id}
          >
            <span className="picker-option-icon">{o.icon}</span>
            <span className="picker-option-label">{o.label}</span>
            {o.desc && <span className="picker-option-desc">{o.desc}</span>}
          </button>
        ))}
      </div>
      {isLast && (
        <button className="btn-primary" style={{marginTop: 20}} onClick={() => setStep(steps.length)}>
          Показать подборку →
        </button>
      )}
      {step > 0 && (
        <button className="btn-ghost" style={{marginTop: 12, width: '100%'}} onClick={() => setStep(s => s-1)}>
          ← Назад
        </button>
      )}
    </div>
  )
}

function RecommendResults({ recommendations, onSelect, onReset }) {
  return (
    <div>
      <p className="eyebrow">Подборка</p>
      <h2 style={{marginBottom: 6}}>Вот что подойдёт</h2>
      <p className="lead" style={{marginBottom: 20}}>Выбери игру или запусти быстрый микс</p>
      <div className="recommend-list">
        {recommendations.length === 0 && <p style={{color:'var(--muted)'}}>Ничего не нашли — попробуй другие параметры</p>}
        {recommendations.map((g, i) => (
          <button key={g.id} className="recommend-card" onClick={() => onSelect(g.id)}>
            <div className="game-icon-token" aria-hidden="true">{g.emoji}</div>
            <div style={{flex:1}}>
              <div className="game-row-title">{g.title}{g.hot && <span className="hot-badge">HOT</span>}</div>
              <div className="game-row-sub">{g.short}</div>
              <div className="recommend-reason">{i === 0 ? '✨ Лучшее совпадение' : i === 1 ? '👍 Хорошо подходит' : '🎲 Попробуй что-то новое'}</div>
            </div>
            <span className="game-row-arrow" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
      <button className="btn-ghost" style={{marginTop: 16, width:'100%'}} onClick={onReset}>← Изменить параметры</button>
    </div>
  )
}

/* ─── GameDetailScreen ───────────────────────────────────── */
function GameDetailScreen({ game, onPlay }) {
  return (
    <div>
      <div className="game-hero">
        <div className="game-hero-icon" aria-hidden="true">{game.emoji}</div>
        <h2>{game.title}</h2>
        <p className="lead">{game.short}</p>
        <div className="game-meta-row">
          <span className="tag">👥 {game.players}</span>
          <span className="tag">⏱️ ~{game.durationMin} мин</span>
          <span className="tag">{'🔥'.repeat(game.intensity)}</span>
          {game.hot && <span className="tag tag-accent">🔥 HOT</span>}
        </div>
      </div>

      <div className="card" style={{marginBottom: 14}}>
        <p className="eyebrow">Как играть</p>
        <ol className="rules-list">
          {game.rules.map((r, i) => (
            <li key={i}>
              <span className="rule-num">{i+1}</span>
              <span>{r}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="card" style={{marginBottom: 20}}>
        <p className="eyebrow">Пример вопроса</p>
        <p style={{marginTop: 8, fontSize: 15}}>{game.samplePrompts[0].type}: <strong>{game.samplePrompts[0].text}</strong></p>
      </div>

      <div className="play-actions">
        <button className="btn-primary" onClick={() => onPlay('Один телефон')}>
          <span>📱</span> Играть на одном телефоне
        </button>
        <button className="btn-secondary" onClick={() => onPlay('Свои устройства')}>
          <span>👥</span> Создать лобби
        </button>
      </div>
    </div>
  )
}

/* ─── LobbyScreen ────────────────────────────────────────── */
function LobbyScreen({ game, players, setPlayers, settings, onStart, everyoneReady, onSettings }) {
  const toggleReady = (id) => setPlayers(ps => ps.map(p => p.id === id ? {...p, ready: !p.ready} : p))

  return (
    <div>
      <div className="lobby-game-tag">
        <div className="game-icon-token" style={{width:38,height:38,fontSize:18}}>{game.emoji}</div>
        <div>
          <div style={{fontWeight:700, fontSize:15}}>{game.title}</div>
          <div style={{color:'var(--muted)',fontSize:12}}>{settings.mode}</div>
        </div>
      </div>

      <p className="eyebrow">Игроки ({players.length})</p>
      <div className="player-list" role="list">
        {players.map(p => (
          <button key={p.id} className="player-row" role="listitem" onClick={() => toggleReady(p.id)} aria-pressed={p.ready}>
            <div className="player-avatar" aria-hidden="true">{p.emoji}</div>
            <div className="player-name">{p.name}</div>
            <span className={`ready-badge ${p.ready ? 'yes' : 'no'}`}>{p.ready ? '✓ Готов' : 'Ждём'}</span>
          </button>
        ))}
      </div>

      <div className="share-block">
        <span style={{fontSize:28}}>🔗</span>
        <div>
          <div style={{fontWeight:600, fontSize:14}}>Позвать друзей</div>
          <div style={{color:'var(--muted)',fontSize:12}}>Поделись ссылкой в Telegram</div>
        </div>
        <button className="btn-ghost" style={{marginLeft:'auto'}}>Копировать</button>
      </div>

      <div className="divider" style={{margin:'16px 0'}} />

      <p className="eyebrow" style={{marginBottom:8}}>Настройки</p>
      {[['Режим', settings.mode], ['Раундов', settings.rounds], ['Приватность', settings.privacy]].map(([k,v]) => (
        <div key={k} className="lobby-settings-row">
          <span>{k}</span>
          <span className="lobby-settings-val">{v}</span>
        </div>
      ))}

      <button className="btn-primary" style={{marginTop:24}} onClick={onStart} disabled={!everyoneReady}>
        {everyoneReady ? <><span>🎮</span> Начать раунд</> : <>Ждём готовности…</>}
      </button>
      {!everyoneReady && (
        <button className="btn-secondary" style={{marginTop:10}} onClick={() => setPlayers(ps => ps.map(p => ({...p, ready:true})))}>
          Отметить всех готовыми
        </button>
      )}
    </div>
  )
}

/* ─── RoundScreen ────────────────────────────────────────── */
const REACTIONS_LIST = ['😂','😳','🔥','💀','🕵️']

function RoundScreen({ game, prompt, roundIndex, total, players, reaction, setReaction, onNext, haptic }) {
  const host = players[roundIndex % players.length]
  return (
    <div>
      <div className="round-header">
        <span className="round-counter">Раунд {roundIndex + 1} из {total}</span>
        <span className="tag tag-accent">{game.emoji} {game.title}</span>
      </div>

      <div className="prompt-card">
        <p className="prompt-type">{prompt.type}</p>
        <p className="prompt-text">{prompt.text}</p>
        <p className="prompt-player">Отвечает: <strong>{host.emoji} {host.name}</strong></p>
      </div>

      <div className="reactions-row" role="group" aria-label="Реакции">
        {REACTIONS_LIST.map(r => (
          <button
            key={r}
            className={`reaction-btn ${reaction === r ? 'tapped' : ''}`}
            onClick={() => { setReaction(r); haptic() }}
            aria-label={`Реакция ${r}`}
            aria-pressed={reaction === r}
          >
            {r}
          </button>
        ))}
      </div>

      <button className="btn-primary" onClick={onNext}>
        {roundIndex >= total - 1 ? <><span>🏆</span> Показать итоги</> : <><span>→</span> Следующий раунд</>}
      </button>
    </div>
  )
}

/* ─── ResultsScreen ──────────────────────────────────────── */
function ResultsScreen({ game, players, shared, setShared, onAgain, onHome }) {
  const results = [
    { medal: '🏆', label: 'Герой раунда', value: `${players[0].emoji} ${players[0].name}` },
    { medal: '😂', label: 'Самый смешной ответ', value: `${players[1]?.emoji} ${players[1]?.name || '—'}` },
    { medal: '🎯', label: 'Лучший вопрос задал', value: `${players[2]?.emoji} ${players[2]?.name || '—'}` },
  ]
  return (
    <div>
      <div className="results-hero">
        <span className="results-trophy" role="img" aria-label="Победа">🎊</span>
        <h2>Раунд завершён!</h2>
        <p className="lead">Отличная вечеринка в стиле {game.title}</p>
      </div>

      <div className="results-cards">
        {results.map(r => (
          <div key={r.label} className="result-item">
            <span className="result-medal" aria-hidden="true">{r.medal}</span>
            <div>
              <div className="result-label">{r.label}</div>
              <div className="result-value">{r.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="share-card" style={{marginBottom:20}}>
        <p style={{fontWeight:700, marginBottom:6}}>Поделись итогами 🎉</p>
        <p style={{fontSize:13,color:'var(--muted)',marginBottom:16}}>Отправь карточку в чат с друзьями</p>
        <button className="btn-primary" onClick={() => setShared(true)} style={{opacity: shared ? 0.6 : 1}}>
          {shared ? '✓ Отправлено!' : '↗ Поделиться в Telegram'}
        </button>
      </div>

      <button className="btn-primary" onClick={onAgain} style={{marginBottom:10}}>
        <span>🔄</span> Ещё раунд
      </button>
      <button className="btn-secondary" onClick={onHome}>
        <span>🏠</span> На главную
      </button>
    </div>
  )
}

/* ─── SettingsScreen ─────────────────────────────────────── */
function SettingsScreen({ settings, setSettings, onBack }) {
  const rows = [
    { key: 'mode', label: 'Режим игры', options: ['Один телефон', 'Свои устройства'] },
    { key: 'rounds', label: 'Раундов', options: [3, 5, 6, 10] },
    { key: 'privacy', label: 'Приватность', options: ['По ссылке', 'Публичная'] },
  ]
  return (
    <div>
      <p className="eyebrow">Настройки</p>
      <h2 style={{marginBottom:20}}>Параметры игры</h2>
      <div className="card">
        <div className="settings-list">
          {rows.map(r => (
            <div key={r.key} className="settings-row">
              <span className="settings-label">{r.label}</span>
              <div style={{display:'flex',gap:6,flexWrap:'wrap',justifyContent:'flex-end'}}>
                {r.options.map(o => (
                  <button
                    key={o}
                    className={`tag ${settings[r.key] === o ? 'tag-accent' : ''}`}
                    onClick={() => setSettings(s => ({...s, [r.key]: o}))}
                    aria-pressed={settings[r.key] === o}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <button className="btn-secondary" style={{marginTop:20}} onClick={onBack}>← Назад</button>
    </div>
  )
}
