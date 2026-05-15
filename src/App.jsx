import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Users, Heart, Star, Timer, Eye, Theater, MessageCircle,
  Laugh, Target, Search, Trophy, Settings, Share2, ChevronRight,
  Play, Sparkles, Flame, Moon, Wind, Crown, Check, X,
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
  LOBBY: 'lobby', ROUND: 'round', RESULTS: 'results', SETTINGS: 'settings',
}

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

  const createLobby = useCallback((mode = 'Один телефон') => {
    if (picker.vibe === 'warmup') setShowWarmupHint(true)
    else setShowWarmupHint(false)
    const host = createPlayer({ id: 'host', name: 'Вы', emoji: '😎', ready: true, isHost: true })
    const newRoom = createRoom(host, selectedGame)
    newRoom.players = [
      host,
      createPlayer({ id: 'anya', name: 'Аня', emoji: '✨', ready: true }),
      createPlayer({ id: 'dima', name: 'Дима', emoji: '🕶️', ready: false }),
      createPlayer({ id: 'sasha', name: 'Саша', emoji: '🎧', ready: true }),
    ]
    newRoom.settings = { ...newRoom.settings, mode, vibe: picker.vibe }
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
          <div className="brand-mark" aria-hidden="true">PU</div>
          <div className="brand-text">
            <div className="brand-name">PartyUp</div>
            <div className="brand-sub">Умный ведущий вечеринки</div>
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
          <GameDetailScreen game={selectedGame} onPlay={createLobby} />}
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
            reaction={reaction} setReaction={setReaction} onNext={nextRound} haptic={haptic} />}
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
      {/* Greeting */}
      <div className="home-greeting">
        <h1>Вайб<br/><span className="gradient-text">вечеринки</span></h1>
        <p className="lead">Выбери настроение — подберём игру и контент под компанию</p>
      </div>

      {/* Vibe Section */}
      <div className="vibe-section">
        <div className="vibe-section-header">
          <div className="vibe-section-title">
            <Sparkles size={20} color="var(--accent-2)"/>
            Вайб вечеринки
          </div>
          <p className="vibe-section-desc">
            Выбери настроение — и приложение адаптирует <strong>вопросы, задания и контент</strong> под твою компанию. Сейчас: <strong>{activeVibe.label}</strong>
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
          <Sparkles size={14}/> Подобрать игру
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
function GameDetailScreen({ game, onPlay }) {
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
        <button className="btn-primary" onClick={() => onPlay('Один телефон')}>
          <Play size={17}/> Играть на одном телефоне
        </button>
        <button className="btn-secondary" onClick={() => onPlay('Свои устройства')}>
          <UserPlus size={16}/> Создать лобби
        </button>
      </div>
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

/* ─── RoundScreen ────────────────────────────────────────────────────────── */
function RoundScreen({ game, round, roundIndex, total, reaction, setReaction, onNext, haptic }) {
  return (
    <div>
      <div className="round-header">
        <span className="round-counter"><Timer size={13}/> Раунд {roundIndex+1} из {total}</span>
        <span className="tag tag-accent"><GameIcon gameId={game.id} size={12}/> {game.title}</span>
      </div>
      <div className="round-progress">
        <div className="round-progress-fill" style={{width:`${((roundIndex+1)/total)*100}%`}}/>
      </div>

      <div className="prompt-card">
        <div className="prompt-type"><Sparkles size={12}/> {round.promptType}</div>
        <div className="prompt-text">{round.promptText}</div>
        <div className="prompt-player">
          Отвечает: <strong>{round.activePlayerId}</strong>
        </div>
      </div>

      <div className="reactions-row" role="group" aria-label="Реакции">
        {REACTIONS_LIST.map(r => (
          <button key={r}
            className={`reaction-btn ${reaction === r ? 'tapped' : ''}`}
            onClick={() => { setReaction(r); haptic() }}
            aria-label={`Реакция ${r}`} aria-pressed={reaction === r}>
            {r}
          </button>
        ))}
      </div>

      <button className="btn-primary no-pulse" onClick={onNext}>
        {roundIndex >= total-1
          ? <><Trophy size={17}/> Показать итоги</>
          : <><ChevronRight size={17}/> Следующий раунд</>}
      </button>
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
