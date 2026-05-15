import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Users, Heart, Star, Timer, Eye, Theater, MessageCircle,
  Laugh, Target, Search, Trophy, Settings, Share2, ChevronRight,
  Play, Sparkles, Flame, Moon, Wind, Crown, Check, X, Compass,
  ShieldCheck, Info, PartyPopper, Rocket, Siren,
  UserPlus, Copy, ArrowLeft, Home, RotateCcw, Send,
  CircleCheck, Clock, Brain, Handshake, Dices,
} from 'lucide-react'
import { DURATION_PRESETS, GAMES, PLAYER_PRESETS, VIBES, recommendGames } from './games'
import './theme.css'
import './App.css'

/* ─── Data Architecture ──────────────────────────────────────────────────── */
// Entities scaffold — расширяется в будущих версиях
function createPlayer(overrides = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'Игрок',
    emoji: '😊',
    telegramId: null,
    ready: false,
    isHost: false,
    stats: { gamesPlayed: 0, wins: 0, reactions: {} },
    ...overrides,
  }
}

function createRoom(hostPlayer, game) {
  return {
    id: Math.random().toString(36).slice(2, 8).toUpperCase(),
    createdAt: Date.now(),
    hostId: hostPlayer.id,
    players: [hostPlayer],
    game,
    state: 'lobby', // lobby | starting | round | results | ended
    settings: { mode: 'Один телефон', rounds: 6, privacy: 'По ссылке', vibe: 'warmup' },
    rounds: [],
    currentRoundIndex: 0,
  }
}

function createRound(game, roundIndex, players) {
  const prompt = game.samplePrompts[roundIndex % game.samplePrompts.length]
  const activePlayer = players[roundIndex % players.length]
  return {
    id: roundIndex,
    promptType: prompt.type,
    promptText: prompt.text,
    activePlayerId: activePlayer.id,
    reactions: {},
    responses: [],
    startedAt: Date.now(),
    endedAt: null,
  }
}

/* ─── Constants ───────────────────────────────────────────────────────────── */
const SCREENS = {
  HOME: 'home', PICKER: 'picker', DETAIL: 'gameDetail',
  PLAYER_SETUP: 'playerSetup',
  LOBBY: 'lobby', ROUND: 'round', RESULTS: 'results', SETTINGS: 'settings',
}

const EMOJIS = ['😎','✨','🕶️','🎧','🌟','🔥','💫','🎯','🎪','🎲']

const GAME_ICONS_MAP = {
  truth: Target, never: ShieldCheck, whoofus: Users, five: Timer,
  spy: Eye, crocodile: Brain, alias: MessageCircle, mafia: Theater,
  bunker: Siren, most: Crown, memes: Laugh, whoami: Search,
  fact: Heart, hot_seat: Flame, taboo: X, associations: Sparkles,
}

function GameIcon({ gameId, size = 22, ...props }) {
  const Icon = GAME_ICONS_MAP[gameId] || Star
  return <Icon size={size} {...props} />
}

const VIBE_ICONS_MAP = {
  warmup: Wind, funny: Laugh, spicy: Flame, chill: Moon,
  new_people: Handshake, deep: Heart,
}
function VibeIcon({ vibeId, size = 18, ...props }) {
  const Icon = VIBE_ICONS_MAP[vibeId] || Sparkles
  return <Icon size={size} {...props} />
}

/* ─── PressBtn ──────────────────────────────────────────────────────────── */
// Даёт красивую press-реакцию и выдерживает задержку перед переходом
function PressBtn({ onClick, delay = 180, className = '', children, style, ...props }) {
  const [pressing, setPressing] = useState(false)
  const tRef = useRef(null)
  const handle = useCallback(() => {
    if (pressing) return
    setPressing(true)
    tRef.current = setTimeout(() => { setPressing(false); onClick?.() }, delay)
  }, [onClick, delay, pressing])
  useEffect(() => () => { clearTimeout(tRef.current) }, [])
  return (
    <button {...props} className={`${className}${pressing ? ' is-pressing' : ''}`} style={style} onClick={handle}>
      {children}
    </button>
  )
}

const REACTIONS_LIST = ['😂','😳','🔥','💀','🕵️']

/* ─── App ─────────────────────────────────────────────────────────────────── */
export default function App() {
  const [screen, setScreen] = useState(SCREENS.HOME)
  const [history, setHistory] = useState([])
  const [selectedGameId, setSelectedGameId] = useState('whoofus')
  const [picker, setPicker] = useState({ players: 'medium', vibe: 'warmup', duration: 'medium' })
  const [room, setRoom] = useState(null)
  const [roundIndex, setRoundIndex] = useState(0)
  const [reaction, setReaction] = useState(null)
  const [shared, setShared] = useState(false)
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('partyup_welcomed'))
  const [showWarmupHint, setShowWarmupHint] = useState(false)
  const [settings, setSettings] = useState({ mode: 'Один телефон', rounds: 6, privacy: 'По ссылке' })
  const [playerNames, setPlayerNames] = useState(['Вы', 'Игрок 2', 'Игрок 3'])
  const [gameMode, setGameMode] = useState('one_phone')

  const selectedGame = useMemo(() => GAMES.find(g => g.id === selectedGameId) || GAMES[0], [selectedGameId])
  const recommendations = useMemo(() => recommendGames(picker), [picker])
  const players = room?.players || [
    createPlayer({ id: 'host', name: 'Вы', emoji: '😎', ready: true, isHost: true }),
    createPlayer({ id: 'anya', name: 'Аня', emoji: '✨', ready: true }),
    createPlayer({ id: 'dima', name: 'Дима', emoji: '🕶️', ready: false }),
    createPlayer({ id: 'sasha', name: 'Саша', emoji: '🎧', ready: true }),
  ]
  const everyoneReady = players.every(p => p.ready)
  const currentRound = useMemo(() => createRound(selectedGame, roundIndex, players), [selectedGame, roundIndex, players])

  const navigate = useCallback((next, gameId) => {
    if (gameId) setSelectedGameId(gameId)
    setScreen(cur => { setHistory(h => [...h, cur]); return next })
  }, [])
  const goBack = useCallback(() => {
    setHistory(h => {
      const next = [...h]; const prev = next.pop()
      setScreen(prev || SCREENS.HOME); return next
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

  const dismissWelcome = useCallback(() => {
    localStorage.setItem('partyup_welcomed', '1')
    setShowWelcome(false)
  }, [])

  const openGame = useCallback((gameId) => { haptic(); navigate(SCREENS.DETAIL, gameId) }, [haptic, navigate])

  const createLobby = useCallback((names, mode) => {
    if (picker.vibe === 'warmup') setShowWarmupHint(true)
    else setShowWarmupHint(false)
    const playersList = names.map((name, i) =>
      createPlayer({ id: `p${i}`, name, emoji: EMOJIS[i % EMOJIS.length], ready: true, isHost: i === 0 })
    )
    const newRoom = createRoom(playersList[0], selectedGame)
    newRoom.players = playersList
    newRoom.settings = { ...newRoom.settings, mode: mode === 'one_phone' ? 'Один телефон' : mode === 'all_see' ? 'Все видят экран' : 'Мультиплеер', vibe: picker.vibe }
    setRoom(newRoom); setRoundIndex(0); setReaction(null)
    haptic('impact'); navigate(SCREENS.LOBBY)
  }, [haptic, navigate, picker, selectedGame])

  const startRound = useCallback(() => {
    setShowWarmupHint(false); setReaction(null)
    haptic('success'); navigate(SCREENS.ROUND)
  }, [haptic, navigate])

  const nextRound = useCallback(() => {
    if (roundIndex >= selectedGame.samplePrompts.length - 1) { haptic('success'); navigate(SCREENS.RESULTS); return }
    setRoundIndex(i => i + 1); setReaction(null); haptic('impact')
  }, [haptic, navigate, roundIndex, selectedGame])

  const endGame = useCallback(() => {
    haptic('success'); navigate(SCREENS.RESULTS)
  }, [haptic, navigate])

  const togglePlayerReady = useCallback((playerId) => {
    setRoom(r => r ? ({
      ...r,
      players: r.players.map(p => p.id === playerId ? {...p, ready: !p.ready} : p)
    }) : r)
    haptic()
  }, [haptic])

  const setAllReady = useCallback(() => {
    setRoom(r => r ? ({ ...r, players: r.players.map(p => ({...p, ready: true})) }) : r)
  }, [])

  // Telegram adapter
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
      if ([SCREENS.LOBBY, SCREENS.ROUND].includes(screen)) tg.enableClosingConfirmation?.()
      else tg.disableClosingConfirmation?.()
    } catch {}
    return () => { try { tg.BackButton?.offClick?.(goBack) } catch {} }
  }, [goBack, screen])

  const isHome = [SCREENS.HOME, SCREENS.RESULTS].includes(screen)

  return (
    <div className="app-shell">
      {isHome && (
        <div className="atmosphere" aria-hidden="true">
          <span className="aura aura-1"/><span className="aura aura-2"/><span className="aura aura-3"/>
          <span className="float-dot dot-1"/><span className="float-dot dot-2"/>
          <span className="float-dot dot-3"/><span className="float-dot dot-4"/>
        </div>
      )}

      <header className="app-header" role="banner">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><Dices size={26} color="white"/></div>
          <div className="brand-text">
            <div className="brand-name">PartyUp</div>
            <div className="brand-sub">Игры для весёлой компании</div>
          </div>
        </div>
        <div className="header-actions">
          {screen !== SCREENS.HOME && (
            <button className="icon-btn" onClick={goHome} aria-label="На главную">
              <Home size={18}/>
            </button>
          )}
          <button className="icon-btn" onClick={() => navigate(SCREENS.SETTINGS)} aria-label="Настройки">
            <Settings size={18}/>
          </button>
        </div>
      </header>

      <main className="screen-frame" key={screen}>
        {screen === SCREENS.HOME &&
          <HomeScreen picker={picker} setPicker={setPicker}
            onPicker={() => navigate(SCREENS.PICKER)} onGame={openGame} />}
        {screen === SCREENS.PICKER &&
          <PickerScreen picker={picker} setPicker={setPicker} recommendations={recommendations} onSelect={openGame} />}
        {screen === SCREENS.DETAIL &&
          <GameDetailScreen game={selectedGame} onSetup={() => navigate(SCREENS.PLAYER_SETUP)} />}
        {screen === SCREENS.PLAYER_SETUP &&
          <PlayerSetupScreen
            game={selectedGame}
            onStart={(names, mode) => { setPlayerNames(names); setGameMode(mode); createLobby(names, mode) }}
            onBack={goBack}
          />}
        {screen === SCREENS.LOBBY &&
          <LobbyScreen game={selectedGame} players={players} room={room}
            settings={settings} setSettings={setSettings}
            showWarmupHint={showWarmupHint} onDismissHint={() => setShowWarmupHint(false)}
            onStart={startRound} everyoneReady={everyoneReady}
            onToggleReady={togglePlayerReady} onAllReady={setAllReady}
            onSettings={() => navigate(SCREENS.SETTINGS)}
            currentVibe={picker.vibe} onChangeVibe={v => setPicker(p => ({...p, vibe:v}))} />}
        {screen === SCREENS.ROUND &&
          <RoundScreen game={selectedGame} round={currentRound}
            roundIndex={roundIndex} total={selectedGame.samplePrompts.length}
            players={players}
            onNext={nextRound} onEnd={endGame} haptic={haptic} />}
        {screen === SCREENS.RESULTS &&
          <ResultsScreen game={selectedGame} players={players}
            shared={shared} setShared={setShared}
            onAgain={() => { setRoundIndex(0); navigate(SCREENS.ROUND) }} onHome={goHome} />}
        {screen === SCREENS.SETTINGS &&
          <SettingsScreen settings={settings} setSettings={setSettings} onBack={goBack} />}
      </main>

      {showWelcome && <WelcomeModal onClose={dismissWelcome} />}
    </div>
  )
}

/* ─── WelcomeModal ───────────────────────────────────────────────────────── */
function WelcomeModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Добро пожаловать в PartyUp">
      <div className="welcome-modal" onClick={e => e.stopPropagation()}>
        <div className="welcome-emoji-row">
          {['🎉','🕵️','🎯','😂'].map((e,i) => (
            <div key={i} className="welcome-feat-icon" style={{animationDelay:`${i*0.08}s`}}>{e}</div>
          ))}
        </div>

        <p className="eyebrow" style={{justifyContent:'center'}}><Sparkles size={13}/> Добро пожаловать</p>
        <h2 className="gradient-text" style={{textAlign:'center', marginTop: 6}}>PartyUp — твой ведущий</h2>
        <p style={{textAlign:'center', color:'var(--muted)', fontSize:14, marginTop:8, lineHeight:1.6}}>
          Не просто набор игр — умная система, которая подберёт формат, проведёт раунд и создаст атмосферу.
        </p>

        <ul className="welcome-benefits">
          {[
            { icon: <Rocket size={16}/>, title: 'Старт за 10 секунд', desc: 'Открыл → выбрал вайб → играешь. Никаких регистраций.' },
            { icon: <Dices size={16}/>, title: '16 игр в одном месте', desc: 'Мафия, Элиас, Шпион, Правда или действие и ещё 12.' },
            { icon: <Sparkles size={16}/>, title: 'Умный вайб-подбор', desc: 'Выбери настроение — приложение адаптирует вопросы и контент.' },
            { icon: <Share2 size={16}/>, title: 'Смешные итоги', desc: 'После раунда — карточка с героями вечера. Поделись в чат.' },
          ].map(b => (
            <li key={b.title} className="welcome-benefit">
              <div className="benefit-icon">{b.icon}</div>
              <div className="benefit-text">
                <strong>{b.title}</strong>
                <span>{b.desc}</span>
              </div>
            </li>
          ))}
        </ul>

        <button className="btn-primary" onClick={onClose}>
          <PartyPopper size={18}/> Начать вечеринку
        </button>
        <button className="btn-ghost" onClick={onClose} style={{marginTop:10,width:'100%',justifyContent:'center'}}>
          Пропустить
        </button>
      </div>
    </div>
  )
}

/* ─── HomeScreen ──────────────────────────────────────────────────────────── */
function HomeScreen({ picker, setPicker, onPicker, onGame }) {
  const activeVibe = VIBES.find(v => v.id === picker.vibe) || VIBES[0]
  const hot = useMemo(() => GAMES.filter(g => g.hot).slice(0, 6), [])

  return (
    <div>
      {/* Vibe Section */}
      <div className="vibe-section">
        <div className="vibe-section-header">
          <div className="vibe-section-title">
            <div className="vibe-icon-glow" aria-hidden="true">
              <Sparkles size={32} color="var(--accent-2)"/>
            </div>
            Вайб компании
          </div>
          <p className="vibe-section-desc">
            Выбери настроение — и приложение адаптирует <strong>вопросы, задания и контент</strong> под твою компанию.
          </p>
        </div>
        <div className="vibe-scroll" role="listbox" aria-label="Выбор вайба">
          {VIBES.map(v => (
            <button key={v.id} role="option" aria-selected={v.id === picker.vibe}
              className={`vibe-chip ${v.id === picker.vibe ? 'is-active' : ''}`}
              onClick={() => setPicker(p => ({...p, vibe: v.id}))}>
              <span className="vibe-chip-icon"><VibeIcon vibeId={v.id} size={20}/></span>
              <span className="vibe-chip-label">{v.label}</span>
              <span className="vibe-chip-hint">{v.hint}</span>
            </button>
          ))}
        </div>
        <div className="vibe-affects">
          <Info size={14} color="var(--accent)" style={{flexShrink:0, marginTop:1}}/>
          <span>
            <span className="vibe-affects-label">Влияет на: </span>
            вопросы, задания, темп раунда, интенсивность контента и подобранные игры из каталога.
          </span>
        </div>
      </div>

      {/* Hot games */}
      <div className="section-header">
        <span className="section-title">
          <Flame size={16} style={{display:'inline',marginRight:6,color:'#ff9500'}}/>
          Популярно
        </span>
        <PressBtn className="btn-suggest" onClick={onPicker} delay={160}>
          <Compass size={14}/> Подобрать игру
        </PressBtn>
      </div>
      <div className="game-list">
        {hot.map(g => (
          <PressBtn key={g.id} className="game-row-item" onClick={() => onGame(g.id)} delay={180}>
            <div className="game-icon-token">
              <GameIcon gameId={g.id} size={22} color="var(--accent-2)"/>
            </div>
            <div className="game-row-text">
              <div className="game-row-title">
                {g.title}
                {g.hot && <span className="tag tag-hot">HOT</span>}
              </div>
              <div className="game-row-sub">{g.short}</div>
              <div className="game-row-meta">
                <span className="tag"><Users size={10}/> {g.players}</span>
                <span className="tag"><Clock size={10}/> {g.durationMin}+ мин</span>
              </div>
            </div>
            <ChevronRight size={16} className="game-row-arrow"/>
          </PressBtn>
        ))}
      </div>
    </div>
  )
}

/* ─── PickerScreen ────────────────────────────────────────────────────────── */
function PickerScreen({ picker, setPicker, recommendations, onSelect }) {
  const [step, setStep] = useState(0)
  const steps = [
    { title: 'Сколько вас?', key: 'players', options: PLAYER_PRESETS.map(p => ({ id: p.id, icon: <Users size={22} color="var(--accent-2)"/>, label: p.label, desc: `${p.range[0]}–${p.range[1]} человек` })) },
    { title: 'Какой вайб?', key: 'vibe', options: VIBES.map(v => ({ id: v.id, icon: <VibeIcon vibeId={v.id} size={22}/>, label: v.label, desc: v.hint })) },
    { title: 'Сколько времени?', key: 'duration', options: DURATION_PRESETS.map(d => ({ id: d.id, icon: <Timer size={22} color="var(--accent-2)"/>, label: d.label, desc: '' })) },
  ]
  const cur = steps[step]

  if (step >= steps.length) {
    return <RecommendResults recommendations={recommendations} onSelect={onSelect} onReset={() => setStep(0)} />
  }

  return (
    <div>
      <div className="picker-steps" role="progressbar" aria-valuenow={step+1} aria-valuemax={steps.length}>
        {steps.map((_,i) => <div key={i} className={`step-dot ${i <= step ? 'done' : ''}`}/>)}
      </div>
      <p className="eyebrow"><Dices size={13}/> Шаг {step+1} из {steps.length}</p>
      <h2 style={{marginBottom:16}}>{cur.title}</h2>
      <div className="picker-option-grid">
        {cur.options.map(o => (
          <button key={o.id}
            className={`picker-option ${picker[cur.key] === o.id ? 'is-selected' : ''}`}
            onClick={() => { setPicker(p=>({...p,[cur.key]:o.id})); if (step < steps.length-1) setStep(s=>s+1) }}
            aria-pressed={picker[cur.key] === o.id}>
            <span className="picker-option-icon">{o.icon}</span>
            <span className="picker-option-label">{o.label}</span>
            {o.desc && <span className="picker-option-desc">{o.desc}</span>}
          </button>
        ))}
      </div>
      {step === steps.length-1 && (
        <button className="btn-primary mt-20" onClick={() => setStep(steps.length)}>
          <Sparkles size={17}/> Показать подборку
        </button>
      )}
      {step > 0 && (
        <button className="btn-ghost mt-12" style={{width:'100%',justifyContent:'center'}} onClick={() => setStep(s=>s-1)}>
          <ArrowLeft size={15}/> Назад
        </button>
      )}
    </div>
  )
}

function RecommendResults({ recommendations, onSelect, onReset }) {
  const reasons = ['✨ Лучшее совпадение', '👍 Хорошо подходит', '🎲 Попробуй что-то новое', '💫 Дикий вариант']
  return (
    <div>
      <p className="eyebrow"><Sparkles size={13}/> Подборка</p>
      <h2 style={{marginBottom:6}}>Вот что подойдёт</h2>
      <p className="lead" style={{marginBottom:20}}>На основе твоих параметров</p>
      <div className="recommend-list">
        {recommendations.length === 0 && <p style={{color:'var(--muted)'}}>Ничего не нашли — попробуй другие параметры</p>}
        {recommendations.map((g,i) => (
          <button key={g.id} className="recommend-card card-shimmer" onClick={() => onSelect(g.id)}>
            <div className="game-icon-token"><GameIcon gameId={g.id} size={22} color="var(--accent-2)"/></div>
            <div style={{flex:1}}>
              <div className="game-row-title">{g.title}{g.hot && <span className="tag tag-hot">HOT</span>}</div>
              <div className="game-row-sub">{g.short}</div>
              <div className="recommend-reason"><CircleCheck size={12}/> {reasons[i]||reasons[3]}</div>
            </div>
            <ChevronRight size={16} className="game-row-arrow"/>
          </button>
        ))}
      </div>
      <button className="btn-ghost mt-16" style={{width:'100%',justifyContent:'center'}} onClick={onReset}>
        <RotateCcw size={14}/> Изменить параметры
      </button>
    </div>
  )
}

/* ─── GameDetailScreen ───────────────────────────────────────────────────── */
function GameDetailScreen({ game, onSetup }) {
  return (
    <div>
      <div className="game-hero">
        <div className="game-hero-icon"><GameIcon gameId={game.id} size={40} color="var(--accent-2)"/></div>
        <h2>{game.title}</h2>
        <p className="lead">{game.short}</p>
        <div className="game-meta-row">
          <span className="tag"><Users size={11}/> {game.players} чел.</span>
          <span className="tag"><Clock size={11}/> ~{game.durationMin} мин</span>
          <span className="tag">
            Интенсивность:&nbsp;
            <span className="intensity-bar">
              {[1,2,3,4,5].map(n => <span key={n} className={`intensity-dot ${n <= game.intensity ? 'filled' : ''}`}/>)}
            </span>
          </span>
          {game.hot && <span className="tag tag-hot"><Flame size={10}/> HOT</span>}
        </div>
      </div>

      <div className="card" style={{marginBottom:14}}>
        <p className="eyebrow"><Info size={12}/> Как играть</p>
        <ol className="rules-list">
          {game.rules.map((r,i) => (
            <li key={i}><span className="rule-num">{i+1}</span><span>{r}</span></li>
          ))}
        </ol>
      </div>

      <div className="card" style={{marginBottom:20}}>
        <p className="eyebrow"><Star size={12}/> Пример</p>
        <div className="sample-prompt">
          <div className="sample-prompt-type">{game.samplePrompts[0].type}</div>
          <div>{game.samplePrompts[0].text}</div>
        </div>
      </div>

      <div className="play-actions">
        <button className="btn-primary" onClick={onSetup}>
          <Play size={17}/> Играть
        </button>
      </div>
    </div>
  )
}

/* ─── PlayerSetupScreen ──────────────────────────────────────────────────── */
function PlayerSetupScreen({ game, onStart, onBack }) {
  const [step, setStep] = useState(0) // 0=mode, 1=names
  const [mode, setMode] = useState('one_phone')
  const [names, setNames] = useState(['Вы', 'Игрок 2', 'Игрок 3'])

  const modeOptions = [
    {
      id: 'one_phone',
      icon: <Play size={22} color="var(--accent-2)"/>,
      label: 'На одном телефоне',
      desc: 'Передаём телефон по кругу',
      disabled: false,
    },
    {
      id: 'all_see',
      icon: <Users size={22} color="var(--accent-2)"/>,
      label: 'Все видят экран',
      desc: 'Телефон лежит на столе',
      disabled: false,
    },
    {
      id: 'multiplayer',
      icon: <Share2 size={22} color="var(--muted)"/>,
      label: 'Мультиплеер',
      desc: 'У каждого свой телефон',
      disabled: true,
      badge: 'Скоро',
    },
  ]

  const updateName = (i, val) => setNames(n => n.map((name, idx) => idx === i ? val : name))
  const addPlayer = () => {
    if (names.length >= 10) return
    setNames(n => [...n, `Игрок ${n.length + 1}`])
  }
  const removePlayer = (i) => {
    if (names.length <= 2) return
    setNames(n => n.filter((_, idx) => idx !== i))
  }

  if (step === 0) {
    return (
      <div>
        <p className="eyebrow"><Sparkles size={13}/> Настройка игры</p>
        <h2 style={{marginBottom:6}}>Как играем?</h2>
        <p className="lead" style={{marginBottom:4}}>{game.title}</p>

        <div className="mode-option-grid">
          {modeOptions.map(opt => (
            <button
              key={opt.id}
              className={`mode-option-btn ${mode === opt.id ? 'is-selected' : ''}`}
              onClick={() => !opt.disabled && setMode(opt.id)}
              disabled={opt.disabled}
            >
              <div className="mode-option-icon">{opt.icon}</div>
              <div className="mode-option-text">
                <div className="mode-option-label">{opt.label}</div>
                <div className="mode-option-desc">{opt.desc}</div>
              </div>
              {opt.badge && <span className="mode-soon-badge">{opt.badge}</span>}
              {mode === opt.id && !opt.disabled && <Check size={16} color="var(--accent-2)" style={{flexShrink:0}}/>}
            </button>
          ))}
        </div>

        <button className="btn-primary mt-16" onClick={() => setStep(1)}>
          <ChevronRight size={17}/> Далее
        </button>
        <button className="btn-ghost mt-12" style={{width:'100%',justifyContent:'center'}} onClick={onBack}>
          <ArrowLeft size={15}/> Назад
        </button>
      </div>
    )
  }

  return (
    <div>
      <p className="eyebrow"><Users size={13}/> Игроки</p>
      <h2 style={{marginBottom:6}}>Кто играет?</h2>
      <p className="lead" style={{marginBottom:4}}>{game.title}</p>

      <div className="setup-player-list">
        {names.map((name, i) => (
          <div key={i} className="setup-player-row">
            <div className="setup-player-emoji">{EMOJIS[i % EMOJIS.length]}</div>
            <input
              className="setup-player-input"
              value={name}
              onChange={e => updateName(i, e.target.value)}
              placeholder={`Игрок ${i + 1}`}
              maxLength={20}
            />
            {names.length > 2 && (
              <button className="setup-player-remove" onClick={() => removePlayer(i)} aria-label="Удалить игрока">
                <X size={15}/>
              </button>
            )}
          </div>
        ))}
      </div>

      {names.length < 10 && (
        <button className="setup-add-btn" onClick={addPlayer}>
          <UserPlus size={16}/> Добавить игрока
        </button>
      )}

      <button className="btn-primary mt-16" onClick={() => onStart(names, mode)}>
        <Play size={17}/> Начать игру
      </button>
      <button className="btn-ghost mt-12" style={{width:'100%',justifyContent:'center'}} onClick={() => setStep(0)}>
        <ArrowLeft size={15}/> Назад
      </button>
    </div>
  )
}

/* ─── LobbyScreen ────────────────────────────────────────────────────────── */
function LobbyScreen({ game, players, room, settings, setSettings, showWarmupHint, onDismissHint, onStart, everyoneReady, onToggleReady, onAllReady, currentVibe, onChangeVibe }) {
  return (
    <div>
      {/* Warmup notification */}
      {showWarmupHint && (
        <div className="warmup-hint">
          <Wind size={16} color="#ff9500" style={{flexShrink:0,marginTop:2}}/>
          <div>
            <strong>Выбран режим Разогрев</strong>
            <span>Круто для старта, но выбери другой вайб — и вопросы станут веселее и точнее под вашу компанию!</span>
            <div style={{marginTop:8,display:'flex',gap:8,flexWrap:'wrap'}}>
              {VIBES.filter(v => v.id !== 'warmup').slice(0,3).map(v => (
                <button key={v.id} className="tag" style={{cursor:'pointer'}}
                  onClick={() => { onChangeVibe(v.id); onDismissHint() }}>
                  <VibeIcon vibeId={v.id} size={12}/> {v.label}
                </button>
              ))}
              <button className="btn-ghost" style={{minHeight:28,fontSize:12,padding:'0 10px'}} onClick={onDismissHint}>
                <X size={12}/> Ок
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Game tag */}
      <div className="lobby-game-tag">
        <div className="game-icon-token" style={{width:42,height:42,borderRadius:13}}>
          <GameIcon gameId={game.id} size={20} color="var(--accent-2)"/>
        </div>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,fontSize:15}}>{game.title}</div>
          <div style={{color:'var(--muted)',fontSize:12}}>{settings.mode} · Комната {room?.id || 'LOCAL'}</div>
        </div>
        {everyoneReady && <CircleCheck size={20} color="#30d158"/>}
      </div>

      {/* Players */}
      <p className="eyebrow" style={{marginBottom:10}}><Users size={12}/> Игроки ({players.length})</p>
      <div className="player-list" role="list">
        {players.map(p => (
          <button key={p.id} className="player-row" role="listitem"
            onClick={() => onToggleReady(p.id)} aria-pressed={p.ready}>
            <div className="player-avatar">{p.emoji}</div>
            <div style={{flex:1}}>
              <div className="player-name">{p.name}{p.isHost && <span className="tag tag-accent" style={{marginLeft:8,fontSize:10}}><Crown size={9}/> Хост</span>}</div>
              <div className="player-role" style={{fontSize:11,color:'var(--muted)'}}>Нажми чтобы изменить</div>
            </div>
            <span className={`ready-badge ${p.ready ? 'yes' : 'no'}`}>{p.ready ? '✓ Готов' : 'Ждём'}</span>
          </button>
        ))}
      </div>

      {/* Share */}
      <div className="share-block">
        <UserPlus size={22} color="var(--accent-2)"/>
        <div style={{flex:1}}>
          <div style={{fontWeight:600,fontSize:14}}>Позвать друзей</div>
          <div style={{color:'var(--muted)',fontSize:12}}>Поделись ссылкой в Telegram</div>
        </div>
        <button className="btn-ghost" style={{minHeight:34,fontSize:13}}>
          <Copy size={14}/> Копировать
        </button>
      </div>

      <div className="divider mt-16"/>

      {/* Settings */}
      <p className="eyebrow" style={{margin:'14px 0 8px'}}><Settings size={12}/> Настройки</p>
      {[['Режим',settings.mode],['Раундов',settings.rounds],['Приватность',settings.privacy]].map(([k,v]) => (
        <div key={k} className="lobby-settings-row">
          <span>{k}</span>
          <span className="lobby-settings-val">{v}</span>
        </div>
      ))}

      <button className="btn-primary mt-20" onClick={onStart} disabled={!everyoneReady}>
        {everyoneReady ? <><Play size={17}/> Начать раунд</> : <>Ждём готовности…</>}
      </button>
      {!everyoneReady && (
        <button className="btn-secondary mt-10" onClick={onAllReady}>
          <Check size={16}/> Отметить всех готовыми
        </button>
      )}
    </div>
  )
}

/* ─── Shared Round Utilities ─────────────────────────────────────────────── */
function RoundHeader({ game, roundIndex, total }) {
  return (
    <>
      <div className="round-header">
        <span className="round-counter"><Timer size={13}/> Раунд {roundIndex+1} из {total}</span>
        <span className="tag tag-accent"><GameIcon gameId={game.id} size={12}/> {game.title}</span>
      </div>
      <div className="round-progress">
        <div className="round-progress-fill" style={{width:`${((roundIndex+1)/total)*100}%`}}/>
      </div>
    </>
  )
}

function NextRoundBtn({ roundIndex, total, onNext, onEnd }) {
  const isLast = roundIndex >= total - 1
  return (
    <button className="btn-primary no-pulse mt-16" onClick={isLast ? onEnd : onNext}>
      {isLast ? <><Trophy size={17}/> Итоги</> : <><ChevronRight size={17}/> Следующий</>}
    </button>
  )
}

/* ─── RoundScreen dispatcher ─────────────────────────────────────────────── */
function RoundScreen({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const props = { game, round, roundIndex, total, players, onNext, onEnd, haptic }
  switch (game.roundType) {
    case 'truth_dare':   return <TruthOrDareRound {...props} />
    case 'never_have_i': return <NeverHaveIRound {...props} />
    case 'who_of_us':    return <WhoOfUsRound {...props} />
    case 'most_likely':  return <MostLikelyRound {...props} />
    case 'five_seconds': return <FiveSecondsRound {...props} />
    case 'spy':          return <SpyRound {...props} />
    case 'alias':        return <AliasRound {...props} />
    case 'who_am_i':     return <WhoAmIRound {...props} />
    case 'fact_guess':   return <FactGuessRound {...props} />
    case 'meme_battle':  return <MemeBattleRound {...props} />
    default:             return <GenericRound {...props} />
  }
}

/* ─── TruthOrDareRound ───────────────────────────────────────────────────── */
function TruthOrDareRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [choice, setChoice] = useState(null) // null | 'truth' | 'dare'
  const activePlayer = players[roundIndex % players.length]

  const truthPrompts = game.samplePrompts.filter(p => p.type === 'Правда')
  const darePrompts = game.samplePrompts.filter(p => p.type === 'Действие')
  const [shownPrompt, setShownPrompt] = useState(null)

  const pick = (type) => {
    const pool = type === 'truth' ? truthPrompts : darePrompts
    const p = pool[Math.floor(Math.random() * pool.length)]
    setShownPrompt(p)
    setChoice(type)
    haptic('impact')
  }

  const handleNext = () => { setChoice(null); setShownPrompt(null); onNext() }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <span className="active-player-emoji">{activePlayer.emoji}</span>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">выбирает</div>
        </div>
      </div>

      {!choice ? (
        <div className="td-choice-grid">
          <button className="td-choice-btn td-truth" onClick={() => pick('truth')}>
            <Target size={32}/>
            <span>Правда</span>
            <span className="td-choice-hint">Честный ответ</span>
          </button>
          <button className="td-choice-btn td-dare" onClick={() => pick('dare')}>
            <Flame size={32}/>
            <span>Действие</span>
            <span className="td-choice-hint">Задание</span>
          </button>
        </div>
      ) : (
        <div className="prompt-card" style={{textAlign:'center'}}>
          <div className="prompt-type"><Sparkles size={12}/> {shownPrompt?.type}</div>
          <div className="prompt-text">{shownPrompt?.text}</div>
        </div>
      )}

      {choice && <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>}
    </div>
  )
}

/* ─── NeverHaveIRound ────────────────────────────────────────────────────── */
function NeverHaveIRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [confessed, setConfessed] = useState(new Set())

  const toggle = (playerId) => {
    haptic()
    setConfessed(s => {
      const n = new Set(s)
      n.has(playerId) ? n.delete(playerId) : n.add(playerId)
      return n
    })
  }

  const handleNext = () => { setConfessed(new Set()); onNext() }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="prompt-card">
        <div className="prompt-type"><Sparkles size={12}/> Я никогда не…</div>
        <div className="prompt-text">…{round.promptText}</div>
        <div className="prompt-player" style={{marginTop:12}}>Поднимите руку, если делали это:</div>
      </div>

      <div className="never-player-list">
        {players.map(p => (
          <button key={p.id} className={`never-player-btn ${confessed.has(p.id) ? 'confessed' : ''}`}
            onClick={() => toggle(p.id)}>
            <span className="never-player-emoji">{p.emoji}</span>
            <span className="never-player-name">{p.name}</span>
            {confessed.has(p.id) && <Check size={16} className="never-check"/>}
          </button>
        ))}
      </div>

      {confessed.size > 0 && (
        <div className="never-confession-bar">
          🙋 {confessed.size} из {players.length} признались
        </div>
      )}

      <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
    </div>
  )
}

/* ─── VoteRound (shared for WhoOfUs + MostLikely) ───────────────────────── */
function VoteRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [votes, setVotes] = useState({})
  const [phase, setPhase] = useState('voting') // 'voting' | 'result'

  const vote = (targetId) => {
    haptic()
    setVotes(v => ({ ...v, _single: targetId }))
    setPhase('result')
  }

  const voteCounts = players.reduce((acc, p) => {
    acc[p.id] = Object.values(votes).filter(v => v === p.id).length
    return acc
  }, {})
  const winner = players.reduce((a, b) => (voteCounts[a.id] || 0) >= (voteCounts[b.id] || 0) ? a : b)

  const handleNext = () => { setVotes({}); setPhase('voting'); onNext() }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="prompt-card">
        <div className="prompt-type"><Sparkles size={12}/> {round.promptType}</div>
        <div className="prompt-text">{round.promptText}</div>
      </div>

      {phase === 'voting' && (
        <>
          <p className="eyebrow" style={{margin:'16px 0 10px'}}><Users size={12}/> Кто это?</p>
          <div className="vote-player-grid">
            {players.map(p => (
              <button key={p.id} className="vote-player-btn" onClick={() => vote(p.id)}>
                <span className="vote-emoji">{p.emoji}</span>
                <span className="vote-name">{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {phase === 'result' && (
        <>
          <div className="vote-result-card">
            <div className="vote-result-label">Компания решила:</div>
            <div className="vote-result-winner">
              <span>{winner.emoji}</span>
              <strong>{winner.name}</strong>
            </div>
          </div>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

function WhoOfUsRound(props) { return <VoteRound {...props} /> }
function MostLikelyRound(props) { return <VoteRound {...props} /> }

/* ─── FiveSecondsRound ───────────────────────────────────────────────────── */
function FiveSecondsRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [phase, setPhase] = useState('ready') // 'ready' | 'countdown' | 'done'
  const [count, setCount] = useState(5)
  const activePlayer = players[roundIndex % players.length]

  useEffect(() => {
    if (phase !== 'countdown') return
    if (count <= 0) { setPhase('done'); haptic('success'); return }
    const t = setTimeout(() => setCount(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, count, haptic])

  const start = () => { setCount(5); setPhase('countdown'); haptic('impact') }
  const handleNext = () => { setPhase('ready'); setCount(5); onNext() }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <span className="active-player-emoji">{activePlayer.emoji}</span>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">отвечает</div>
        </div>
      </div>

      <div className="prompt-card">
        <div className="prompt-type"><Timer size={12}/> 5 секунд</div>
        <div className="prompt-text">{round.promptText}</div>
      </div>

      {phase === 'ready' && (
        <button className="btn-primary mt-16" onClick={start}><Play size={17}/> Поехали!</button>
      )}

      {phase === 'countdown' && (
        <div className="five-countdown">
          <div className={`five-number ${count <= 2 ? 'urgent' : ''}`}>{count}</div>
          <div className="five-label">секунд</div>
        </div>
      )}

      {phase === 'done' && (
        <>
          <div className="five-done-banner">
            <Trophy size={20}/> Время вышло!
          </div>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── SpyRound ───────────────────────────────────────────────────────────── */
function SpyRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [phase, setPhase] = useState('reveal') // 'reveal' | 'discussion' | 'vote'
  const [revealIdx, setRevealIdx] = useState(0)
  const [showing, setShowing] = useState(false)
  const [votes, setVotes] = useState({})
  const [revealed, setRevealed] = useState(false)

  const spyIdx = useMemo(() => Math.floor(Math.random() * players.length), [players.length])
  const location = round.promptText

  const showCard = () => { setShowing(true); haptic('impact') }
  const hideAndNext = () => {
    setShowing(false)
    setTimeout(() => {
      if (revealIdx < players.length - 1) {
        setRevealIdx(i => i + 1)
      } else {
        setPhase('discussion')
      }
    }, 300)
  }

  const castVote = (suspectId) => {
    setVotes(v => ({ ...v, _vote: suspectId }))
    setRevealed(true)
    haptic('success')
  }

  const handleNext = () => {
    setPhase('reveal'); setRevealIdx(0); setShowing(false); setVotes({}); setRevealed(false)
    onNext()
  }

  const currentPlayer = players[revealIdx]
  const isSpy = revealIdx === spyIdx

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />

      {phase === 'reveal' && (
        <>
          <div className="spy-pass-banner">
            <span>{currentPlayer.emoji}</span>
            <strong>{currentPlayer.name}</strong>
            <span>, смотри только ты!</span>
          </div>

          {!showing ? (
            <button className="spy-reveal-btn" onClick={showCard}>
              <Eye size={28}/><span>Нажми и посмотри свою роль</span>
            </button>
          ) : (
            <div className={`spy-card ${isSpy ? 'spy-card-spy' : 'spy-card-agent'}`}>
              {isSpy ? (
                <>
                  <div className="spy-card-icon">🕵️</div>
                  <div className="spy-card-title">Ты ШПИОН!</div>
                  <div className="spy-card-sub">Не знаешь локацию. Веди себя естественно — задавай вопросы и не раскрывайся.</div>
                </>
              ) : (
                <>
                  <div className="spy-card-icon">📍</div>
                  <div className="spy-card-title">Локация</div>
                  <div className="spy-card-location">{location}</div>
                  <div className="spy-card-sub">Ты знаешь локацию. Отвечай осторожно — помоги вычислить шпиона.</div>
                </>
              )}
              <button className="btn-secondary mt-16" onClick={hideAndNext}>
                <Check size={16}/> Запомнил, закрыть
              </button>
            </div>
          )}

          <div className="spy-progress-dots">
            {players.map((_, i) => (
              <div key={i} className={`spy-dot ${i < revealIdx ? 'done' : i === revealIdx ? 'current' : ''}`}/>
            ))}
          </div>
        </>
      )}

      {phase === 'discussion' && (
        <>
          <div className="prompt-card">
            <div className="prompt-type"><Eye size={12}/> Обсуждение</div>
            <div className="prompt-text" style={{fontSize:17}}>Задавайте вопросы по кругу.<br/>Кто ведёт себя подозрительно?</div>
          </div>
          <div className="spy-discussion-hint">
            <ShieldCheck size={14}/> Локация была: <strong>скрыта до голосования</strong>
          </div>
          <button className="btn-primary mt-16" onClick={() => setPhase('vote')}>
            <Target size={17}/> Голосовать за шпиона
          </button>
        </>
      )}

      {phase === 'vote' && !revealed && (
        <>
          <p className="eyebrow" style={{margin:'8px 0 12px'}}><Target size={12}/> Кто шпион?</p>
          <div className="vote-player-grid">
            {players.map(p => (
              <button key={p.id} className="vote-player-btn" onClick={() => castVote(p.id)}>
                <span className="vote-emoji">{p.emoji}</span>
                <span className="vote-name">{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {phase === 'vote' && revealed && (
        <>
          <div className="spy-reveal-result">
            <div className="spy-result-location">
              <span>📍 Локация была:</span>
              <strong>{location}</strong>
            </div>
            <div className="spy-result-who">
              <span>🕵️ Шпион:</span>
              <strong>{players[spyIdx].emoji} {players[spyIdx].name}</strong>
            </div>
            {votes._vote === players[spyIdx].id
              ? <div className="spy-result-verdict spy-caught">✅ Шпион пойман!</div>
              : <div className="spy-result-verdict spy-escaped">😈 Шпион скрылся!</div>
            }
          </div>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── AliasRound ─────────────────────────────────────────────────────────── */
function AliasRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [phase, setPhase] = useState('ready') // 'ready' | 'playing' | 'done'
  const [timeLeft, setTimeLeft] = useState(60)
  const [wordIdx, setWordIdx] = useState(0)
  const [score, setScore] = useState({ correct: 0, skipped: 0 })
  const activePlayer = players[roundIndex % players.length]
  const words = game.samplePrompts

  useEffect(() => {
    if (phase !== 'playing') return
    if (timeLeft <= 0) { setPhase('done'); haptic('success'); return }
    const t = setTimeout(() => setTimeLeft(s => s - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, timeLeft, haptic])

  const startGame = () => { setPhase('playing'); setTimeLeft(60); setWordIdx(0); setScore({ correct: 0, skipped: 0 }) }

  const correct = () => {
    haptic('impact')
    setScore(s => ({ ...s, correct: s.correct + 1 }))
    setWordIdx(i => Math.min(i + 1, words.length - 1))
  }
  const skip = () => {
    setScore(s => ({ ...s, skipped: s.skipped + 1 }))
    setWordIdx(i => Math.min(i + 1, words.length - 1))
  }

  const handleNext = () => { setPhase('ready'); setScore({ correct: 0, skipped: 0 }); onNext() }
  const urgentTime = timeLeft <= 10

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <span className="active-player-emoji">{activePlayer.emoji}</span>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">объясняет</div>
        </div>
      </div>

      {phase === 'ready' && (
        <>
          <div className="alias-rules-card">
            <p className="eyebrow"><MessageCircle size={12}/> Правила</p>
            <p style={{fontSize:14,color:'var(--muted)',marginTop:8,lineHeight:1.6}}>
              Объясняй слова за 60 секунд.<br/>
              Нельзя называть однокоренные слова.<br/>
              Остальные угадывают.
            </p>
          </div>
          <button className="btn-primary mt-16" onClick={startGame}><Play size={17}/> Старт!</button>
        </>
      )}

      {phase === 'playing' && (
        <>
          <div className={`alias-timer ${urgentTime ? 'urgent' : ''}`}>{timeLeft}с</div>
          <div className="alias-word-card" key={wordIdx}>
            <div className="alias-word">{words[wordIdx % words.length].text}</div>
          </div>
          <div className="alias-score-row">
            <span className="alias-score-correct">✅ {score.correct}</span>
            <span className="alias-score-skipped">⏭️ {score.skipped}</span>
          </div>
          <div className="alias-action-row">
            <button className="alias-btn-correct" onClick={correct}><Check size={20}/> Угадали</button>
            <button className="alias-btn-skip" onClick={skip}><ChevronRight size={20}/> Пропустить</button>
          </div>
        </>
      )}

      {phase === 'done' && (
        <>
          <div className="alias-result-card">
            <div className="alias-result-score">{score.correct}</div>
            <div className="alias-result-label">слов угадано</div>
            {score.skipped > 0 && <div style={{fontSize:13,color:'var(--muted)',marginTop:4}}>пропущено: {score.skipped}</div>}
          </div>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── WhoAmIRound ────────────────────────────────────────────────────────── */
function WhoAmIRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [phase, setPhase] = useState('setup') // 'setup' | 'playing'
  const [qCount, setQCount] = useState(0)
  const activePlayer = players[roundIndex % players.length]
  const character = round.promptText

  const handleAnswer = (ans) => {
    haptic(ans === 'yes' ? 'impact' : 'selection')
    setQCount(c => c + 1)
  }
  const handleGuessed = () => { haptic('success'); onNext() }
  const handleNext = () => { setPhase('setup'); setQCount(0); onNext() }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />

      {phase === 'setup' && (
        <>
          <div className="whoami-setup-card">
            <div className="prompt-type"><Search size={12}/> Персонаж для {activePlayer.name}</div>
            <div className="whoami-character">{character}</div>
            <p style={{fontSize:13,color:'var(--muted)',marginTop:12,lineHeight:1.55}}>
              Покажи всем, кроме <strong>{activePlayer.name}</strong>.<br/>
              Потом передай телефон.
            </p>
          </div>
          <button className="btn-primary mt-16" onClick={() => setPhase('playing')}>
            <Eye size={17}/> {activePlayer.name} готов(а)
          </button>
        </>
      )}

      {phase === 'playing' && (
        <>
          <div className="whoami-playing-banner">
            <span>{activePlayer.emoji}</span>
            <div>
              <strong>{activePlayer.name}</strong>
              <span>задаёт вопросы</span>
            </div>
            <div className="whoami-q-count">{qCount} вопр.</div>
          </div>

          <div className="prompt-card" style={{textAlign:'center'}}>
            <div className="prompt-type"><Search size={12}/> Кто ты?</div>
            <div className="prompt-text" style={{fontSize:17}}>Задавай вопросы — только «Да» или «Нет»</div>
            <div style={{fontSize:13,color:'var(--muted)',marginTop:10}}>Уже задано: {qCount} вопросов</div>
          </div>

          <div className="whoami-answer-row">
            <button className="whoami-btn-yes" onClick={() => handleAnswer('yes')}><Check size={22}/> Да</button>
            <button className="whoami-btn-no" onClick={() => handleAnswer('no')}><X size={22}/> Нет</button>
          </div>

          <button className="btn-secondary mt-12" onClick={handleGuessed}>
            <CircleCheck size={16}/> Угадал(а)!
          </button>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── FactGuessRound ─────────────────────────────────────────────────────── */
function FactGuessRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [phase, setPhase] = useState('input') // 'input' | 'guess' | 'reveal'
  const [inputIdx, setInputIdx] = useState(0)
  const [facts, setFacts] = useState([])
  const [currentFact, setCurrentFact] = useState('')
  const [guessIdx, setGuessIdx] = useState(0)
  const [guesses, setGuesses] = useState({})

  const submitFact = () => {
    if (!currentFact.trim()) return
    const p = players[inputIdx]
    setFacts(f => [...f, { playerId: p.id, playerName: p.name, emoji: p.emoji, text: currentFact.trim() }])
    setCurrentFact('')
    if (inputIdx < players.length - 1) setInputIdx(i => i + 1)
    else setPhase('guess')
    haptic('impact')
  }

  const shuffledFacts = useMemo(() => {
    if (facts.length < players.length) return []
    return [...facts].sort(() => Math.random() - 0.5)
  }, [facts, players.length])

  const castGuess = (playerId) => {
    haptic()
    setGuesses(g => ({ ...g, [guessIdx]: playerId }))
    if (guessIdx < shuffledFacts.length - 1) setGuessIdx(i => i + 1)
    else setPhase('reveal')
  }

  const handleNext = () => {
    setPhase('input'); setInputIdx(0); setFacts([]); setCurrentFact(''); setGuessIdx(0); setGuesses({})
    onNext()
  }

  const currentInputPlayer = players[inputIdx]
  const currentGuessFact = shuffledFacts[guessIdx]
  const correctCount = shuffledFacts.filter((f, i) => guesses[i] === f.playerId).length

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />

      {phase === 'input' && (
        <>
          <div className="active-player-banner">
            <span className="active-player-emoji">{currentInputPlayer.emoji}</span>
            <div>
              <div className="active-player-name">{currentInputPlayer.name}</div>
              <div className="active-player-sub">пишет факт о себе</div>
            </div>
          </div>
          <div className="fact-input-card">
            <p style={{fontSize:13,color:'var(--muted)',marginBottom:10,lineHeight:1.5}}>
              Напиши один правдивый факт о себе — что-то неожиданное!
            </p>
            <textarea
              className="fact-textarea"
              placeholder="Например: «Я однажды застрял в лифте на 3 часа»"
              value={currentFact}
              onChange={e => setCurrentFact(e.target.value)}
              rows={3}
            />
          </div>
          <div style={{display:'flex',gap:8,marginTop:12}}>
            <div className="fact-player-dots">
              {players.map((p, i) => (
                <div key={p.id} className={`fact-dot ${i < inputIdx ? 'done' : i === inputIdx ? 'current' : ''}`}/>
              ))}
            </div>
            <button className="btn-primary" style={{flex:1}} onClick={submitFact} disabled={!currentFact.trim()}>
              <Check size={17}/> Готово
            </button>
          </div>
        </>
      )}

      {phase === 'guess' && currentGuessFact && (
        <>
          <div className="prompt-card">
            <div className="prompt-type"><Heart size={12}/> Факт {guessIdx + 1} из {shuffledFacts.length}</div>
            <div className="prompt-text" style={{fontSize:17}}>«{currentGuessFact.text}»</div>
            <div className="prompt-player">Чей это факт?</div>
          </div>
          <div className="vote-player-grid">
            {players.map(p => (
              <button key={p.id} className="vote-player-btn" onClick={() => castGuess(p.id)}>
                <span className="vote-emoji">{p.emoji}</span>
                <span className="vote-name">{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {phase === 'reveal' && (
        <>
          <div className="fact-reveal-score">
            <div className="alias-result-score">{correctCount}</div>
            <div className="alias-result-label">правильных угадок из {shuffledFacts.length}</div>
          </div>
          <div className="fact-reveal-list">
            {shuffledFacts.map((f, i) => (
              <div key={i} className={`fact-reveal-item ${guesses[i] === f.playerId ? 'correct' : 'wrong'}`}>
                <div className="fact-reveal-text">«{f.text}»</div>
                <div className="fact-reveal-owner">{f.emoji} {f.playerName} {guesses[i] === f.playerId ? '✅' : '❌'}</div>
              </div>
            ))}
          </div>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── MemeBattleRound ────────────────────────────────────────────────────── */
function MemeBattleRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [phase, setPhase] = useState('input') // 'input' | 'vote' | 'reveal'
  const [inputIdx, setInputIdx] = useState(0)
  const [captions, setCaptions] = useState([])
  const [currentCaption, setCurrentCaption] = useState('')
  const [votes, setVotes] = useState([])
  const [votePhaseIdx, setVotePhaseIdx] = useState(0)

  const submitCaption = () => {
    if (!currentCaption.trim()) return
    const p = players[inputIdx]
    setCaptions(c => [...c, { playerId: p.id, playerName: p.name, emoji: p.emoji, text: currentCaption.trim() }])
    setCurrentCaption('')
    if (inputIdx < players.length - 1) setInputIdx(i => i + 1)
    else setPhase('vote')
    haptic('impact')
  }

  const shuffledCaptions = useMemo(() => {
    if (captions.length < players.length) return []
    return captions.map((c, origIdx) => ({ ...c, origIdx })).sort(() => Math.random() - 0.5)
  }, [captions, players.length])

  const castVote = (captionIdx) => {
    haptic()
    setVotes(v => [...v, captionIdx])
    if (votePhaseIdx < players.length - 1) setVotePhaseIdx(i => i + 1)
    else setPhase('reveal')
  }

  const voteCounts = shuffledCaptions.map((_, i) => votes.filter(v => v === i).length)
  const winnerIdx = voteCounts.length > 0 ? voteCounts.indexOf(Math.max(...voteCounts)) : 0
  const winner = shuffledCaptions[winnerIdx]

  const handleNext = () => {
    setPhase('input'); setInputIdx(0); setCaptions([]); setCurrentCaption(''); setVotes([]); setVotePhaseIdx(0)
    onNext()
  }

  const currentInputPlayer = players[inputIdx]
  const currentVoter = players[votePhaseIdx]

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />

      {phase === 'input' && (
        <>
          <div className="prompt-card" style={{marginBottom:14}}>
            <div className="prompt-type"><Laugh size={12}/> Ситуация</div>
            <div className="prompt-text" style={{fontSize:17}}>{round.promptText}</div>
          </div>

          <div className="active-player-banner">
            <span className="active-player-emoji">{currentInputPlayer.emoji}</span>
            <div>
              <div className="active-player-name">{currentInputPlayer.name}</div>
              <div className="active-player-sub">пишет подпись к мему</div>
            </div>
          </div>

          <div className="fact-input-card">
            <textarea
              className="fact-textarea"
              placeholder="Напиши смешную подпись к этой ситуации…"
              value={currentCaption}
              onChange={e => setCurrentCaption(e.target.value)}
              rows={3}
            />
          </div>

          <div style={{display:'flex',gap:8,marginTop:12}}>
            <div className="fact-player-dots">
              {players.map((_, i) => (
                <div key={i} className={`fact-dot ${i < inputIdx ? 'done' : i === inputIdx ? 'current' : ''}`}/>
              ))}
            </div>
            <button className="btn-primary" style={{flex:1}} onClick={submitCaption} disabled={!currentCaption.trim()}>
              <Check size={17}/> Готово
            </button>
          </div>
        </>
      )}

      {phase === 'vote' && (
        <>
          <div className="active-player-banner">
            <span className="active-player-emoji">{currentVoter.emoji}</span>
            <div>
              <div className="active-player-name">{currentVoter.name}</div>
              <div className="active-player-sub">голосует</div>
            </div>
          </div>

          <p className="eyebrow" style={{margin:'12px 0 10px'}}><Trophy size={12}/> Лучшая подпись?</p>

          <div className="meme-caption-list">
            {shuffledCaptions.map((c, i) => (
              <button key={i} className="meme-caption-btn" onClick={() => castVote(i)}>
                <span className="meme-caption-num">{i + 1}</span>
                <span className="meme-caption-text">«{c.text}»</span>
              </button>
            ))}
          </div>
        </>
      )}

      {phase === 'reveal' && winner && (
        <>
          <div className="meme-winner-card">
            <div className="meme-winner-label">🏆 Лучший мем</div>
            <div className="meme-winner-text">«{winner.text}»</div>
            <div className="meme-winner-author">{winner.emoji} {winner.playerName} · {voteCounts[winnerIdx]} голосов</div>
          </div>
          <div className="fact-reveal-list" style={{marginTop:10}}>
            {shuffledCaptions.map((c, i) => (
              <div key={i} className="fact-reveal-item">
                <div className="fact-reveal-text">«{c.text}»</div>
                <div className="fact-reveal-owner">{c.emoji} {c.playerName} — {voteCounts[i]} голос(ов)</div>
              </div>
            ))}
          </div>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── GenericRound ───────────────────────────────────────────────────────── */
function GenericRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [reaction, setReaction] = useState(null)
  const activePlayer = players[roundIndex % players.length]
  const handleNext = () => { setReaction(null); onNext() }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <span className="active-player-emoji">{activePlayer.emoji}</span>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">ход игрока</div>
        </div>
      </div>
      <div className="prompt-card">
        <div className="prompt-type"><Sparkles size={12}/> {round.promptType}</div>
        <div className="prompt-text">{round.promptText}</div>
      </div>
      <div className="reactions-row" role="group" aria-label="Реакции">
        {['😂','😳','🔥','💀','🕵️'].map(r => (
          <button key={r} className={`reaction-btn ${reaction === r ? 'tapped' : ''}`}
            onClick={() => { setReaction(r); haptic() }} aria-pressed={reaction === r}>{r}</button>
        ))}
      </div>
      <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
    </div>
  )
}

/* ─── ResultsScreen ──────────────────────────────────────────────────────── */
function ResultsScreen({ game, players, shared, setShared, onAgain, onHome }) {
  const results = [
    { medal:'🏆', label:'Герой раунда', value:`${players[0]?.emoji} ${players[0]?.name}` },
    { medal:'😂', label:'Самый смешной', value:`${players[1]?.emoji} ${players[1]?.name||'—'}` },
    { medal:'🎯', label:'Лучший вопрос', value:`${players[2]?.emoji} ${players[2]?.name||'—'}` },
  ]
  return (
    <div>
      <div className="results-hero">
        <span className="results-trophy" role="img" aria-label="Победа">🎊</span>
        <h2 className="gradient-text">Раунд завершён!</h2>
        <p className="lead">Отличная вечеринка — {game.title}</p>
      </div>
      <div className="results-cards">
        {results.map((r,i) => (
          <div key={i} className="result-item">
            <span className="result-medal">{r.medal}</span>
            <div>
              <div className="result-label">{r.label}</div>
              <div className="result-value">{r.value}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="share-card" style={{marginBottom:20}}>
        <p style={{fontWeight:750,marginBottom:6,fontSize:16}}>Поделись итогами 🎉</p>
        <p style={{fontSize:13,color:'var(--muted)',marginBottom:16}}>Отправь карточку в чат с друзьями</p>
        <button className="btn-primary no-pulse" onClick={() => setShared(true)} style={{opacity:shared?0.65:1}}>
          {shared ? <><Check size={17}/> Отправлено!</> : <><Send size={17}/> Поделиться в Telegram</>}
        </button>
      </div>
      <button className="btn-primary mt-8 no-pulse" onClick={onAgain}><RotateCcw size={16}/> Ещё раунд</button>
      <button className="btn-secondary mt-10" onClick={onHome}><Home size={16}/> На главную</button>
    </div>
  )
}

/* ─── SettingsScreen ─────────────────────────────────────────────────────── */
function SettingsScreen({ settings, setSettings, onBack }) {
  const rows = [
    { key:'mode', label:'Режим игры', sub:'Один или несколько устройств', icon:<Play size={16}/>, options:['Один телефон','Свои устройства'] },
    { key:'rounds', label:'Раундов', sub:'Количество вопросов за сессию', icon:<RotateCcw size={16}/>, options:[3,5,6,10] },
    { key:'privacy', label:'Приватность', sub:'Кто может присоединиться', icon:<ShieldCheck size={16}/>, options:['По ссылке','Публичная'] },
  ]
  return (
    <div>
      <p className="eyebrow"><Settings size={13}/> Настройки</p>
      <h2 style={{marginBottom:20}}>Параметры игры</h2>
      <div className="card">
        <div className="settings-list">
          {rows.map(r => (
            <div key={r.key} className="settings-row">
              <div>
                <div className="settings-label">{r.icon} {r.label}</div>
                <div className="settings-label-sub">{r.sub}</div>
              </div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap',justifyContent:'flex-end'}}>
                {r.options.map(o => (
                  <button key={o}
                    className={`tag ${settings[r.key]===o?'tag-accent':''}`}
                    onClick={() => setSettings(s=>({...s,[r.key]:o}))}
                    aria-pressed={settings[r.key]===o}>
                    {o}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <button className="btn-secondary mt-20" onClick={onBack}><ArrowLeft size={16}/> Назад</button>
    </div>
  )
}
