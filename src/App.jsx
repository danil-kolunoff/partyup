import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Users, Heart, Star, Timer, Eye, Theater, MessageCircle,
  Laugh, Target, Search, Trophy, Settings, Share2, ChevronRight,
  Play, Sparkles, Flame, Moon, Wind, Crown, Check, X, Compass,
  ShieldCheck, Info, PartyPopper, Rocket, Siren, Lock,
  UserPlus, Copy, ArrowLeft, Home, RotateCcw, Send,
  CircleCheck, Clock, Brain, Handshake, Dices, Key, Layers, Scale,
} from 'lucide-react'
import { DURATION_PRESETS, GAMES, PLAYER_PRESETS, VIBES, recommendGames } from './games'
import { api, getAnonId } from './lib/api.js'
import { ev, setSessionId, setRoomId as setAnalyticsRoomId } from './lib/analytics.js'
import { shareToTelegram, miniAppLink, tgUser, shareMessageById, smartShare, isLoggedInTelegram, hapticBurst } from './lib/tg.js'
import { useUser, displayName, avatarUrl, sanitizeName } from './lib/useUser.js'
import './theme.css'
import './App.css'

const BOT_USERNAME = import.meta.env.VITE_BOT_USERNAME || 'PartyUp_Gamebot'

// Лёгкий тост-уведомление поверх UI (для гостей-копий «Скопировано»).
function flashToast(message) {
  try {
    const el = document.createElement('div')
    el.className = 'pu-toast'
    el.textContent = message
    document.body.appendChild(el)
    requestAnimationFrame(() => el.classList.add('is-in'))
    setTimeout(() => {
      el.classList.remove('is-in')
      setTimeout(() => el.remove(), 280)
    }, 1800)
  } catch {}
}

// Универсальный invite-share. Если юзер залогинен в Telegram (Mini App) —
// пробуем нативный TG share-композер; всегда копируем ссылку в буфер
// обмена как страховку и показываем тост-уведомление о результате.
async function doInviteShare({ deeplink, text, gameId, kind, evName }) {
  if (evName) ev.share(evName, gameId ? { gameId } : {})

  // 0. Копируем ссылку ВСЕГДА — гарантированный способ поделиться.
  let copied = false
  try {
    await navigator.clipboard.writeText(deeplink)
    copied = true
  } catch {}

  const inMiniApp = isLoggedInTelegram()
  // Залогинен через cookie pu_sess в обычном браузере? Выставлено useUser.
  const webAuthed = typeof window !== 'undefined' && window.__pu_auth?.mode === 'telegram'
  const authed = inMiniApp || webAuthed
  if (authed) {
    let opened = false
    if (inMiniApp) {
      // 1) пытаемся нативный share-пикер Telegram (Bot API 8+, мобильные клиенты)
      try {
        const r = await api.prepareShare({ kind: kind || 'invite', text, link: deeplink, gameId })
        if (r?.preparedMessageId) {
          opened = shareMessageById(r.preparedMessageId, () => {})
        }
      } catch {}
      // 2) если share-picker не сработал — открываем стандартный share-композер.
      if (!opened) {
        try { shareToTelegram(deeplink, text); opened = true } catch {}
      }
    } else {
      // Web-логин через cookie: открываем https://t.me/share/url в новой вкладке —
      // TG Web/Desktop откроется со стандартным share-композером.
      const link = `https://t.me/share/url?url=${encodeURIComponent(deeplink)}&text=${encodeURIComponent(text || '')}`
      try { window.open(link, '_blank', 'noopener'); opened = true } catch {}
    }
    flashToast(opened ? '✈️ Открываем Telegram…' : (copied ? '✅ Ссылка скопирована' : 'Не получилось — попробуй ещё раз'))
    return { mode: opened ? 'tg' : (copied ? 'clipboard' : 'fail') }
  }

  // Гость: либо native share API (на мобиле), либо clipboard
  try {
    if (navigator?.share) {
      try { await navigator.share({ url: deeplink, text }); return { mode: 'native_share' } } catch {}
    }
  } catch {}
  if (copied) {
    flashToast('✅ Ссылка скопирована')
    return { mode: 'clipboard' }
  }
  window.prompt('Скопируй ссылку:', deeplink)
  return { mode: 'prompt' }
}
// Числовой bot_id (часть до «:» в токене бота). Нужен Telegram Login Widget'у.
const TG_BOT_ID = import.meta.env.VITE_TG_BOT_ID || '8904487088'
// Direct Link Mini App short_name (BotFather → /newapp). С ним ссылки шеринга
// открывают Mini App мгновенно из любого чата: https://t.me/<bot>/<app>?startapp=...
const APP_SHORT_NAME = import.meta.env.VITE_APP_SHORT_NAME || 'play'

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

/* ─── Vibe → content filtering ───────────────────────────────────────────── */
function filterPromptsByVibe(prompts, vibe) {
  if (vibe === 'ultra_adult') {
    const pool = prompts.filter(p => p.vibes?.includes('ultra_adult'))
    if (pool.length > 0) return pool
    const adult = prompts.filter(p => p.vibes?.includes('adult'))
    return adult.length > 0 ? adult : prompts.filter(p => !p.vibes)
  }
  if (vibe === 'adult') {
    const pool = prompts.filter(p => p.vibes?.includes('adult'))
    return pool.length > 0 ? pool : prompts.filter(p => !p.vibes)
  }
  // Премиум-вайбы (cringe, teambuilding): возвращаем только их карты.
  // Если пул пуст (например, для редкой игры карт ещё не добавили), даём
  // безопасный fallback на «нейтральные» карты без vibes.
  if (vibe === 'cringe' || vibe === 'teambuilding') {
    const pool = prompts.filter(p => p.vibes?.includes(vibe))
    return pool.length > 0 ? pool : prompts.filter(p => !p.vibes)
  }
  if (vibe === 'family') {
    const pool = prompts.filter(p => p.vibes?.includes('family'))
    return pool.length > 0 ? pool : prompts.filter(p => !p.vibes)
  }
  return prompts.filter(p => !p.vibes || p.vibes.includes(vibe))
}

function createRound(game, roundIndex, players, vibe = 'warmup', dbPool = null, fixedDeck = null) {
  // fixedDeck — фиксированный набор карточек, привязанный к комнате (mp). Если
  // он есть, ВСЕ игроки выбирают карточку по roundIndex из НЕГО же — это даёт
  // гарантию синхрона даже после refresh / реконнекта (DO хранит deck).
  // Иначе работает старая логика (dbPool / samplePrompts).
  const pool = (fixedDeck && fixedDeck.length > 0)
    ? fixedDeck
    : (dbPool && dbPool.length > 0)
      ? dbPool
      : (filterPromptsByVibe(game.samplePrompts, vibe).length > 0
          ? filterPromptsByVibe(game.samplePrompts, vibe)
          : game.samplePrompts)
  const safePool = pool.length > 0 ? pool : game.samplePrompts
  const prompt = safePool[roundIndex % safePool.length]
  const activePlayer = players[roundIndex % players.length]
  return {
    id: roundIndex,
    promptType: prompt.type,
    promptText: prompt.text,
    promptData: prompt, // full prompt object for TabooRound, BunkerRound etc.
    vibe,              // passed through for per-round vibe-aware filtering
    activePlayerId: activePlayer.id,
    reactions: {},
    responses: [],
    startedAt: Date.now(),
    endedAt: null,
  }
}

/* ─── Constants ───────────────────────────────────────────────────────────── */
const SCREENS = {
  HOME: 'home',
  GAMES: 'games',
  CREATE_LOBBY: 'createLobby',
  FRIENDS: 'friends',
  PICKER: 'picker', DETAIL: 'gameDetail',
  PLAYER_SETUP: 'playerSetup',
  LOBBY: 'lobby', ROUND: 'round', RESULTS: 'results',
  SETTINGS: 'settings', PROFILE: 'profile',
  JOIN_ROOM: 'joinRoom',
  VIEWED_PROFILE: 'viewedProfile',
}

// Bottom nav видна только на табах верхнего уровня; во время игры/настройки игры — скрыта.
const NAV_TABS = [SCREENS.HOME, SCREENS.GAMES, SCREENS.CREATE_LOBBY, SCREENS.FRIENDS, SCREENS.SETTINGS, SCREENS.PROFILE]

// "Группа Играть" — экраны, которые логически вложены под вкладку «Играть».
// Когда `screen` принадлежит группе — вкладка «Играть» в bottom-nav подсвечена
// активной, а закрытие/выход возвращает в SCREENS.GAMES (а не в HOME).
// Сохранение состояния обеспечивается тем, что lobby/round/etc — обычные
// поля App-state (roomId, room, players, roundIndex, settings и т.д.) —
// они не сбрасываются при переключении вкладок, только `screen` меняется.
const PLAY_GROUP_SCREENS = [
  SCREENS.GAMES, SCREENS.PICKER, SCREENS.DETAIL,
  SCREENS.PLAYER_SETUP, SCREENS.LOBBY, SCREENS.ROUND, SCREENS.RESULTS,
  SCREENS.JOIN_ROOM, SCREENS.CREATE_LOBBY,
]
function isPlayGroup(s) { return PLAY_GROUP_SCREENS.includes(s) }

const EMOJIS = ['🦊','✨','🐺','🎧','🌟','🔥','💫','🎯','🎪','🎲']

const GAME_ICONS_MAP = {
  truth: Target, never: ShieldCheck, whoofus: Users, five: Timer,
  crocodile: Brain, alias: MessageCircle,
  whoami: Search, associations: Sparkles,
  would_rather: Scale,
}

function GameIcon({ gameId, size = 22, ...props }) {
  const Icon = GAME_ICONS_MAP[gameId] || Star
  return <Icon size={size} {...props} />
}

const VIBE_ICONS_MAP = {
  warmup: Wind, funny: Laugh, family: Home,
  new_people: Handshake, deep: Heart,
  teambuilding: Trophy, cringe: PartyPopper,
  adult: Flame, ultra_adult: Lock,
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
  // Запоминаем последний "глубокий" экран Play-группы (LOBBY/ROUND/RESULTS).
  // Бытовые экраны (GAMES, DETAIL, PICKER, PLAYER_SETUP) НЕ перезаписывают
  // lastPlayScreen — это поведение позволяет, находясь в лобби, открыть
  // меню игр через нижнюю навигацию и вернуться в лобби обратно.
  const [lastPlayScreen, setLastPlayScreen] = useState(SCREENS.GAMES)
  const DEEP_PLAY_SCREENS = [SCREENS.LOBBY, SCREENS.ROUND, SCREENS.RESULTS]
  const [selectedGameId, setSelectedGameId] = useState('whoofus')
  const [pickerRaw, setPickerRaw] = useState(() => {
    try { const s = sessionStorage.getItem('pu_picker'); return s ? JSON.parse(s) : { players: 'medium', vibe: 'warmup', duration: 'medium' } } catch { return { players: 'medium', vibe: 'warmup', duration: 'medium' } }
  })
  // Burst-эффект при выборе вайба. Точка вылета — ВСЕГДА центр кнопки
  // вайба в bottom-nav (независимо от того, откуда сменили вайб).
  const [vibeBurstEvent, setVibeBurstEvent] = useState({ id: 0, x: null, y: null })
  const burstFromVibeBtn = useCallback(() => {
    let x = null, y = null
    try {
      const el = document.querySelector('.bnav-item.is-vibe')
      if (el?.getBoundingClientRect) {
        const r = el.getBoundingClientRect()
        x = r.left + r.width / 2
        y = r.top + r.height / 2
      }
    } catch {}
    hapticBurst('normal')
    setVibeBurstEvent(b => ({ id: b.id + 1, x, y }))
  }, [])
  // Legacy alias — оставлен чтобы старые вызовы не падали (HomeScreen и др.
  // передают onBurst, в новом дизайне он просто перенаправляет в bnav-точку).
  const burstFromEvent = burstFromVibeBtn
  const picker = pickerRaw
  const setPicker = useCallback((update) => {
    setPickerRaw(prev => typeof update === 'function' ? update(prev) : update)
  }, [])
  const [room, setRoom] = useState(null)
  const [roundIndex, setRoundIndex] = useState(0)
  // Серверный per-round-state для мультиплеера: { choice, promptText, promptType, pickedBy }
  // Поллинг RoundScreen обновляет его, компоненты раундов читают для отрисовки.
  const [roomRoundState, setRoomRoundState] = useState(null)
  // Флаг: профиль открыт из игры? Если да — показываем «Вернуться в игру».
  const [profileFromGame, setProfileFromGame] = useState(false)
  const [showVibePicker, setShowVibePicker] = useState(false)
  const [showPremium, setShowPremium] = useState(false)
  // Серверный каталог: какие игры активны / помечены как "популярные" в админке.
  // Используется для главной (popularGameIds) и для фильтрации списка игр.
  const [activeGameIds, setActiveGameIds] = useState(null) // null = не подтянули
  const [popularGameIds, setPopularGameIds] = useState(['truth','never','whoofus','would_rather','five'])
  useEffect(() => {
    let cancelled = false
    fetch('/api/catalog').then(r => r.json()).then(d => {
      if (cancelled) return
      if (Array.isArray(d?.games)) {
        setActiveGameIds(new Set(d.games.map(g => g.id)))
        const pop = d.games.filter(g => g.popular).map(g => g.id)
        if (pop.length) setPopularGameIds(pop)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const [focusJoinInput, setFocusJoinInput] = useState(false)
  const [buyVibe, setBuyVibe] = useState(null) // объект VIBE для покупки
  const [purchaseSuccessVibe, setPurchaseSuccessVibe] = useState(null) // успешно купленный — для "спасибо"-модалки
  const [ownedPacks, setOwnedPacks] = useState([])
  // Краткая карточка чужого игрока (когда у него нет TG username и это не «я»).
  const [viewedPlayer, setViewedPlayer] = useState(null)

  // Замеряем РЕАЛЬНУЮ высоту BottomNav и прокидываем в --bnav-h. Хардкод 64px
  // ломался на iOS (safe-area-bottom добавляет +20–34px), поэтому фиксированные
  // элементы (sticky-кнопка «Играть») вылезали на меню.
  useEffect(() => {
    const root = document.documentElement
    const measure = () => {
      const nav = document.querySelector('.bottom-nav')
      if (!nav) return
      const h = nav.getBoundingClientRect().height
      if (h > 0) root.style.setProperty('--bnav-h', `${Math.round(h)}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    const nav = document.querySelector('.bottom-nav')
    if (nav) ro.observe(nav)
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
    }
  }, [])
  const [reaction, setReaction] = useState(null)
  const [shared, setShared] = useState(false)
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('partyup_welcomed'))
  const [showWarmupHint, setShowWarmupHint] = useState(false)
  const [settings, setSettings] = useState({ mode: 'Один телефон', rounds: 6, privacy: 'По ссылке' })
  const [playerNames, setPlayerNames] = useState(() => {
    try { const s = sessionStorage.getItem('pu_names'); return s ? JSON.parse(s) : ['Вы', 'Игрок 2', 'Игрок 3'] } catch { return ['Вы', 'Игрок 2', 'Игрок 3'] }
  })
  const [gameMode, setGameMode] = useState(() => {
    try { return sessionStorage.getItem('pu_mode') || 'one_phone' } catch { return 'one_phone' }
  })
  const [scores, setScores] = useState({}) // { playerId: number } — накапливается за сессию
  const [sessionDbId, setSessionDbId] = useState(null) // id записи в sessions для аналитики
  const [pendingMode, setPendingMode] = useState(null) // нав. подсказка для PlayerSetup (multiplayer из «Создать лобби»)
  // Кэш карточек из БД: { 'truth|adult' : [{type,text,vibes,intensity,meta}, …] }
  const [cardsCache, setCardsCache] = useState({})

  // Multiplayer state
  const [roomId, setRoomId] = useState(null)
  const [isMultiplayer, setIsMultiplayer] = useState(false)
  const [isHost, setIsHost] = useState(false)
  const auth = useUser()
  // Синкаем ownedPacks с auth — при логине / после покупки массив обновится.
  useEffect(() => {
    if (Array.isArray(auth?.ownedPacks)) setOwnedPacks(auth.ownedPacks)
  }, [auth?.ownedPacks])
  // После успешной покупки опрашиваем /api/me ещё несколько раз — пока
  // webhook не успеет проставить user_packs.
  const refreshOwnedPacks = useCallback(async () => {
    for (let i = 0; i < 6; i++) {
      try {
        const me = await api.me()
        if (Array.isArray(me?.ownedPacks)) {
          setOwnedPacks(me.ownedPacks)
          if (buyVibe && me.ownedPacks.includes(buyVibe.packId)) return me.ownedPacks
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1200))
    }
  }, [buyVibe])
  // myPlayerId: предпочитаем tg_id (стабильный); для гостей — стабильный
  // random, сохраняем в localStorage чтобы пережил обновление страницы
  // (иначе при reload сервер считает тебя новым игроком).
  const [myPlayerId, setMyPlayerId] = useState(() => {
    try {
      const stored = localStorage.getItem('pu_player_id')
      if (stored) return stored
    } catch {}
    const fresh = `p_${Math.random().toString(36).slice(2, 8)}`
    try { localStorage.setItem('pu_player_id', fresh) } catch {}
    return fresh
  })
  useEffect(() => {
    if (auth.tgUser?.id) {
      const tgPid = `tg_${auth.tgUser.id}`
      setMyPlayerId(tgPid)
      try { localStorage.setItem('pu_player_id', tgPid) } catch {}
    }
  }, [auth.tgUser?.id])

  const recordRoundScore = useCallback((roundScores) => {
    setScores(s => {
      const next = { ...s }
      for (const [id, pts] of Object.entries(roundScores)) {
        next[id] = (next[id] || 0) + pts
      }
      return next
    })
  }, [])

  // Накапливаем активное время игрока (мс на собственных ходах) в локальной игре.
  // В multiplayer аналогичные значения копит DurableObject и присылает в players.
  const recordActiveMs = useCallback((playerId, ms) => {
    if (!playerId || !ms) return
    setRoom(r => {
      if (!r) return r
      return {
        ...r,
        players: r.players.map(p =>
          p.id === playerId ? { ...p, activeMs: (p.activeMs || 0) + Math.max(0, Number(ms) || 0) } : p
        ),
      }
    })
  }, [])

  const selectedGame = useMemo(() => GAMES.find(g => g.id === selectedGameId) || GAMES[0], [selectedGameId])

  // Подтягиваем карточки из БД (gameId × vibe). Один раз на ключ, кэшируем.
  useEffect(() => {
    if (!selectedGame?.id) return
    const key = `${selectedGame.id}|${picker.vibe || ''}`
    if (cardsCache[key]) return
    fetch(`/api/cards?game_id=${encodeURIComponent(selectedGame.id)}&vibe=${encodeURIComponent(picker.vibe || '')}&limit=500`)
      .then(r => r.json())
      .then(r => {
        const rows = Array.isArray(r?.rows) ? r.rows : []
        // Адаптация под формат samplePrompts (text, type, + forbidden/meta).
        const prompts = rows.map(row => ({
          id: row.id,
          type: row.type,
          text: row.text,
          vibes: row.vibes,
          wr_a: row.wr_a,
          wr_b: row.wr_b,
          ...(row.meta && typeof row.meta === 'object' ? row.meta : {}),
        }))
        setCardsCache(c => ({ ...c, [key]: prompts }))
      })
      .catch(() => {})
  }, [selectedGame?.id, picker.vibe]) // eslint-disable-line react-hooks/exhaustive-deps
  const recommendations = useMemo(() => recommendGames(picker), [picker])
  const players = room?.players || [
    createPlayer({ id: 'host', name: 'Вы', emoji: '😎', ready: true, isHost: true }),
    createPlayer({ id: 'anya', name: 'Аня', emoji: '✨', ready: true }),
    createPlayer({ id: 'dima', name: 'Дима', emoji: '🕶️', ready: false }),
    createPlayer({ id: 'sasha', name: 'Саша', emoji: '🎧', ready: true }),
  ]
  const everyoneReady = players.every(p => p.ready)
  const totalRounds = settings.rounds  // e.g. 3,5,6,10 — NOT prompt array length
  const currentRound = useMemo(
    () => createRound(
      selectedGame, roundIndex, players, picker.vibe,
      cardsCache[`${selectedGame?.id}|${picker.vibe || ''}`] || null,
      // Фиксированный deck — и в мультиплеере (для синхрона между игроками),
      // и в одиночном режиме (чтобы повторный запуск давал свежий набор).
      room?.deck || null,
    ),
    [selectedGame, roundIndex, players, picker.vibe, cardsCache, room?.deck]
  )

  const navigate = useCallback((next, gameId) => {
    if (gameId) setSelectedGameId(gameId)
    setScreen(cur => {
      setHistory(h => [...h, cur])
      // Латчим lastPlayScreen ТОЛЬКО на "глубокие" экраны (LOBBY/ROUND/RESULTS).
      // Это сохраняет ссылку на активную игру/лобби даже когда юзер ходит
      // в меню игр / детали / другие табы.
      if (DEEP_PLAY_SCREENS.includes(next)) setLastPlayScreen(next)
      return next
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Перехват тапа по нижней навигации: «Играть» возвращает в lastPlayScreen
  // (lobby/round/results) если есть активная игра, иначе на главную "Играть".
  const navigateTab = useCallback((tabId) => {
    if (tabId === SCREENS.GAMES) {
      // Если есть активная mp-комната — всегда возвращаемся в неё
      // (lobby или round в зависимости от того, где остановились).
      if (roomId && DEEP_PLAY_SCREENS.includes(lastPlayScreen)) {
        navigate(lastPlayScreen)
      } else if (DEEP_PLAY_SCREENS.includes(lastPlayScreen) && sessionDbId) {
        // Локальная игра в процессе — возвращаемся в неё.
        navigate(lastPlayScreen)
      } else {
        navigate(SCREENS.GAMES)
      }
    } else {
      navigate(tabId)
    }
  }, [navigate, lastPlayScreen, roomId, sessionDbId]) // eslint-disable-line react-hooks/exhaustive-deps
  const goBack = useCallback(() => {
    setHistory(h => {
      const next = [...h]; const prev = next.pop()
      setScreen(prev || SCREENS.HOME); return next
    })
  }, [])

  // Закрытие текущей сессии/комнаты при выходе пользователя из игрового экрана.
  // Локальные сессии закрываются в D1. Mp-комнаты — НЕ трогаем на pagehide:
  // пользователь может рефрешнуться или временно свернуть приложение; данные
  // в localStorage позволят восстановить состояние при возвращении. Явный
  // выход выполняется через кнопку "Выйти из лобби" (вызывает /leave).
  const closeActiveGameQuiet = useCallback(() => {
    try {
      if (sessionDbId) {
        // sendBeacon выживает unload/navigate. Сессия помечается finished в D1.
        const body = new Blob([JSON.stringify({
          id: sessionDbId, roundsPlayed: roundIndex + 1, abandoned: true,
        })], { type: 'application/json' })
        navigator.sendBeacon?.('/api/session/finish', body)
      }
    } catch {}
  }, [sessionDbId, roundIndex])

  // Персистенс активной mp-комнаты в localStorage:
  // — пишем при roomId/isHost/screen-смене (если в LOBBY/ROUND/RESULTS)
  // — стираем при leave/closed
  // — на mount пытаемся восстановить (см. отдельный useEffect ниже).
  useEffect(() => {
    try {
      if (roomId && isMultiplayer && DEEP_PLAY_SCREENS.includes(screen)) {
        localStorage.setItem('pu_active_room', JSON.stringify({
          roomId, isHost, gameId: selectedGameId,
          vibe: picker?.vibe, rounds: settings?.rounds,
          screen,
        }))
      }
    } catch {}
  }, [roomId, isHost, isMultiplayer, selectedGameId, picker?.vibe, settings?.rounds, screen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Rehydrate: на mount проверяем сохранённую комнату, если она ещё жива на
  // сервере (state != 'ended', state существует) — возвращаем игрока в неё
  // с правильной ролью (host/guest рассчитывается из room.hostId).
  const rehydrateRanRef = useRef(false)
  useEffect(() => {
    if (rehydrateRanRef.current) return
    rehydrateRanRef.current = true
    let cancelled = false
    ;(async () => {
      let saved = null
      try { saved = JSON.parse(localStorage.getItem('pu_active_room') || 'null') } catch {}
      if (!saved?.roomId) return
      try {
        const res = await fetch(`/api/room/${saved.roomId}`)
        if (cancelled) return
        if (!res.ok) { localStorage.removeItem('pu_active_room'); return }
        const serverRoom = await res.json()
        if (serverRoom?.state === 'ended' || !serverRoom?.players) {
          localStorage.removeItem('pu_active_room'); return
        }
        // Если я не в players (например, был на другом устройстве) — стираем сейв.
        const meStill = serverRoom.players.some(p => String(p.id) === String(myPlayerId))
        if (!meStill) { localStorage.removeItem('pu_active_room'); return }
        setRoom({
          id: serverRoom.id, players: serverRoom.players,
          gameId: serverRoom.gameId, hostId: serverRoom.hostId,
          settings: serverRoom.settings,
          deck: serverRoom.deck || null,
          state: serverRoom.state,
        })
        setRoomId(saved.roomId)
        setIsMultiplayer(true)
        setIsHost(String(serverRoom.hostId) === String(myPlayerId))
        setSelectedGameId(serverRoom.gameId || saved.gameId || 'truth')
        if (serverRoom.settings?.vibe) setPicker(p => ({ ...p, vibe: serverRoom.settings.vibe }))
        if (serverRoom.settings?.rounds) setSettings(s => ({ ...s, rounds: serverRoom.settings.rounds }))
        setRoundIndex(Number(serverRoom.roundIndex || 0))
        setAnalyticsRoomId(saved.roomId)
        // Восстанавливаем сохранённый экран. Если saved.screen — ROUND, но игра
        // уже завершена (state='ended') — возвращаем в LOBBY. Иначе уважаем
        // выбор пользователя: если он перед refresh был в лобби — туда и
        // вернётся (даже если игра ещё идёт у других).
        let target = saved.screen && [SCREENS.LOBBY, SCREENS.ROUND, SCREENS.RESULTS].includes(saved.screen)
          ? saved.screen
          : SCREENS.LOBBY
        if (target === SCREENS.ROUND && serverRoom.state !== 'playing') target = SCREENS.LOBBY
        setLastPlayScreen(target)
        setScreen(target)
      } catch { /* offline — оставим pu_active_room, попробуем позже */ }
    })()
    return () => { cancelled = true }
  }, [myPlayerId]) // eslint-disable-line react-hooks/exhaustive-deps

  const goHome = useCallback(() => {
    // Если уходим со «внутренних» экранов игры — закрываем сессию/комнату.
    if ([SCREENS.LOBBY, SCREENS.ROUND, SCREENS.PLAYER_SETUP].includes(screen)) {
      closeActiveGameQuiet()
      setSessionDbId(null)
    }
    setHistory([]); setScreen(SCREENS.HOME)
  }, [screen, closeActiveGameQuiet])

  // Глобальный safety-net: при закрытии вкладки / сворачивании Mini App
  // закрываем активную сессию через sendBeacon (он переживёт unload).
  useEffect(() => {
    const onHide = () => {
      if ([SCREENS.LOBBY, SCREENS.ROUND].includes(screen)) closeActiveGameQuiet()
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [screen, closeActiveGameQuiet])

  const haptic = useCallback((type = 'selection') => {
    try {
      // Юзер выключил вибрацию в настройках — silently no-op.
      if (typeof localStorage !== 'undefined' && localStorage.getItem('pu_haptics') === 'off') return
      const tg = window.Telegram?.WebApp
      if (!tg?.HapticFeedback) return
      if (type === 'success') tg.HapticFeedback.notificationOccurred('success')
      else if (type === 'error') tg.HapticFeedback.notificationOccurred('error')
      else if (type === 'warning') tg.HapticFeedback.notificationOccurred('warning')
      else if (type === 'impact') tg.HapticFeedback.impactOccurred('light')
      else if (type === 'impact_medium') tg.HapticFeedback.impactOccurred('medium')
      else tg.HapticFeedback.selectionChanged()
    } catch {}
  }, [])

  const dismissWelcome = useCallback(() => {
    localStorage.setItem('partyup_welcomed', '1')
    setShowWelcome(false)
  }, [])

  const openGame = useCallback((gameId) => {
    // Если активная mp-комната — нельзя открыть новую игру, не выйдя из лобби.
    // Вместо тихой подмены — возвращаем в лобби (там есть кнопка "Выйти").
    if (roomId && isMultiplayer) {
      haptic('impact')
      navigate(lastPlayScreen || SCREENS.LOBBY)
      return
    }
    haptic(); ev.gameSelect(gameId); navigate(SCREENS.DETAIL, gameId)
  }, [haptic, navigate, roomId, isMultiplayer, lastPlayScreen])

  // Универсальный обработчик клика по аватарке игрока в лобби/раунде/итогах.
  // СВОЁ → SCREENS.PROFILE (мой профиль). Чужое → SCREENS.VIEWED_PROFILE
  // (внутренний просмотр чужого профиля со статистикой). Никаких переходов
  // в Telegram.
  const handlePlayerAvatarClick = useCallback((p) => {
    if (!p) return
    const myTg = auth?.tgUser?.id ?? auth?.user?.tg_id ?? null
    const isMeByTg = myTg != null && (
      (p.telegramId != null && Number(p.telegramId) === Number(myTg)) ||
      (p.userId != null && Number(p.userId) === Number(myTg))
    )
    const isMeById = myPlayerId && p.id && String(p.id) === String(myPlayerId)
    if (isMeByTg || isMeById) {
      setProfileFromGame(true)
      navigate(SCREENS.PROFILE)
      return
    }
    // Для чужого игрока — открываем внутренний полноэкранный профиль
    setViewedPlayer(p)
    navigate(SCREENS.VIEWED_PROFILE)
  }, [auth, myPlayerId, navigate])

  const createLobby = useCallback(async (names, mode, gameOverride) => {
    // Защита: запускающий не может стартовать игру с премиум-вайбом, который
    // он не купил. UI этого не должен допускать (locked-чипы открывают
    // покупку), но это безопасный safety-net на случай, если picker.vibe
    // был выставлен раньше (например, гостем после захода в чужую комнату).
    const v = VIBES.find(x => x.id === picker.vibe)
    if (v?.premium && v.packId && !ownedPacks.includes(v.packId)) {
      setBuyVibe(v)
      return
    }
    if (picker.vibe === 'warmup') setShowWarmupHint(true)
    else setShowWarmupHint(false)

    // Можно передать игру явно (CreateLobbyScreen знает выбор раньше, чем setState отработает).
    const game = gameOverride || selectedGame

    if (mode === 'multiplayer') {
      // Multiplayer: create room on server, only host player
      const newRoomId = Math.random().toString(36).slice(2, 8).toUpperCase()
      const tgU = tgUser()
      const hostId = tgU?.id || myPlayerId
      const hostPlayer = createPlayer({
        id: myPlayerId,
        name: names[0],
        emoji: EMOJIS[0],
        ready: true,
        isHost: true,
        telegramId: tgU?.id || null,
        userId: tgU?.id || null,
        // photo_url: tgU.photo_url часто пустой (TG не отдаёт его в initData),
        // но к этому моменту /api/auth уже подгрузил avatarUrl(auth) с сервера.
        photo_url: tgU?.photo_url || avatarUrl(auth) || null,
        username: tgU?.username || auth?.user?.username || null,
      })
      // Валидируем rounds под единые опции [25,50,100]: если в App-state
      // болтается дефолтное 6 — сразу нормализуем перед публикацией в DO,
      // иначе гость, подключившийся до того, как хост открыл лобби и
      // CardCountSelector это поправил, увидел бы 6.
      const VALID_ROUNDS = [25, 50, 100]
      const normalizedRounds = VALID_ROUNDS.includes(settings.rounds) ? settings.rounds : VALID_ROUNDS[0]
      if (normalizedRounds !== settings.rounds) {
        setSettings(s => ({ ...s, rounds: normalizedRounds }))
      }
      const initPayload = {
        id: newRoomId,
        hostId,
        gameId: game.id,
        settings: { rounds: normalizedRounds, vibe: picker.vibe },
        players: [{
          id: hostPlayer.id, name: hostPlayer.name, emoji: hostPlayer.emoji,
          userId: tgU?.id || null, telegramId: tgU?.id || null,
          anonId: getAnonId() || null,
          photo_url: tgU?.photo_url || avatarUrl(auth) || null,
          username: tgU?.username || auth?.user?.username || null,
        }],
      }
      try {
        const serverRoom = await api.roomInit(newRoomId, initPayload)
        ev.roomCreate(game.id)
        setAnalyticsRoomId(newRoomId)
        const newRoom = createRoom(hostPlayer, game)
        newRoom.id = newRoomId
        newRoom.players = [hostPlayer]
        newRoom.settings = { ...newRoom.settings, mode: 'Мультиплеер', vibe: picker.vibe }
        setRoom(newRoom)
        setRoomId(newRoomId)
        setIsMultiplayer(true)
        setIsHost(true)
        setRoundIndex(serverRoom.roundIndex || 0)
        setReaction(null)
        // регистрируем сессию в БД
        try {
          const r = await api.startSession({
            gameId: game.id, vibe: picker.vibe, mode: 'multiplayer',
            playersCount: 1, roundsTotal: settings.rounds, roomId: newRoomId,
            players: [{ id: hostPlayer.id, name: hostPlayer.name, emoji: hostPlayer.emoji, userId: tgU?.id || null }],
          })
          if (r?.sessionId) { setSessionDbId(r.sessionId); setSessionId(r.sessionId) }
        } catch {}
        ev.gameStart(game.id, { mode: 'multiplayer', vibe: picker.vibe, rounds: settings.rounds })
        haptic('impact')
        navigate(SCREENS.LOBBY)
      } catch (e) {
        console.error('Failed to create room', e)
        haptic('error')
      }
      return
    }

    // Local mode (one_phone). Хосту (i===0) — все TG-поля: telegramId,
    // photo_url, username — чтобы аватарка везде была настоящей, а не эмодзи.
    // У залогиненного пользователя НИКОГДА не должно быть placeholder-эмодзи.
    const tgU = tgUser()
    const playersList = names.map((name, i) => {
      if (i === 0 && tgU?.id) {
        return createPlayer({
          id: `p0`, name, emoji: EMOJIS[0],
          ready: true, isHost: true,
          telegramId: tgU.id, userId: tgU.id,
          photo_url: tgU.photo_url || null,
          username: tgU.username || null,
        })
      }
      return createPlayer({
        id: `p${i}`, name, emoji: EMOJIS[i % EMOJIS.length],
        ready: true, isHost: i === 0,
      })
    })
    const newRoom = createRoom(playersList[0], game)
    newRoom.players = playersList
    newRoom.settings = { ...newRoom.settings, mode: 'Один телефон', vibe: picker.vibe }
    setRoom(newRoom); setRoundIndex(0); setReaction(null)
    setIsMultiplayer(false); setIsHost(false)
    try {
      const r = await api.startSession({
        gameId: game.id, vibe: picker.vibe, mode,
        playersCount: playersList.length, roundsTotal: settings.rounds,
        players: playersList.map(p => ({ id: p.id, name: p.name, emoji: p.emoji })),
      })
      if (r?.sessionId) { setSessionDbId(r.sessionId); setSessionId(r.sessionId) }
    } catch {}
    ev.gameStart(game.id, { mode, vibe: picker.vibe, players: playersList.length, rounds: settings.rounds })
    haptic('impact')
    // PlayerSetup — последний экран перед игрой. LOBBY с готовностями убран.
    navigate(SCREENS.ROUND)
  }, [haptic, navigate, picker, selectedGame, settings, myPlayerId, ownedPacks])

  const startRound = useCallback(async () => {
    setShowWarmupHint(false); setReaction(null); setRoundIndex(0); setScores({})
    // Сброс per-game-аккумуляторов (например, статистика "Я никогда не").
    try { localStorage.removeItem('pu_never_stats') } catch {}
    try { localStorage.removeItem('pu_whoofus_stats') } catch {}
    try { localStorage.removeItem('pu_five_stats') } catch {}
    try { localStorage.removeItem('pu_assoc_stats') } catch {}

    // Универсальная функция: тасуем пул и берём первые N карточек.
    const buildDeck = () => {
      const dbPool = cardsCache[`${selectedGame?.id}|${picker.vibe || ''}`] || null
      const basePool = (dbPool && dbPool.length > 0)
        ? dbPool
        : (filterPromptsByVibe(selectedGame.samplePrompts, picker.vibe).length > 0
            ? filterPromptsByVibe(selectedGame.samplePrompts, picker.vibe)
            : selectedGame.samplePrompts)
      const safePool = basePool.length > 0 ? basePool : selectedGame.samplePrompts
      const shuffled = safePool.slice()
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      return shuffled.slice(0, Math.max(1, settings.rounds || 25))
        .map(p => ({
          id: p.id ?? null, type: p.type, text: p.text,
          vibes: p.vibes ?? null, wr_a: p.wr_a ?? 0, wr_b: p.wr_b ?? 0,
        }))
    }

    // Хост мультиплеера фиксирует deck в DO — все клиенты синхронны и
    // переживают reload. Гость не публикует.
    if (isMultiplayer && isHost && roomId) {
      try {
        const deck = buildDeck()
        await fetch(`/api/room/${roomId}/action`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deck, state: 'playing', roundIndex: 0 }),
        })
        setRoom(r => r ? { ...r, deck, state: 'playing' } : r)
      } catch (e) { console.error('Deck publish failed', e) }
    } else if (!isMultiplayer) {
      // Single-player: каждый запуск — свежий перетасованный deck,
      // чтобы повторный запуск давал новые вопросы (а не зацикленный pool).
      try {
        const deck = buildDeck()
        setRoom(r => r ? { ...r, deck } : { deck })
      } catch (e) { console.error('Local deck build failed', e) }
    }
    haptic('success'); navigate(SCREENS.ROUND)
  }, [haptic, navigate, isMultiplayer, isHost, roomId, selectedGame, picker.vibe, settings.rounds, cardsCache])

  const finishSessionRemote = useCallback(async (roundsPlayed) => {
    if (!sessionDbId) return
    try {
      const winnerEntry = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
      const totalScore = Object.values(scores).reduce((s, v) => s + (v || 0), 0)
      // Активное время каждого игрока — из player.activeMs (multiplayer обновляет
      // через server, локально считаем сами в раунде). Конвертируем ms → ms.
      const activeTimes = {}
      for (const p of players) {
        if (p?.id && typeof p.activeMs === 'number') activeTimes[p.id] = p.activeMs
      }
      await api.finishSession({
        id: sessionDbId, roundsPlayed, scores,
        activeTimes,
        winnerUserId: winnerEntry ? (players.find(p => p.id === winnerEntry[0])?.telegramId || null) : null,
        totalScore,
      })
    } catch {}
  }, [sessionDbId, scores, players])

  const nextRound = useCallback(async () => {
    if (roundIndex >= totalRounds - 1) {
      haptic('success')
      ev.gameFinish(selectedGame.id, { vibe: picker.vibe, rounds: totalRounds, completed: true })
      finishSessionRemote(totalRounds)
      if (isMultiplayer && isHost && roomId) {
        try { await api.roomAction(roomId, { state: 'ended' }) }
        catch (e) { console.error('Failed to end room', e) }
      }
      navigate(SCREENS.RESULTS)
      return
    }
    const nextIdx = roundIndex + 1
    ev.roundEnd(selectedGame.id, roundIndex)
    ev.roundStart(selectedGame.id, nextIdx)
    // Любой клиент, у которого активный ход, продвигает раунд — не только хост.
    // Сервер сам обнулит round при смене roundIndex.
    if (isMultiplayer && roomId) {
      try { await api.roomAction(roomId, { roundIndex: nextIdx }) }
      catch (e) { console.error('Failed to advance round', e) }
    }
    setRoundIndex(nextIdx); setReaction(null); setRoomRoundState(null); haptic('impact')
  }, [haptic, navigate, roundIndex, totalRounds, isMultiplayer, isHost, roomId, selectedGame, picker.vibe, finishSessionRemote])

  const endGame = useCallback(async () => {
    haptic('success')
    ev.gameFinish(selectedGame.id, { vibe: picker.vibe, rounds: roundIndex + 1, completed: false })
    finishSessionRemote(roundIndex + 1)
    // В мультиплеере: ХОСТ принудительно завершает партию для всех.
    // DO state='ended' → гости через poll увидят и тоже попадут в RESULTS.
    if (isMultiplayer && isHost && roomId) {
      try { await api.roomAction(roomId, { state: 'ended' }) } catch {}
    }
    navigate(SCREENS.RESULTS)
  }, [haptic, navigate, selectedGame, picker.vibe, roundIndex, finishSessionRemote, isMultiplayer, isHost, roomId])

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

  // Persist session state
  useEffect(() => { try { sessionStorage.setItem('pu_picker', JSON.stringify(picker)) } catch {} }, [picker])
  useEffect(() => { try { sessionStorage.setItem('pu_names', JSON.stringify(playerNames)) } catch {} }, [playerNames])
  useEffect(() => { try { sessionStorage.setItem('pu_mode', gameMode) } catch {} }, [gameMode])

  // Determine join target on load:
  // 1) ?room=XXX (web fallback)
  // 2) Telegram start_param: "room_XXXXXX" (из t.me/<bot>/<app>?startapp=room_XXX) или просто "XXXXXX"
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    let joinRoomId = params.get('room')
    const sp = window.Telegram?.WebApp?.initDataUnsafe?.start_param
    if (!joinRoomId && sp) {
      if (sp.startsWith('room_') || sp.startsWith('room-')) joinRoomId = sp.slice(5)
      else if (/^[A-Z0-9]{6}$/i.test(sp)) joinRoomId = sp
    }
    if (joinRoomId) {
      setRoomId(joinRoomId.toUpperCase())
      setScreen(SCREENS.JOIN_ROOM)
      ev.roomJoin(joinRoomId.toUpperCase())
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Telegram adapter
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.ready()
    tg.expand()  // expanded-режим (≈85% экрана) — поддержан везде, кроме старых клиентов

    const root = document.documentElement

    // Прокидываем safe-area из Telegram WebApp в CSS-переменные.
    // tg.safeAreaInset — system (Dynamic Island / status bar)
    // tg.contentSafeAreaInset — TG UI элементы (close-кнопка в fullscreen, шапка)
    const applyInsets = () => {
      const sa = tg.safeAreaInset || { top: 0, right: 0, bottom: 0, left: 0 }
      const ca = tg.contentSafeAreaInset || { top: 0, right: 0, bottom: 0, left: 0 }
      root.style.setProperty('--tg-safe-top', `${sa.top || 0}px`)
      root.style.setProperty('--tg-safe-right', `${sa.right || 0}px`)
      root.style.setProperty('--tg-safe-bottom', `${sa.bottom || 0}px`)
      root.style.setProperty('--tg-safe-left', `${sa.left || 0}px`)
      root.style.setProperty('--tg-content-top', `${ca.top || 0}px`)
      root.style.setProperty('--tg-content-right', `${ca.right || 0}px`)
      root.style.setProperty('--tg-content-bottom', `${ca.bottom || 0}px`)
      root.style.setProperty('--tg-content-left', `${ca.left || 0}px`)
      // Контент должен лежать ниже элементов Telegram (close-кнопка, fullscreen-кнопка,
      // Dynamic Island). Складываем оба отступа, но кладём минимум 12px чтобы было
      // что-то и в обычном expanded-режиме.
      const topPad = Math.max(12, (sa.top || 0) + (ca.top || 0))
      root.style.setProperty('--tg-top-pad', `${topPad}px`)
    }
    const applyFullscreen = () => {
      root.classList.toggle('tg-fullscreen', !!tg.isFullscreen)
    }

    try {
      root.classList.add('tg-app')
      applyInsets()
      applyFullscreen()

      // Полноэкранный режим (Bot API 8.0+) — только мобильные клиенты.
      // У Mini App три viewport-режима:
      //   1) compact     — нижняя половина (по умолчанию при открытии)
      //   2) expanded    — почти весь экран, TG-шапка сверху видна (tg.expand)
      //   3) fullscreen  — на весь экран, без TG UI (tg.requestFullscreen)
      tg.requestFullscreen?.()
      tg.disableVerticalSwipes?.()
      tg.onEvent?.('fullscreenChanged', applyFullscreen)
      tg.onEvent?.('safeAreaChanged', applyInsets)
      tg.onEvent?.('contentSafeAreaChanged', applyInsets)
      tg.onEvent?.('viewportChanged', applyInsets)

      // Force our dark header — don't use TG theme bg (can be light)
      tg.setHeaderColor?.('#100f1a')
      tg.setBackgroundColor?.('#0c0b15')
      // Explicitly lock dark mode for our design
      root.style.setProperty('--tg-theme-bg-color', '#100f1a')
      root.style.setProperty('--tg-theme-secondary-bg-color', '#1c1929')
    } catch {}

    return () => {
      try {
        tg.offEvent?.('fullscreenChanged', applyFullscreen)
        tg.offEvent?.('safeAreaChanged', applyInsets)
        tg.offEvent?.('contentSafeAreaChanged', applyInsets)
        tg.offEvent?.('viewportChanged', applyInsets)
      } catch {}
    }
  }, [])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    try {
      // В лобби и раунде — TG back-arrow прячем: для выхода есть явная
      // кнопка «Выйти из лобби» (корректно зовёт /leave, передаёт хост, и т.д.).
      if (screen === SCREENS.HOME || [SCREENS.LOBBY, SCREENS.ROUND].includes(screen)) tg.BackButton?.hide()
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

      <VibeBurst vibe={picker.vibe} burst={vibeBurstEvent}/>

      <header className="app-header" role="banner">
        <div className="brand brand-btn" onClick={goHome} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') goHome() }}
          aria-label="На главную">
          <div className="brand-mark" aria-hidden="true"><img src="/logo.png" alt="" className="brand-logo-img"/></div>
          <div className="brand-text">
            <div className="brand-name">
              PartyUp
              {auth?.premium?.active && (
                <button type="button" className="brand-premium-btn"
                  onClick={(e) => { e.stopPropagation(); haptic(); setShowPremium(true) }}
                  aria-label="PartyUp Premium — открыть подробности">
                  <span className="premium-glow">Premium</span>
                </button>
              )}
            </div>
            <div className="brand-sub">Игры для весёлой компании</div>
          </div>
        </div>
        <div className="header-actions">
          {screen === SCREENS.PROFILE ? (
            <button
              className="icon-btn user-chip"
              onClick={goBack}
              aria-label="Закрыть профиль"
            >
              <X size={18}/>
            </button>
          ) : (
            <button
              className="icon-btn user-chip"
              onClick={() => navigate(SCREENS.PROFILE)}
              aria-label={auth.tgUser ? `Профиль ${displayName(auth)}` : 'Профиль'}
            >
              {avatarUrl(auth) ? (
                <img src={avatarUrl(auth)} alt="" className="user-chip-avatar" referrerPolicy="no-referrer"/>
              ) : auth.tgUser ? (
                <span className="user-chip-initials">
                  {(auth.tgUser.first_name || auth.tgUser.username || '?').slice(0, 1).toUpperCase()}
                </span>
              ) : (
                <span className="user-chip-initials" style={{background:'linear-gradient(135deg,#555,#333)'}}>?</span>
              )}
            </button>
          )}
        </div>
      </header>

      <main className="screen-frame" key={screen}>
        {screen === SCREENS.HOME &&
          <HomeScreen picker={picker} setPicker={setPicker}
            onPicker={() => navigate(SCREENS.PICKER)} onGame={openGame}
            onAllGames={() => navigate(SCREENS.GAMES)}
            onBurst={burstFromEvent}
            ownedPacks={ownedPacks}
            popularIds={popularGameIds}
            onBuyVibe={(v) => setBuyVibe(v)} />}
        {screen === SCREENS.GAMES &&
          <GamesScreen
            onGame={openGame}
            onEnterLobby={() => { setFocusJoinInput(true); navigate(SCREENS.FRIENDS) }}
            activeGameIds={activeGameIds}
          />}
        {screen === SCREENS.FRIENDS &&
          <FriendsScreen
            focusJoinInput={focusJoinInput}
            onClearFocus={() => setFocusJoinInput(false)}
            onOpenPlayer={(p) => { setViewedPlayer(p); navigate(SCREENS.VIEWED_PROFILE) }}
            onJoinRoom={async (code) => {
              const newCode = code.toUpperCase()
              // Если уже в комнате — автоматически выходим из неё, потом
              // подключаемся к новой. Это лучше, чем блокировать переход.
              if (roomId && isMultiplayer && newCode !== roomId && myPlayerId) {
                try {
                  await fetch(`/api/room/${roomId}/leave`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ playerId: myPlayerId }),
                  })
                } catch {}
                try { localStorage.removeItem('pu_active_room') } catch {}
                setRoom(null); setIsHost(false); setIsMultiplayer(false)
              }
              setRoomId(newCode)
              navigate(SCREENS.JOIN_ROOM)
            }}
          />}
        {screen === SCREENS.PICKER &&
          <PickerScreen picker={picker} setPicker={setPicker} recommendations={recommendations} onSelect={openGame} />}
        {screen === SCREENS.DETAIL &&
          <GameDetailScreen
            game={selectedGame}
            onExit={() => { haptic(); navigate(SCREENS.GAMES) }}
            onPickMode={(mode) => {
              setPendingMode(mode)
              if (mode === 'multiplayer') {
                // Multiplayer: имя берём из TG/localStorage, сразу создаём лобби
                // (минуем экран ввода игроков — настройки игроков в лобби).
                const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('pu_my_name')) || ''
                const me = sanitizeName(displayName(auth, null) || stored, 32) || 'Хост'
                createLobby([me], 'multiplayer', selectedGame)
              } else {
                navigate(SCREENS.PLAYER_SETUP)
              }
            }}
          />}
        {screen === SCREENS.PLAYER_SETUP &&
          <PlayerSetupScreen
            game={selectedGame}
            myName={displayName(auth, null)}
            settings={settings}
            setSettings={setSettings}
            picker={picker}
            setPicker={setPicker}
            haptic={haptic}
            auth={auth}
            ownedPacks={ownedPacks}
            onBuyVibe={(v) => setBuyVibe(v)}
            onVibeBurst={burstFromVibeBtn}
            onAvatarClick={() => navigate(SCREENS.PROFILE)}
            onStart={(names, mode) => {
              setPendingMode(null)
              setPlayerNames(names); setGameMode(mode); createLobby(names, mode)
            }}
            onBack={() => { setPendingMode(null); goBack() }}
          />}
        {screen === SCREENS.LOBBY &&
          <LobbyScreen game={selectedGame} players={players} room={room}
            myId={myPlayerId}
            settings={settings} setSettings={setSettings}
            ownedPacks={ownedPacks}
            onBuyVibe={(v) => setBuyVibe(v)}
            onVibeBurst={burstFromVibeBtn}
            showWarmupHint={showWarmupHint} onDismissHint={() => setShowWarmupHint(false)}
            onStart={startRound} everyoneReady={everyoneReady}
            onToggleReady={togglePlayerReady} onAllReady={setAllReady}
            onSettings={() => navigate(SCREENS.SETTINGS)}
            currentVibe={picker.vibe} onChangeVibe={v => setPicker(p => ({...p, vibe:v}))}
            onChangeGame={(newGameId) => {
              setSelectedGameId(newGameId)
              if (isMultiplayer && roomId) {
                // Сообщаем серверу — гости подтянут смену через polling.
                api.roomAction(roomId, { gameId: newGameId }).catch(() => {})
              }
            }}
            haptic={haptic}
            isMultiplayer={isMultiplayer} isHost={isHost} roomId={roomId}
            onRoomPlayersUpdate={(srv) => setRoom(r => r
              ? { ...r, players: srv.players, hostId: srv.hostId, gameId: srv.gameId, settings: srv.settings, deck: srv.deck, state: srv.state }
              : { id: srv.id, players: srv.players, hostId: srv.hostId, gameId: srv.gameId, settings: srv.settings, deck: srv.deck, state: srv.state }
            )}
            onGameStartedByHost={() => { startRound() }}
            onLeaveLobby={() => {
              try { localStorage.removeItem('pu_active_room') } catch {}
              setRoom(null); setIsHost(false); setRoomId(null); setIsMultiplayer(false);
              setHistory([]); setLastPlayScreen(SCREENS.GAMES); setScreen(SCREENS.GAMES)
            }}
            onRoomClosed={() => {
              try { localStorage.removeItem('pu_active_room') } catch {}
              setRoom(null); setIsHost(false); setRoomId(null); setIsMultiplayer(false);
              setHistory([]); setLastPlayScreen(SCREENS.GAMES); setScreen(SCREENS.GAMES)
            }}
            onHostTransferred={() => { setIsHost(true) }}
            auth={auth}
            onPlayerAvatarClick={handlePlayerAvatarClick}
          />}
        {screen === SCREENS.ROUND &&
          <RoundScreen game={selectedGame} round={currentRound}
            myId={myPlayerId}
            roundIndex={roundIndex} total={totalRounds}
            players={players} scores={scores} recordRoundScore={recordRoundScore}
            recordActiveMs={recordActiveMs}
            onNext={nextRound} onEnd={endGame} haptic={haptic}
            isMultiplayer={isMultiplayer} isHost={isHost} roomId={roomId}
            onRoundSync={(idx) => { setRoundIndex(idx); setRoomRoundState(null) }}
            onRoundStateSync={(rs) => setRoomRoundState(prev => {
              // Dedupe по полной JSON-сигнатуре (учитывает votes для NeverHaveI).
              const a = prev ? JSON.stringify(prev) : 'null'
              const b = rs ? JSON.stringify(rs) : 'null'
              return a === b ? prev : rs
            })}
            roomRoundState={roomRoundState}
            onGameEnded={() => { navigate(SCREENS.RESULTS) }}
            onForceLobby={() => {
              // Хост принудительно завершил игру → все возвращаются в лобби.
              setRoundIndex(0); setRoomRoundState(null)
              setLastPlayScreen(SCREENS.LOBBY); navigate(SCREENS.LOBBY)
            }}
            onExitGame={async () => {
              haptic('impact')
              if (isMultiplayer && roomId) {
                // Завершаем игру для ВСЕХ участников: state='lobby',
                // roundIndex=0, round=null. Гости через poll увидят и
                // тоже вернутся в лобби — без рассинхрона.
                try { await api.roomAction(roomId, { state: 'lobby', roundIndex: 0, round: null }) } catch {}
                setRoundIndex(0); setRoomRoundState(null)
                setLastPlayScreen(SCREENS.LOBBY)
                navigate(SCREENS.LOBBY)
              } else {
                // Локальная игра — выход в меню игр.
                setLastPlayScreen(SCREENS.GAMES)
                navigate(SCREENS.GAMES)
              }
            }}
            auth={auth}
            onAvatarClick={handlePlayerAvatarClick}
          />}
        {screen === SCREENS.RESULTS &&
          <ResultsScreen game={selectedGame} players={players}
            scores={scores}
            isMultiplayer={isMultiplayer}
            isHost={isHost}
            roomId={roomId}
            myId={myPlayerId}
            onHostNavigated={(serverState) => {
              if (serverState === 'lobby') { setRoundIndex(0); setScores({}); setRoomRoundState(null); navigate(SCREENS.LOBBY) }
              else if (serverState === 'playing') { setRoundIndex(0); setRoomRoundState(null); navigate(SCREENS.ROUND) }
            }}
            onBackToLobby={async () => {
              setRoundIndex(0); setScores({}); setRoomRoundState(null); setSessionDbId(null)
              if (isMultiplayer && roomId) {
                // Mp: возврат в то же онлайн-лобби. Все гости через poll
                // увидят state='lobby' и тоже окажутся там.
                try { await api.roomAction(roomId, { state: 'lobby', roundIndex: 0, round: null }) } catch {}
                navigate(SCREENS.LOBBY)
              } else {
                // Локальная игра: «оффлайн-лобби» — это экран настройки игроков
                // (PLAYER_SETUP). Имена сохранены в playerNames, можно
                // отредактировать состав и начать новую игру. Это НЕ онлайн-лобби,
                // которое могло бы зацепить ботов-плейсхолдеры.
                navigate(SCREENS.PLAYER_SETUP)
              }
            }}
            onAgain={async () => {
              setRoundIndex(0); setScores({}); setRoomRoundState(null); setSessionDbId(null)
              // Регистрируем НОВУЮ сессию в БД — чтобы аналитика считала это отдельной партией.
              try {
                const r = await api.startSession({
                  gameId: selectedGame.id, vibe: picker.vibe,
                  mode: isMultiplayer ? 'multiplayer' : 'one_phone',
                  playersCount: players.length, roundsTotal: settings.rounds,
                  roomId: isMultiplayer ? roomId : null,
                  players: players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji, userId: p.telegramId || null })),
                })
                if (r?.sessionId) { setSessionDbId(r.sessionId); setSessionId(r.sessionId) }
              } catch {}
              ev.gameStart(selectedGame.id, { mode: isMultiplayer ? 'multiplayer' : 'one_phone', vibe: picker.vibe, again: true })
              // В multiplayer комнату не пересоздаём — только сбрасываем round-state на сервере.
              if (isMultiplayer && roomId) {
                try { await api.roomAction(roomId, { roundIndex: 0, round: null, state: 'playing' }) } catch {}
              }
              navigate(SCREENS.ROUND)
            }}
            onHome={goHome} />}
        {screen === SCREENS.SETTINGS &&
          <SettingsScreen settings={settings} setSettings={setSettings} onBack={goBack} auth={auth}
            onOpenPremium={() => setShowPremium(true)}
          />}
        {screen === SCREENS.PROFILE &&
          <ProfileScreen auth={auth} onBack={goBack}
            onReturnToGame={profileFromGame ? () => {
              setProfileFromGame(false)
              setScreen(SCREENS.ROUND)
            } : null}
            onOpenPremium={() => setShowPremium(true)}
          />}
        {screen === SCREENS.VIEWED_PROFILE &&
          <ViewedProfileScreen player={viewedPlayer} onBack={() => { setViewedPlayer(null); goBack() }}/>}
        {screen === SCREENS.JOIN_ROOM &&
          <JoinRoomScreen
            roomId={roomId}
            myPlayerId={myPlayerId}
            defaultName={displayName(auth, null)}
            onJoined={(joinedRoom, playerName) => {
              const mePlayer = createPlayer({ id: myPlayerId, name: playerName, emoji: EMOJIS[1], ready: true, isHost: false })
              const hostPlayer = joinedRoom.players.find(p => p.id === joinedRoom.hostId)
              // ВАЖНО: сохраняем все server-поля (photo_url/username/userId/telegramId/anonId),
              // иначе аватары и identity-данные обрезаются и показываются только эмодзи.
              const allPlayers = joinedRoom.players.map(p => createPlayer({
                ...p,
                emoji: p.emoji || EMOJIS[0],
                ready: true,
                isHost: p.id === joinedRoom.hostId,
              }))
              const gameObj = GAMES.find(g => g.id === joinedRoom.gameId) || GAMES[0]
              setSelectedGameId(gameObj.id)
              const newRoom = createRoom(
                hostPlayer
                  ? createPlayer({ ...hostPlayer, emoji: hostPlayer.emoji || EMOJIS[0], isHost: true })
                  : mePlayer,
                gameObj
              )
              newRoom.id = joinedRoom.id
              newRoom.players = allPlayers
              newRoom.hostId = joinedRoom.hostId
              newRoom.settings = { ...newRoom.settings, mode: 'Мультиплеер', vibe: joinedRoom.settings?.vibe || 'warmup' }
              setRoom(newRoom)
              setRoomId(joinedRoom.id)
              setIsMultiplayer(true)
              setIsHost(false)
              setRoundIndex(joinedRoom.roundIndex || 0)
              setPicker(p => ({ ...p, vibe: joinedRoom.settings?.vibe || 'warmup' }))
              // Если по какой-то причине сервер вернул rounds вне допустимого
              // набора (legacy 6) — нормализуем к минимальному валидному.
              const VALID_R = [25, 50, 100]
              const serverR = joinedRoom.settings?.rounds
              setSettings(s => ({ ...s, rounds: VALID_R.includes(serverR) ? serverR : VALID_R[0] }))
              haptic('success')
              navigate(SCREENS.LOBBY)
            }}
            onBack={goHome}
            haptic={haptic}
          />}
      </main>

      {/* BottomNav статичный — виден на всех экранах */}
      <BottomNav
        screen={screen}
        onNavigate={(s) => { haptic(); navigateTab(s) }}
        currentVibe={picker.vibe}
        onOpenVibePicker={() => { haptic(); setShowVibePicker(true) }}
      />

      {showVibePicker && (
        <VibePickerModal
          currentVibe={picker.vibe}
          ownedPacks={ownedPacks}
          onBuy={(v) => { setBuyVibe(v); setShowVibePicker(false) }}
          onPick={(v) => {
            setPicker(p => ({ ...p, vibe: v }))
            ev.vibeChange(v)
            setShowVibePicker(false)
            haptic('success')
            burstFromVibeBtn()
          }}
          onClose={() => setShowVibePicker(false)}
        />
      )}

      {showPremium && (
        <PremiumModal
          auth={auth}
          onClose={() => setShowPremium(false)}
          haptic={haptic}
        />
      )}

      {showWelcome && <WelcomeModal onClose={dismissWelcome} />}
      {/* ViewedPlayerModal удалён — переход на внутренний SCREENS.VIEWED_PROFILE */}
      {buyVibe && (
        <PackPurchaseModal
          vibe={buyVibe}
          onClose={() => setBuyVibe(null)}
          onPurchased={async () => {
            // Webhook успеет проставить user_packs — опрашиваем /api/me.
            const packs = await refreshOwnedPacks()
            const vibeJustBought = buyVibe
            setBuyVibe(null)
            if (packs?.includes(vibeJustBought.packId)) {
              // Активируем купленный вайб и показываем «спасибо»-модалку.
              setPicker(p => ({ ...p, vibe: vibeJustBought.id }))
              ev.vibeChange(vibeJustBought.id)
              haptic('success')
              setPurchaseSuccessVibe(vibeJustBought)
            }
          }}
        />
      )}
      {purchaseSuccessVibe && (
        <PurchaseSuccessModal
          vibe={purchaseSuccessVibe}
          onClose={() => {
            // Burst эмодзи играем при закрытии «спасибо»-модалки —
            // визуально подтверждаем активацию.
            setPurchaseSuccessVibe(null)
            burstFromVibeBtn()
          }}
        />
      )}
    </div>
  )
}

/* ─── GameLobbySettings — динамические настройки в зависимости от игры ──── */
// Каждая игра объявляет «оси» настроек (rounds/timer/goal/teams/spies/difficulty),
// каждая ось — массив значений-опций + лейбл. UI рендерит каждую как ряд тегов.
const GAME_LOBBY_SCHEMA = {
  truth:        [['rounds', 'Карточек в партии', [25, 50, 100]]],
  never:        [['rounds', 'Вопросов', [6, 10, 16, 24]]],
  whoofus:      [['rounds', 'Голосований', [5, 8, 12, 16]]],
  five:         [['rounds', 'Раундов', [5, 8, 12]], ['timer', 'Секунд на ответ', [5, 7, 10]]],
  crocodile:    [['rounds', 'Раундов', [3, 5, 8, 12]], ['timer', 'Секунд на показ', [45, 60, 90]]],
  alias:        [['rounds', 'Раундов на команду', [3, 5, 8]], ['timer', 'Секунд на ход', [30, 45, 60]], ['goal', 'Очков до победы', [25, 40, 60]]],
  whoami:       [['rounds', 'Персонажей на игрока', [1, 2, 3]]],
  associations: [['rounds', 'Слов в цепочке', [5, 8, 12, 16]]],
  would_rather: [['rounds', 'Дилемм в партии', [10, 15, 25, 40]]],
}
const AXIS_DEFAULT = { rounds: 6, timer: 60, goal: 40, players: 8, mafiaCount: 2, places: 4 }

function GameLobbySettings({ game, settings, setSettings, haptic }) {
  const schema = GAME_LOBBY_SCHEMA[game?.id] || [['rounds', 'Раундов', [3, 5, 6, 10]]]
  // При смене игры текущее значение может не входить в новые опции —
  // подставляем минимум из доступных (opts[0]).
  useEffect(() => {
    setSettings(s => {
      const next = { ...s }
      let changed = false
      for (const [axis, , opts] of schema) {
        const cur = next[axis]
        if (cur == null || !opts.includes(cur)) { next[axis] = opts[0]; changed = true }
      }
      return changed ? next : s
    })
  }, [game?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {schema.map(([axis, label, opts]) => {
        const current = settings[axis] ?? opts[0]
        return (
          <div key={axis} className="lobby-block setup-count-block">
            <div className="setup-count-label">
              <Layers size={18}/> {label}
            </div>
            <div className="setup-count-row">
              {opts.map(n => (
                <button key={n}
                  className={`setup-count-tab ${current === n ? 'is-active' : ''}`}
                  aria-pressed={current === n}
                  onClick={() => { setSettings(s => ({ ...s, [axis]: n })); haptic?.() }}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

// Селектор количества карточек для PlayerSetup. Используется и в lobby через
// GameLobbySettings — оба теперь рендерятся одинаковым стилем.
function CardCountSelector({ game, settings, setSettings, style }) {
  // Универсальный выбор: 25/50/100 карточек для всех игр (единый UX).
  // Игре-зависимый лейбл оставляем — где-то это «карточек», где-то «вопросов».
  const opts = [25, 50, 100]
  const label = ['never','whoofus'].includes(game?.id)
    ? 'Вопросов' : 'Карточек'
  // По умолчанию выбирается наименьшее значение (если текущее не в списке опций).
  useEffect(() => {
    setSettings(s => {
      const cur = s?.rounds
      if (cur == null || !opts.includes(cur)) return { ...s, rounds: opts[0] }
      return s
    })
  }, [game?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = settings?.rounds ?? opts[0]
  return (
    <div className="setup-axis-card" style={style}>
      <div className="setup-axis-tabs-row">
        <div className="setup-axis-key"><Layers size={16}/> {label}</div>
        <div className="setup-axis-tabs">
          {opts.map(n => (
            <button key={n}
              className={`setup-axis-tab ${current === n ? 'is-active' : ''}`}
              aria-pressed={current === n}
              onClick={() => setSettings(s => ({ ...s, rounds: n }))}>
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ─── VibeBurst — наборы эмодзи под каждый вайб ─────────────────────────── */
// По 5 максимально характерных эмодзи на вайб — burst выбирает случайные.
// Меньше шума, узнаваемее «лицо» каждого вайба.
const VIBE_AMBIENT_EMOJI = {
  warmup:       ['✨','🎉','🪩','🌟','🥳'],
  funny:        ['😂','🤣','🤡','😅','🎭'],
  family:       ['🏠','🧸','🎂','🐕','🎈'],
  new_people:   ['🤝','👋','🥂','🪩','✨'],
  deep:         ['❤️','💞','💭','🌌','🤲'],
  teambuilding: ['💼','🚀','🏆','💡','🎯'],
  cringe:       ['🤡','😬','🫣','💀','🫠'],
  adult:        ['🔥','💋','😈','🌶️','🍷'],
  ultra_adult:  ['💋','🥵','💦','😈','🩷'],
}
// JS-driven particle burst: гонится rAF, физика (импульс + гравитация +
// сопротивление). Это даёт по-настоящему плавную траекторию (CSS keyframes
// с calc'ами интерполируются неравномерно — отсюда «дёрганость»).
//
// Эффект «премиальный»: 3 уровня глубины (background → mid → foreground)
// с разными размерами и speed-множителями = parallax. Сначала яркая
// вспышка от центра (button pulse + scale-pop частиц), потом плавный
// взлёт «фейерверком» и медленное опадание/таяние.
function VibeBurst({ vibe, burst }) {
  const burstId = burst?.id || 0
  const rootRef = useRef(null)
  const rafRef = useRef(0)
  const particlesRef = useRef([])

  useEffect(() => {
    if (!burstId || !vibe || !VIBE_AMBIENT_EMOJI[vibe]) return
    const set = VIBE_AMBIENT_EMOJI[vibe] || []
    if (!set.length) return
    const root = rootRef.current
    if (!root) return

    const originX = (burst?.x != null) ? burst.x : window.innerWidth / 2
    const originY = (burst?.y != null) ? burst.y : window.innerHeight / 2

    // Кнопка-источник: коротко пульсирует, подтверждая тап (премиум-feedback).
    const btn = document.querySelector('.bnav-item.is-vibe')
    if (btn) {
      btn.classList.add('is-bursting')
      setTimeout(() => btn.classList.remove('is-bursting'), 600)
    }

    // 22 частицы: 3 «слоя» глубины — front (большие, быстрые) /
    // mid (средние) / back (мелкие, медленные). Parallax даёт ощущение
    // объёма, а не плоский фейерверк.
    const N = 22
    const particles = []
    for (let i = 0; i < N; i++) {
      const layer = i < 6 ? 'front' : i < 14 ? 'mid' : 'back'
      const sizeBase = layer === 'front' ? 42 : layer === 'mid' ? 30 : 22
      const sizeJit = layer === 'front' ? 12 : layer === 'mid' ? 8 : 6
      const speedMul = layer === 'front' ? 1.0 : layer === 'mid' ? 0.85 : 0.7
      // Угол выстрела: веер вверх ±70°, без точек строго вверх (там толпится)
      const t = i / (N - 1)
      const angle = -Math.PI / 2 + (t - 0.5) * (Math.PI * 0.95) + (Math.random() - 0.5) * 0.18
      const speed = (10 + Math.random() * 6) * speedMul
      const size = sizeBase + Math.floor(Math.random() * sizeJit)
      particles.push({
        x: 0, y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rot: (Math.random() - 0.5) * 30,
        vrot: (Math.random() - 0.5) * 6, // °/frame
        size,
        emoji: set[Math.floor(Math.random() * set.length)],
        layer,
        life: 0,
        maxLife: 110 + Math.floor(Math.random() * 50), // 110-160 frames ≈ 1.8-2.7s
        // pop-scale animation in first 8 frames
        scale: 0,
        targetScale: 0.9 + Math.random() * 0.35,
        // delay чтобы частицы не вылетали залпом — лёгкий разнобой
        delay: Math.floor(Math.random() * 5),
      })
    }
    particlesRef.current = particles

    // Создаём DOM-ноды один раз, далее только обновляем transform/opacity.
    root.innerHTML = ''
    const nodes = particles.map(p => {
      const el = document.createElement('span')
      el.className = `vibe-burst-em layer-${p.layer}`
      el.style.left = `${originX}px`
      el.style.top = `${originY}px`
      el.style.fontSize = `${p.size}px`
      el.style.opacity = '0'
      el.style.willChange = 'transform, opacity'
      el.textContent = p.emoji
      root.appendChild(el)
      return el
    })

    // Физика
    const GRAVITY = 0.42        // px/frame²
    const DRAG_X = 0.985        // воздух гасит горизонтальную скорость
    const DRAG_Y_UP = 0.992     // вверху воздух почти не сопротивляется
    const FADE_IN = 6           // frames для появления
    const FADE_OUT_FROM = 0.6   // с какой доли life начинаем таять
    const startTime = performance.now()
    const maxLife = 170 // глобальный потолок

    function step() {
      let alive = 0
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        if (p.life < 0) { p.life++; continue } // ждём delay
        p.life++
        if (p.delay > 0 && p.life < p.delay) continue
        // scale pop-in
        if (p.scale < p.targetScale) p.scale = Math.min(p.targetScale, p.scale + p.targetScale * 0.18)

        // velocity update
        p.vx *= DRAG_X
        p.vy = p.vy * (p.vy < 0 ? DRAG_Y_UP : 0.995) + GRAVITY
        p.x += p.vx
        p.y += p.vy
        p.rot += p.vrot
        p.vrot *= 0.97 // вращение постепенно замедляется

        // opacity
        let opacity = 1
        if (p.life < FADE_IN) opacity = p.life / FADE_IN
        const lifeT = p.life / p.maxLife
        if (lifeT > FADE_OUT_FROM) {
          opacity *= 1 - (lifeT - FADE_OUT_FROM) / (1 - FADE_OUT_FROM)
        }
        if (p.life < p.maxLife) alive++

        // apply
        const node = nodes[i]
        if (node) {
          node.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) rotate(${p.rot}deg) scale(${p.scale})`
          node.style.opacity = String(Math.max(0, Math.min(1, opacity)))
        }
      }
      const elapsed = performance.now() - startTime
      if (alive > 0 && elapsed < maxLife * 16.7) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        // cleanup
        nodes.forEach(n => n.remove())
        particlesRef.current = []
      }
    }
    rafRef.current = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(rafRef.current)
      if (rootRef.current) rootRef.current.innerHTML = ''
    }
  }, [burstId, vibe, burst?.x, burst?.y])

  return <div className="vibe-burst" data-vibe={vibe} aria-hidden="true" ref={rootRef}/>
}

/* ─── BottomNav — фикс-меню снизу ────────────────────────────────────────── */
const NAV_ITEMS = [
  { id: SCREENS.HOME,         label: 'Дом',       Icon: Home },
  { id: SCREENS.GAMES,        label: 'Играть',    Icon: Dices },
  { id: '__VIBE__',           label: 'Вайб',      Icon: Sparkles, accent: true }, // спец-слот
  { id: SCREENS.FRIENDS,      label: 'Друзья',    Icon: Users },
  { id: SCREENS.SETTINGS,     label: 'Настройки', Icon: Settings },
]

function BottomNav({ screen, onNavigate, currentVibe, onOpenVibePicker }) {
  const vibe = VIBES.find(v => v.id === currentVibe) || VIBES[0]
  // «Играть» подсвечена активной, когда мы в любом экране Play-группы
  // (детали игры, лобби, раунд, результаты и т.д.).
  const inPlayGroup = isPlayGroup(screen)
  return (
    <nav className="bottom-nav" role="navigation" aria-label="Главное меню">
      {NAV_ITEMS.map(item => {
        if (item.id === '__VIBE__') {
          // Центральный слот — только иконка вайба (название не помещалось
          // для «Близкие друзья» и др.). Цветная индикация = текущий вайб,
          // кружок-индикатор внизу, под иконкой подпись «Вайб» как у других
          // слотов (короткая, всегда одна и та же).
          return (
            <button
              key="vibe"
              type="button"
              className="bnav-item is-vibe"
              data-vibe={vibe.id}
              onClick={onOpenVibePicker}
              aria-label={`Сменить вайб (сейчас: ${vibe.label})`}
            >
              <span className="bnav-vibe-icon"><VibeIcon vibeId={vibe.id} size={22}/></span>
              <span className="bnav-vibe-label">{vibe.label}</span>
            </button>
          )
        }
        const active = (item.id === SCREENS.GAMES && inPlayGroup) || item.id === screen
        const { Icon } = item
        return (
          <button
            key={item.id}
            type="button"
            className={`bnav-item ${active ? 'is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <span className="bnav-ico"><Icon size={20}/></span>
            <span className="bnav-lbl">{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

/* ─── VibePickerModal — крупный, центральный, в один тап ────────────────── */
function VibePickerModal({ currentVibe, onPick, onClose, ownedPacks = [], onBuy }) {
  const [showAdult, setShowAdult] = useState(null)
  const owns = (v) => !v.premium || !v.packId || ownedPacks.includes(v.packId)
  const pick = (v) => {
    if (v.premium && !owns(v)) { onBuy?.(v); return }
    if ((v.id === 'adult' || v.id === 'ultra_adult') && v.id !== currentVibe) { setShowAdult(v.id); return }
    onPick(v.id)
  }
  const confirmAdult = () => { onPick(showAdult); setShowAdult(null) }
  return (
    <div className="modal-backdrop welcome-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Выбор вайба">
      <div className="welcome-modal vibe-picker-modal" onClick={e => e.stopPropagation()}>
        <p className="eyebrow" style={{justifyContent: 'center'}}><Sparkles size={13}/> Вайб компании</p>
        <h2 className="gradient-text" style={{textAlign: 'center', margin: '4px 0 4px'}}>На что настраиваемся?</h2>
        <p className="lead" style={{textAlign: 'center', marginBottom: 18}}>
          Влияет на <b>вопросы, задания и тон</b> карточек во всех играх.
        </p>
        <div className="vibe-picker-grid">
          {VIBES.map(v => {
            const owned = owns(v)
            const locked = v.premium && !owned
            return (
              <button
                key={v.id}
                className={`vibe-picker-tile ${v.id === currentVibe ? 'is-active' : ''} ${locked ? 'is-locked' : ''}`}
                data-adult={(v.id === 'adult' || v.id === 'ultra_adult') ? 'true' : undefined}
                onClick={() => pick(v)}
              >
                <span className="vibe-picker-icon"><VibeIcon vibeId={v.id} size={28}/></span>
                <span className="vibe-picker-label">{v.label}</span>
                <span className="vibe-picker-hint">{v.hint}</span>
                {locked && <span className="vibe-picker-lock"><Lock size={11}/> {v.priceStars}★</span>}
                {v.id === currentVibe && !locked && <Check size={14} className="vibe-picker-check"/>}
              </button>
            )
          })}
        </div>
        <button className="btn-ghost" style={{width: '100%', justifyContent: 'center', marginTop: 18}} onClick={onClose}>
          <X size={15}/> Закрыть
        </button>
        {showAdult && (
          <AdultWarningModal vibe={showAdult} onConfirm={confirmAdult} onCancel={() => setShowAdult(null)}/>
        )}
      </div>
    </div>
  )
}

/* ─── PackPurchaseModal — экран покупки одного пака за Telegram Stars ───── */
function PackPurchaseModal({ vibe, onPurchased, onClose }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const buy = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await api.createInvoice(vibe.packId)
      if (!r?.invoiceUrl) throw new Error(r?.error || 'no_invoice')
      const tg = window.Telegram?.WebApp
      if (tg?.openInvoice) {
        tg.openInvoice(r.invoiceUrl, (status) => {
          setBusy(false)
          if (status === 'paid') onPurchased?.()
          else if (status === 'cancelled') {} // closed silently
          else if (status === 'failed') setErr('Платёж не прошёл')
          else if (status === 'pending') {} // ожидаем webhook
        })
      } else {
        // web-режим — откроем ссылку, успех проверится по next /api/me poll
        window.open(r.invoiceUrl, '_blank', 'noopener')
        setBusy(false)
      }
    } catch (e) { setErr(e?.message || 'Ошибка'); setBusy(false) }
  }
  return (
    <div className="modal-backdrop welcome-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="welcome-modal" onClick={e => e.stopPropagation()} style={{textAlign: 'center', padding: '24px 22px'}}>
        <div style={{fontSize: 48, marginBottom: 10}}>{vibe.icon}</div>
        <h2 className="gradient-text" style={{margin: '0 0 4px'}}>{vibe.label}</h2>
        <p className="lead" style={{margin: '0 0 16px'}}>{vibe.hint}</p>
        <div className="pack-buy-price">
          <Lock size={14}/> Премиум-пак · <b>{vibe.priceStars} ★</b>
        </div>
        <p className="muted" style={{fontSize: 12, marginTop: 12, lineHeight: 1.5}}>
          Покупка через Telegram Stars. После оплаты пак сразу доступен
          во всех играх — никаких подписок и автосписаний.
        </p>
        {err && <div className="pack-buy-err"><X size={13}/> {err}</div>}
        <button className="btn-primary" style={{width: '100%', marginTop: 16}} disabled={busy} onClick={buy}>
          {busy ? 'Открываем оплату…' : <>⭐ Купить за {vibe.priceStars} Stars</>}
        </button>
        <button className="btn-ghost" style={{width: '100%', justifyContent: 'center', marginTop: 8}} onClick={onClose}>
          Не сейчас
        </button>
      </div>
    </div>
  )
}

/* ─── PurchaseSuccessModal — спасибо за покупку ──────────────────────────── */
function PurchaseSuccessModal({ vibe, onClose }) {
  return (
    <div className="modal-backdrop welcome-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="welcome-modal purchase-success-modal" onClick={e => e.stopPropagation()}>
        <div className="purchase-success-icon">
          <div className="purchase-success-ring"/>
          <span>{vibe.icon}</span>
        </div>
        <h2 className="gradient-text" style={{margin: '0 0 4px'}}>Спасибо!</h2>
        <p className="lead" style={{margin: '0 0 6px'}}>
          Пак <b>«{vibe.label}»</b> активирован.
        </p>
        <p className="muted" style={{fontSize: 13, lineHeight: 1.5, marginBottom: 14}}>
          Карточки доступны во всех играх. Когда ты — хост, друзья
          в твоей комнате играют с этим набором бесплатно.
        </p>
        <p className="lead" style={{margin: '0 0 16px', color: 'var(--accent-2)', fontWeight: 600}}>
          Веселых игр! 🎉
        </p>
        <button className="btn-primary" style={{width: '100%'}} onClick={onClose}>
          Поехали
        </button>
      </div>
    </div>
  )
}

/* ─── ViewedPlayerModal ──────────────────────────────────────────────────── */
// Карточка чужого игрока без TG-username: имя, аватарка, эмодзи. Лёгкая alt-версия
// «профиля по тапу на аватарку», когда нет смысла открывать чат.
/* ─── PremiumModal — карточка подписки PartyUp Premium ─────────────────────
   Показывает преимущества, цену в звёздах, состояние (активна / не активна).
   Кнопка покупки открывает Telegram Stars invoice. */
/* Список премиум-паков, которые открывает подписка. Показывается в PremiumModal. */
const PREMIUM_PACKS_INFO = [
  { id: 'pack_cringe',       title: 'Кринж',       emoji: '🤡', vibe: 'Кринж',       desc: 'Неловкие моменты, признания, фейлы — для тех, кто умеет смеяться над собой.' },
  { id: 'pack_teambuilding', title: 'Тимбилдинг',  emoji: '💼', vibe: 'Тимбилдинг',  desc: 'Карточки для коллег и команд. Без офисного занудства — настоящие тимбилдинг-вопросы.' },
  { id: 'pack_ultra_adult',  title: '24+',         emoji: '💋', vibe: 'Ultra-Adult', desc: 'Самые откровенные карточки. Без цензуры — только для совсем взрослых компаний.' },
]
function PremiumPacksList({ unlocked }) {
  return (
    <div className="premium-packs-block">
      <div className="premium-packs-title">
        <Layers size={13}/> Что входит в подписку
      </div>
      <div className="premium-packs-list">
        {PREMIUM_PACKS_INFO.map(p => (
          <div key={p.id} className="premium-pack-row">
            <div className="premium-pack-emoji">{p.emoji}</div>
            <div className="premium-pack-info">
              <div className="premium-pack-title">
                {p.title}
                {unlocked && <CircleCheck size={12} className="premium-pack-unlocked"/>}
              </div>
              <div className="premium-pack-desc">{p.desc}</div>
            </div>
          </div>
        ))}
        <div className="premium-pack-row premium-pack-future">
          <div className="premium-pack-emoji"><Sparkles size={18}/></div>
          <div className="premium-pack-info">
            <div className="premium-pack-title">Будущие паки</div>
            <div className="premium-pack-desc">Все новые премиум-наборы откроются автоматически на время подписки.</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PremiumModal({ auth, onClose, haptic }) {
  const [busy, setBusy] = useState(false)
  const isActive = !!auth?.premium?.active
  const until = auth?.premium?.until ? new Date(auth.premium.until) : null
  const daysLeft = until ? Math.max(0, Math.ceil((until.getTime() - Date.now()) / 86400000)) : 0

  const buy = async () => {
    if (busy) return
    setBusy(true)
    try {
      haptic?.('impact')
      const r = await api.createInvoice('__premium__') // legacy path; ignored by server below
      // На самом деле сервер ждёт subscription='premium_30d' — делаем raw fetch.
      const r2 = await fetch('/api/payments/invoice', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json',
          ...(window.Telegram?.WebApp?.initData ? { 'X-Init-Data': window.Telegram.WebApp.initData } : {}),
        },
        body: JSON.stringify({ subscription: 'premium_30d' }),
      })
      const data = await r2.json()
      if (data?.invoiceUrl && window.Telegram?.WebApp?.openInvoice) {
        window.Telegram.WebApp.openInvoice(data.invoiceUrl, () => {})
        onClose?.()
      } else {
        alert(data?.error === 'auth_required'
          ? 'Войдите через Telegram, чтобы оформить подписку.'
          : 'Не удалось открыть оплату. Попробуйте позже.')
      }
    } catch {} finally { setBusy(false) }
  }

  return (
    <div className="modal-backdrop welcome-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="PartyUp Premium">
      <div className="welcome-modal premium-modal" onClick={e => e.stopPropagation()}>
        <div className="premium-modal-glow" aria-hidden="true"/>
        <div className="premium-modal-icon"><Sparkles size={36}/></div>
        <h2 className="premium-modal-title">
          PartyUp <span className="premium-glow">Premium</span>
        </h2>
        {isActive ? (
          <div className="premium-active-state">
            <div className="premium-active-badge">
              <CircleCheck size={16}/> Подписка активна
            </div>
            <div className="premium-active-until">
              До <b>{until?.toLocaleDateString('ru-RU')}</b>
              {daysLeft > 0 && <span className="muted"> · {daysLeft} {daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}</span>}
            </div>
            <p className="premium-modal-desc" style={{marginTop:14}}>
              Все паки разблокированы автоматически. Спасибо, что поддерживаешь проект! 🌟
            </p>
            <PremiumPacksList unlocked/>
          </div>
        ) : (
          <>
            <p className="premium-modal-desc">
              Открой все премиум-паки одной подпиской — и любые будущие.
            </p>
            <PremiumPacksList/>
            <ul className="premium-benefits">
              <li><Crown size={14}/> Анимированный бейдж <span className="premium-glow">Premium</span> у имени</li>
              <li><Rocket size={14}/> Все новые паки добавляются автоматически</li>
              <li><Clock size={14}/> 30 дней с момента покупки</li>
            </ul>
            <div className="premium-price">
              <span className="premium-price-stars">199 ⭐</span>
              <span className="premium-price-rub">≈ 300 ₽</span>
            </div>
          </>
        )}
        <div style={{display:'flex',flexDirection:'column',gap:8,marginTop:18}}>
          {!isActive && (
            <button className="btn-primary" disabled={busy} onClick={buy}>
              <Sparkles size={16}/> {busy ? 'Открываем оплату…' : 'Оформить подписку'}
            </button>
          )}
          <button className="btn-ghost" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}

function ViewedPlayerModal({ player, onClose, onOpenMyProfile }) {
  if (!player) return null
  const username = player.username || player.tg_username || null
  const isMe = !!player._isMe
  const openInTg = () => {
    if (!username) return
    const tg = window.Telegram?.WebApp
    const link = `https://t.me/${username}`
    if (tg?.openTelegramLink) tg.openTelegramLink(link)
    else window.open(link, '_blank')
    onClose?.()
  }
  return (
    <div className="modal-backdrop welcome-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="welcome-modal" onClick={e => e.stopPropagation()} style={{ textAlign: 'center', padding: '28px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <div className="active-player-emoji" style={{ width: 88, height: 88, fontSize: 44 }}>
            {player.photo_url
              ? <img src={player.photo_url} alt="" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}/>
              : <span>{player.emoji || '🎮'}</span>}
          </div>
        </div>
        <h3 style={{ margin: '0 0 6px' }}>{player.name || 'Игрок'}{isMe ? ' (это вы)' : ''}</h3>
        {player.premium && (
          <div className="premium-badge" style={{margin:'4px auto 8px', pointerEvents:'none'}}>
            <Sparkles size={11}/>
            <span className="premium-badge-text">PartyUp <span className="premium-glow">Premium</span></span>
          </div>
        )}
        {username && (
          <p className="lead" style={{ margin: '0 0 6px', color: 'var(--accent-2)' }}>@{username}</p>
        )}
        {!isMe && <p className="lead" style={{ margin: 0 }}>В игре с тобой</p>}
        {isMe ? (
          <>
            <button className="btn-primary" style={{ marginTop: 22, width: '100%' }} onClick={() => { onClose?.(); onOpenMyProfile?.() }}>
              <Settings size={15}/> Открыть мой профиль
            </button>
            <button className="btn-ghost" style={{ marginTop: 8, width: '100%' }} onClick={onClose}>Закрыть</button>
          </>
        ) : username ? (
          <>
            <button className="btn-primary" style={{ marginTop: 22, width: '100%' }} onClick={openInTg}>
              <Send size={15}/> Открыть в Telegram
            </button>
            <button className="btn-ghost" style={{ marginTop: 8, width: '100%' }} onClick={onClose}>Закрыть</button>
          </>
        ) : (
          <button className="btn-primary" style={{ marginTop: 22, width: '100%' }} onClick={onClose}>OK</button>
        )}
      </div>
    </div>
  )
}

/* ─── WelcomeModal ───────────────────────────────────────────────────────── */
function WelcomeModal({ onClose }) {
  return (
    <div className="modal-backdrop welcome-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Добро пожаловать в PartyUp">
      <div className="welcome-modal welcome-modal-v2" onClick={e => e.stopPropagation()}>
        <div className="welcome-hero">
          <div className="welcome-hero-glow" aria-hidden="true"/>
          <div className="welcome-emoji-row">
            {['🎉','⚖️','🎯','😂'].map((e,i) => (
              <div key={i} className="welcome-feat-icon" style={{animationDelay:`${i*0.08}s`}}>{e}</div>
            ))}
          </div>
        </div>

        <p className="eyebrow" style={{justifyContent:'center'}}><Sparkles size={13}/> Добро пожаловать</p>
        <h2 className="gradient-text" style={{textAlign:'center', marginTop: 6}}>PartyUp</h2>
        <p className="welcome-tagline">
          Лучшие игры для компаний в одном приложении.
        </p>

        <ul className="welcome-benefits">
          {[
            { icon: <Rocket size={16}/>, title: 'Старт за 10 секунд', desc: 'Выбрал вайб → выбрал игру → играешь. Ни одной формы.' },
            { icon: <Sparkles size={16}/>, title: 'Вайб меняет весь контент', desc: '9 настроений — от семейного до 18+. Карточки и тон подстроятся.' },
            { icon: <Share2 size={16}/>, title: 'Мультиплеер в два клика', desc: 'Создал комнату → отправил ссылку → играете вместе.' },
            { icon: <Dices size={16}/>, title: 'Любимые классические игры', desc: 'Правда или действие, Я никогда не, Что выберешь, Крокодил, Элиас и другие.' },
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

        <button className="btn-primary" onClick={onClose} style={{width:'100%',justifyContent:'center', marginTop:14}}>
          <PartyPopper size={18}/> Поехали
        </button>
        <p className="welcome-sub-note">
          Можно играть на одном телефоне или вместе по сети — компанию подберёшь сам.
        </p>
      </div>
    </div>
  )
}

/* ─── PromoBanners — карусель баннеров ──────────────────────────────────── */
const PROMO_BANNERS = [
  { id: 'start', emoji: '⚡', title: 'Старт за 10 секунд', desc: 'Выбери вайб → выбери игру → поехали. Никаких регистраций и настроек.', color: '#7c6fff', color2: '#a78bfa' },
  { id: 'adult', emoji: '🔞', title: 'Режим 18+', desc: 'Откровенный контент специально для взрослых компаний. Включается одним нажатием.', color: '#ef4444', color2: '#f87171' },
  { id: 'vibe', emoji: '🌶️', title: 'Умный вайб-фильтр', desc: 'Выбери настроение — вопросы, задания и темп раунда адаптируются автоматически.', color: '#f97316', color2: '#fb923c' },
  { id: 'content', emoji: '🃏', title: '5000+ карточек', desc: 'Огромное обновление контента: вопросы, действия, ситуации, локации и роли — для каждой игры и каждого вайба.', color: '#8b5cf6', color2: '#a78bfa' },
]

function PromoBanners() {
  const [active, setActive] = useState(0)
  const timerRef = useRef(null)
  // touch state для свайпов
  const touchRef = useRef({ x: 0, y: 0, t: 0, locked: null })
  const [dragOffset, setDragOffset] = useState(0)  // px смещения текущего перетаскивания

  const startAuto = useCallback(() => {
    clearInterval(timerRef.current)
    timerRef.current = setInterval(() => setActive(a => (a + 1) % PROMO_BANNERS.length), 4000)
  }, [])

  const goTo = useCallback((idx) => {
    setActive(((idx % PROMO_BANNERS.length) + PROMO_BANNERS.length) % PROMO_BANNERS.length)
    startAuto()
  }, [startAuto])

  useEffect(() => { startAuto(); return () => clearInterval(timerRef.current) }, [startAuto])

  // touch обработчики: горизонтальный свайп влево/вправо переключает баннер
  const SWIPE_THRESHOLD = 40 // px
  const onTouchStart = (e) => {
    const t = e.touches?.[0]; if (!t) return
    touchRef.current = { x: t.clientX, y: t.clientY, t: Date.now(), locked: null }
    setDragOffset(0)
    clearInterval(timerRef.current)
  }
  const onTouchMove = (e) => {
    const t = e.touches?.[0]; if (!t) return
    const dx = t.clientX - touchRef.current.x
    const dy = t.clientY - touchRef.current.y
    // Лочим направление: если первый явно вертикальный — игнорим, отдаём странице.
    if (touchRef.current.locked === null) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        touchRef.current.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
      }
    }
    if (touchRef.current.locked === 'h') {
      e.preventDefault?.()
      setDragOffset(dx)
    }
  }
  const onTouchEnd = () => {
    const { locked } = touchRef.current
    const dx = dragOffset
    setDragOffset(0)
    if (locked === 'h' && Math.abs(dx) > SWIPE_THRESHOLD) {
      goTo(active + (dx < 0 ? 1 : -1))
    } else {
      startAuto()
    }
    touchRef.current.locked = null
  }

  const ab = PROMO_BANNERS[active]
  // Каждый слайд = 100% ширины viewport'а; во время drag добавляем плавный pixel-shift.
  const wrapWidth = typeof window !== 'undefined' ? window.innerWidth : 320
  const dragPct = wrapWidth ? (dragOffset / wrapWidth) * 100 : 0
  const trackStyle = {
    transform: `translateX(calc(-${active * 100}% + ${dragPct}%))`,
    transition: dragOffset === 0 ? 'transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
  }

  return (
    <div className="promo-banners">
      <div className="promo-carousel-viewport"
        style={{'--pb-c1': ab.color, '--pb-c2': ab.color2}}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div className="promo-carousel-track" style={trackStyle}>
          {PROMO_BANNERS.map(b => (
            <div key={b.id} className="promo-slide" style={{'--pb-c1': b.color, '--pb-c2': b.color2}}>
              <div className="promo-banner-emoji">{b.emoji}</div>
              <div className="promo-banner-body">
                <div className="promo-banner-title">{b.title}</div>
                <div className="promo-banner-desc">{b.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="promo-dots">
        {PROMO_BANNERS.map((_, i) => (
          <button key={i} className={`promo-dot ${i === active ? 'is-active' : ''}`}
            onClick={() => goTo(i)} aria-label={`Баннер ${i+1}`}/>
        ))}
      </div>
    </div>
  )
}

/* ─── AdultWarningModal ──────────────────────────────────────────────────── */
function AdultWarningModal({ onConfirm, onCancel, vibe = 'adult' }) {
  const isUltra = vibe === 'ultra_adult'
  // Рендерим через Portal прямо в document.body — гарантирует, что fixed/flex
  // позиционирование не ломается родительскими stacking-contexts.
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="adult-fullscreen" onClick={onCancel} role="dialog" aria-modal="true"
      aria-label={isUltra ? 'Предупреждение 24+' : 'Предупреждение 18+'}>
      <div className="adult-modal-content" onClick={e => e.stopPropagation()}>
        <div className="adult-modal-icon">{isUltra ? '💋' : '🔞'}</div>
        <h3 className="adult-modal-title">
          {isUltra ? 'Самые откровенные темы' : 'Только для взрослых'}
        </h3>
        <p className="adult-modal-text">
          {isUltra ? (
            <>
              Этот режим — про <strong>интимные подробности и кринж в постели</strong>:
              фетиши, провалы, специфические сценарии. Включай только в очень близкой
              компании или с парой.
            </>
          ) : (
            <>
              Этот режим содержит <strong>откровенный контент 18+</strong>:
              провокационные вопросы, горячие задания и взрослые темы.
            </>
          )}
        </p>
        <ul className="adult-modal-rules">
          <li>🔞 Все участники старше 18 лет</li>
          <li>🚪 Вокруг нет детей или посторонних</li>
          <li>💬 Любой может пропустить вопрос — без давления</li>
        </ul>
        <button className="btn-adult-confirm" onClick={onConfirm}>
          <Lock size={16}/> Мне 18+, поехали
        </button>
        <button className="btn-ghost mt-10" style={{width:'100%',justifyContent:'center'}} onClick={onCancel}>
          <ArrowLeft size={14}/> Назад, выбрать другой вайб
        </button>
      </div>
    </div>,
    document.body
  )
}

/* ─── Тематические секции игр ────────────────────────────────────────────── */
const GAME_SECTIONS = [
  { id: 'simple',  emoji: '🎯', title: 'Простые игры',    ids: ['truth','never','whoofus','five','associations','would_rather'] },
  { id: 'explain', emoji: '💬', title: 'Объяснялки',      ids: ['crocodile','alias','whoami'] },
]

function GameSections({ onGame, activeGameIds }) {
  const gameMap = useMemo(() => Object.fromEntries(GAMES.map(g => [g.id, g])), [])
  // Если сервер вернул список active игр — отфильтровываем неактивные.
  // Если ещё не пришло — показываем всё локально.
  const isActive = (id) => !activeGameIds || activeGameIds.has(id)
  return (
    <div className="game-sections">
      {GAME_SECTIONS.map((sec, si) => {
        const ids = sec.ids.filter(id => gameMap[id] && isActive(id))
        if (!ids.length) return null
        return (
          <div key={sec.id} className="game-section">
            <div className="game-section-header">
              <span className="game-section-emoji">{sec.emoji}</span>
              <span className="game-section-title">{sec.title}</span>
            </div>
            <div className="game-list">
              {ids.map((id, i) => (
                <GameRowItem key={id} g={gameMap[id]} onGame={onGame}
                  style={{animationDelay:`${si * 0.06 + i * 0.04}s`}}/>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ─── HomeScreen ──────────────────────────────────────────────────────────── */
function HomeScreen({ picker, setPicker, onPicker, onGame, onAllGames, onBurst, ownedPacks = [], onBuyVibe, popularIds }) {
  const [vibeToast, setVibeToast] = useState(false)
  const [showAdultModal, setShowAdultModal] = useState(null)
  const [pendingAdultEvt, setPendingAdultEvt] = useState(null)
  // Autoscroll к активному vibe-чипу при монтировании/смене вайба.
  const vibeScrollRef = useRef(null)
  useEffect(() => {
    const wrap = vibeScrollRef.current
    if (!wrap) return
    const active = wrap.querySelector('.vibe-chip.is-active')
    if (!active) return
    const wRect = wrap.getBoundingClientRect()
    const aRect = active.getBoundingClientRect()
    const offset = (aRect.left - wRect.left) + aRect.width / 2 - wRect.width / 2
    wrap.scrollTo({ left: wrap.scrollLeft + offset, behavior: 'smooth' })
  }, [picker.vibe])

  const handleVibeChange = (vibeId) => {
    if (vibeId === picker.vibe) return
    const v = VIBES.find(x => x.id === vibeId)
    // Платный вайб без покупки — открываем модалку покупки, НЕ переключаем.
    if (v?.premium && v.packId && !ownedPacks.includes(v.packId)) {
      onBuyVibe?.(v)
      return
    }
    if (vibeId === 'adult' || vibeId === 'ultra_adult') {
      setShowAdultModal(vibeId); return
    }
    setPicker(p => ({ ...p, vibe: vibeId }))
    ev.vibeChange(vibeId)
    setVibeToast(true)
    onBurst?.()
  }

  const confirmAdult = () => {
    const v = showAdultModal
    setPicker(p => ({ ...p, vibe: v }))
    ev.vibeChange(v)
    setShowAdultModal(null)
    setVibeToast(true)
    onBurst?.()
  }

  return (
    <div>
      {/* Promo banners */}
      <PromoBanners />

      {/* Vibe Section */}
      <div className="vibe-section">
        <div className="vibe-section-header">
          <div className="vibe-section-title">
            <div className="vibe-icon-glow" aria-hidden="true">
              <Sparkles size={22} color="var(--accent-2)"/>
            </div>
            Выберите вайб компании
          </div>
          <p className="vibe-section-desc">
            Выбери настроение — приложение адаптирует <strong>вопросы, задания и контент</strong> под твою компанию.
          </p>
        </div>
        <div ref={vibeScrollRef} className="vibe-scroll" role="listbox" aria-label="Выбор вайба">
          {VIBES.map(v => {
            const locked = v.premium && v.packId && !ownedPacks.includes(v.packId)
            return (
              <button key={v.id} role="option" aria-selected={v.id === picker.vibe}
                className={`vibe-chip ${v.id === picker.vibe ? 'is-active' : ''} ${locked ? 'is-locked' : ''}`}
                data-adult={(v.id === 'adult' || v.id === 'ultra_adult') ? 'true' : undefined}
                onClick={(e) => handleVibeChange(v.id, e)}>
                <span className="vibe-chip-icon"><VibeIcon vibeId={v.id} size={20}/></span>
                <span className="vibe-chip-label">{v.label}</span>
                <span className="vibe-chip-hint">{v.hint}</span>
                {locked && <span className="vibe-chip-lock"><Lock size={10}/> {v.priceStars}★</span>}
              </button>
            )
          })}
        </div>
        {vibeToast && (
          <div className="vibe-affects" key={picker.vibe}>
            <Info size={14} color="var(--accent)" style={{flexShrink:0, marginTop:1}}/>
            <span>
              <span className="vibe-affects-label">Влияет на: </span>
              вопросы, задания, темп раунда, интенсивность контента и подобранные игры.
            </span>
          </div>
        )}
      </div>

      {/* Section header: Популярные игры */}
      <div className="section-header" style={{marginTop: 24}}>
        <div className="vibe-section-title" style={{marginBottom: 0}}>
          <div className="vibe-icon-glow" aria-hidden="true">
            <Flame size={22} color="var(--accent-2)"/>
          </div>
          Популярные игры
        </div>
      </div>

      {/* Популярные игры — управляется из админки (флаг games_meta.popular).
          Источник: /api/catalog (см. HomeScreen — popularIds prop). */}
      <div className="game-list" style={{marginTop: 12}}>
        {(popularIds || [])
          .map(id => GAMES.find(g => g.id === id))
          .filter(Boolean)
          .map((g, i) => (
            <GameRowItem key={g.id} g={g} onGame={onGame}
              style={{animationDelay:`${i * 0.04}s`}}/>
          ))}
      </div>

      <PressBtn className="btn-all-games" onClick={onAllGames} delay={160}>
        <span>Все игры</span>
        <ChevronRight size={16}/>
      </PressBtn>

      {showAdultModal && (
        <AdultWarningModal
          vibe={showAdultModal}
          onConfirm={confirmAdult}
          onCancel={() => setShowAdultModal(null)}
        />
      )}
    </div>
  )
}

/* ─── VibeMiniBar — горизонтальный скролл вайбов с автоскроллом к активному ─ */
function VibeMiniBar({ picker, onPickVibe, showLabel = true }) {
  const scrollRef = useRef(null)
  // Автоскролл к активному чипу при монтировании и при смене вайба
  // (например, переход с Home, где выбран 24+, на Games — список сразу
  // сдвинется так, чтобы было видно «24+» в видимой области).
  useEffect(() => {
    const wrap = scrollRef.current
    if (!wrap) return
    const active = wrap.querySelector('.vibe-chip-mini.is-active')
    if (!active) return
    const wRect = wrap.getBoundingClientRect()
    const aRect = active.getBoundingClientRect()
    const offset = (aRect.left - wRect.left) + aRect.width / 2 - wRect.width / 2
    wrap.scrollTo({ left: wrap.scrollLeft + offset, behavior: 'smooth' })
  }, [picker.vibe])
  return (
    <div ref={scrollRef} className="vibe-scroll vibe-scroll-mini" role="listbox" aria-label="Вайб">
      {showLabel && <span className="vibe-scroll-label">Ваш вайб:</span>}
      {VIBES.map(v => (
        <button key={v.id} role="option" aria-selected={v.id === picker.vibe}
          className={`vibe-chip vibe-chip-mini ${v.id === picker.vibe ? 'is-active' : ''}`}
          data-adult={(v.id === 'adult' || v.id === 'ultra_adult') ? 'true' : undefined}
          onClick={(e) => onPickVibe(v.id, e)}>
          <span className="vibe-chip-icon"><VibeIcon vibeId={v.id} size={16}/></span>
          <span className="vibe-chip-label">{v.label}</span>
        </button>
      ))}
    </div>
  )
}

/* ─── GamesScreen — каталог простых игр (категории/вайб временно скрыты) ── */
function GamesScreen({ onGame, onEnterLobby, activeGameIds }) {
  return (
    <div>
      <p className="eyebrow"><Dices size={13}/> Все игры</p>
      <h2 style={{marginBottom: 4}}>Выбирай и играй</h2>
      <p className="lead" style={{marginBottom: 14}}>На одном телефоне или вместе по сети — за пару тапов.</p>

      <GameSections onGame={onGame} activeGameIds={activeGameIds}/>

      {/* Войти в лобби — под списком игр. Не основное действие на этом экране,
          поэтому secondary-стиль и нижняя позиция, без burst-эффекта. */}
      <button
        className="btn-secondary no-pulse"
        style={{marginTop: 16, width: '100%'}}
        onClick={onEnterLobby}
      >
        <UserPlus size={15}/> Войти в лобби
      </button>
    </div>
  )
}

/* ─── CreateLobbyScreen — настройки лобби в одном экране ─────────────────── */
function CreateLobbyScreen({ picker, setPicker, settings, setSettings, myName, onCreate, onEnterRoom, haptic, onBurst }) {
  const [selectedId, setSelectedId] = useState(() => GAMES[0]?.id)
  const [showAdultModal, setShowAdultModal] = useState(null)
  const [code, setCode] = useState('')
  const selected = useMemo(() => GAMES.find(g => g.id === selectedId) || GAMES[0], [selectedId])

  const ROUND_OPTIONS = [3, 5, 6, 10]
  const [pendingAdultEvt, setPendingAdultEvt] = useState(null)

  const handleVibe = (vibeId, evt) => {
    if (vibeId === picker.vibe) { onBurst?.(evt); return }
    if (vibeId === 'adult' || vibeId === 'ultra_adult') {
      setPendingAdultEvt(evt); setShowAdultModal(vibeId); return
    }
    setPicker(p => ({ ...p, vibe: vibeId }))
    ev.vibeChange(vibeId)
    onBurst?.(evt)
  }
  const confirmAdult = () => {
    const v = showAdultModal
    setPicker(p => ({ ...p, vibe: v }))
    ev.vibeChange(v)
    setShowAdultModal(null)
    onBurst?.(pendingAdultEvt)
  }

  const invite = async () => {
    const deeplink = miniAppLink(BOT_USERNAME, APP_SHORT_NAME, 'from_share') || 'https://partyup-game.ru'
    const text = `Зову играть в PartyUp 🎮 — ${selected.title}`
    await doInviteShare({ deeplink, text, gameId: selected.id, kind: 'invite', evName: 'lobby_pre_invite' })
  }

  const [joinChecking, setJoinChecking] = useState(false)
  const tryJoin = async () => {
    const c = code.trim().toUpperCase()
    if (!/^[A-Z0-9]{4,12}$/.test(c)) {
      haptic?.('error')
      flashToast('Введи код из 4–12 символов (буквы и цифры)')
      return
    }
    setJoinChecking(true)
    try {
      // Проверяем, существует ли активная комната, прежде чем переходить.
      const r = await api.roomState(c)
      if (!r || r.error === 'room_not_found') {
        haptic?.('error')
        flashToast('Комнаты с таким кодом не существует')
        return
      }
      if (r.state === 'ended') {
        haptic?.('error')
        flashToast('Игра в этой комнате уже закончилась')
        return
      }
      haptic?.('success')
      onEnterRoom(c)
    } catch {
      haptic?.('error')
      flashToast('Не удалось проверить комнату — попробуй ещё раз')
    } finally {
      setJoinChecking(false)
    }
  }

  return (
    <div>
      <p className="eyebrow"><PartyPopper size={13}/> Онлайн-лобби</p>
      <h2 style={{marginBottom: 6}}>Создать лобби</h2>
      <p className="lead" style={{marginBottom: 18}}>
        {myName ? <>Хост: <strong>{myName}</strong>. </> : null}
        Настрой раунд и пригласи друзей по ссылке.
      </p>

      {/* Вайб — теперь сверху */}
      <div className="lobby-block">
        <div className="lobby-block-label"><Sparkles size={14}/> Вайб</div>
        <VibeMiniBar picker={picker} onPickVibe={handleVibe} showLabel={false}/>
      </div>

      {/* Игра — с иконками из каталога */}
      <div className="lobby-block">
        <div className="lobby-block-label"><Dices size={14}/> Игра</div>
        <div className="lobby-game-pick" role="listbox" aria-label="Выбор игры">
          {GAMES.map(g => (
            <button key={g.id} role="option" aria-selected={g.id === selectedId}
              className={`lobby-game-chip ${g.id === selectedId ? 'is-active' : ''}`}
              onClick={() => { setSelectedId(g.id); haptic?.() }}>
              <span className="lgc-icon"><GameIcon gameId={g.id} size={22}/></span>
              <span className="lgc-name">{g.title}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Настройки выбранной игры — динамические */}
      <GameLobbySettings game={selected} settings={settings} setSettings={setSettings} haptic={haptic}/>

      {/* CTA: только «Создать комнату» */}
      <PressBtn className="btn-primary lobby-cta-create" style={{width:'100%', marginTop: 4}}
        onClick={() => onCreate(selectedId)} delay={140}>
        <Play size={16}/> Создать комнату
      </PressBtn>

      {/* Войти в комнату (перенесено из «Друзей») */}
      <div className="card friends-card lobby-join-card" style={{marginTop: 18}}>
        <div className="friends-card-icon"><Key size={20}/></div>
        <div className="friends-card-body">
          <div className="friends-card-title">Войти в комнату</div>
          <div className="friends-card-desc">У тебя есть код от друга? Введи его.</div>
          <div className="lobby-join-row">
            <input
              className="lobby-join-input"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              placeholder="КОД (ABC123)"
              maxLength={12}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <PressBtn className="btn-primary lobby-join-btn" onClick={tryJoin} delay={120}
              disabled={joinChecking || code.length < 4}>
              {joinChecking ? '…' : <><ChevronRight size={16}/> Войти</>}
            </PressBtn>
          </div>
        </div>
      </div>

      {showAdultModal && (
        <AdultWarningModal
          vibe={showAdultModal}
          onConfirm={confirmAdult}
          onCancel={() => setShowAdultModal(null)}
        />
      )}
    </div>
  )
}

/* ─── FriendsScreen — приглашение + список соигроков ─────────────────────── */
function FriendsScreen({ focusJoinInput, onClearFocus, onJoinRoom, onOpenPlayer }) {
  const PAGE = 20
  const [friends, setFriends] = useState([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [code, setCode] = useState('')
  const joinInputRef = useRef(null)
  useEffect(() => {
    if (focusJoinInput && joinInputRef.current) {
      joinInputRef.current.focus()
      onClearFocus?.()
    }
  }, [focusJoinInput, onClearFocus])
  const tryJoin = () => {
    const c = (code || '').trim().toUpperCase()
    if (!/^[A-Z0-9]{4,8}$/.test(c)) return
    onJoinRoom?.(c)
  }

  // Загрузка одной страницы (PAGE штук) при смене offset.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.friends({ limit: PAGE, offset }).then(r => {
      if (cancelled) return
      setFriends(Array.isArray(r?.rows) ? r.rows : [])
      setTotal(Number(r?.total || 0))
      setLoading(false)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [offset])

  const invite = async () => {
    const deeplink = miniAppLink(BOT_USERNAME, APP_SHORT_NAME, 'friends_invite') || 'https://partyup-game.ru'
    const text = 'Зову играть в PartyUp 🎮 — лучшие игры для компаний'
    await doInviteShare({ deeplink, text, kind: 'invite', evName: 'friends_invite' })
  }

  // Открываем внутренний профиль игрока (никаких внешних TG-ссылок).
  // Доступно ТОЛЬКО для TG-юзеров (есть user_id) — у гостей профиля нет.
  const openInternalProfile = (f) => {
    if (!f?.user_id) return
    onOpenPlayer?.({
      id: `tg_${f.user_id}`,
      userId: f.user_id,
      telegramId: f.user_id,
      name: f.display_name || (f.username ? `@${f.username}` : 'Игрок'),
      username: f.username || null,
      photo_url: f.photo_url || null,
      emoji: f.emoji || '🎮',
    })
  }

  return (
    <div>
      <p className="eyebrow"><Users size={13}/> Друзья</p>
      <h2 style={{marginBottom: 18}}>Сыграйте вместе</h2>

      {/* Пригласить */}
      <div className="card friends-card">
        <div className="friends-card-icon"><Send size={20}/></div>
        <div className="friends-card-body">
          <div className="friends-card-title">Позвать в PartyUp</div>
          <div className="friends-card-desc">Отправь другу ссылку — он откроет приложение сразу.</div>
          <PressBtn className="btn-primary" style={{width:'100%', marginTop: 12}} onClick={invite} delay={140}>
            <Share2 size={16}/> Поделиться
          </PressBtn>
        </div>
      </div>

      {/* Войти в комнату */}
      <div className="card friends-card" style={{marginTop: 12}}>
        <div className="friends-card-icon"><Key size={20}/></div>
        <div className="friends-card-body">
          <div className="friends-card-title">Войти в комнату</div>
          <div className="friends-card-desc">У друга есть код лобби? Введи его, чтобы присоединиться.</div>
          <div style={{display: 'flex', marginTop: 12, gap: 8, alignItems: 'stretch'}}>
            <input
              ref={joinInputRef}
              className="setup-player-input"
              style={{flex: 1, minWidth: 0, textTransform: 'uppercase', letterSpacing: '2px', textAlign: 'center', fontSize: 16, fontWeight: 700}}
              placeholder="A1B2C3"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
              onKeyDown={e => { if (e.key === 'Enter') tryJoin() }}
              maxLength={8}
              autoCapitalize="characters"
            />
            <button className="btn-primary no-pulse" style={{flexShrink: 0, width: 'auto', padding: '0 18px', minHeight: 44}}
              disabled={!/^[A-Z0-9]{4,8}$/.test(code.trim())}
              onClick={tryJoin}>
              <Play size={15}/> Войти
            </button>
          </div>
        </div>
      </div>

      {/* Список соигроков */}
      <div className="friends-list-block">
        <div className="friends-list-header">
          <Heart size={14}/> Игроки из ваших комнат
        </div>
        {loading && <div className="friends-empty">Загружаем…</div>}
        {!loading && friends.length === 0 && (
          <div className="friends-empty">
            Пока пусто. Создайте лобби и позовите друга — он появится здесь.
          </div>
        )}
        {!loading && friends.length > 0 && (
          <div className="friends-list">
            {friends.map(f => {
              const key = f.user_id ? `u:${f.user_id}` : `a:${f.anon_id}`
              const displayName = f.display_name || (f.username ? `@${f.username}` : null) || 'Гость'
              const initial = (displayName || f.emoji || '?').slice(0, 1).toUpperCase()
              const isGuest = !!f.is_guest
              const tappable = !!f.user_id // открываем профиль только для TG-юзеров
              return (
                <button key={key} className="friend-row"
                  onClick={() => tappable && openInternalProfile(f)}
                  title={tappable ? 'Открыть профиль игрока' : (isGuest ? 'Гостевой игрок — профиль недоступен' : '')}
                  disabled={!tappable}
                  style={{cursor: tappable ? 'pointer' : 'default', opacity: tappable ? 1 : 0.7}}>
                  <div className="friend-avatar">
                    {f.photo_url
                      ? <img src={f.photo_url} alt="" referrerPolicy="no-referrer"/>
                      : (isGuest && f.emoji
                          ? <span style={{fontSize:18}}>{f.emoji}</span>
                          : <span>{initial}</span>)}
                  </div>
                  <div className="friend-info">
                    <div className="friend-name">
                      {displayName}
                      {isGuest && <span className="friend-guest-badge">гость</span>}
                    </div>
                    <div className="friend-meta">{f.games_together} игр{f.games_together === 1 ? 'а' : ''} вместе</div>
                  </div>
                  {tappable && <ChevronRight size={16} color="var(--muted)"/>}
                </button>
              )
            })}
          </div>
        )}
        {!loading && total > PAGE && (
          <div className="friends-pager">
            <button
              className="btn-ghost"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              ← Назад
            </button>
            <span className="friends-pager-info">
              {offset + 1}–{Math.min(offset + friends.length, total)} из {total}
            </span>
            <button
              className="btn-ghost"
              disabled={offset + PAGE >= total}
              onClick={() => setOffset(offset + PAGE)}>
              Вперёд →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── GameRowItem — shared card component ───────────────────────────────── */
function GameRowItem({ g, onGame, style, className }) {
  return (
    <PressBtn
      className={className || 'game-row-item'}
      onClick={() => onGame(g.id)}
      delay={180}
      style={style}
    >
      <div className="game-icon-token">
        <GameIcon gameId={g.id} size={30} color="var(--accent-2)"/>
      </div>
      <div className="game-row-text">
        <div className="game-row-title">{g.title}</div>
        <div className="game-row-sub">{g.short}</div>
      </div>
      <div className="game-play-btn" aria-hidden="true">
        <Play size={13} fill="currentColor" strokeWidth={0}/>
      </div>
    </PressBtn>
  )
}

/* ─── PickerScreen ────────────────────────────────────────────────────────── */
function PickerScreen({ picker, setPicker, recommendations, onSelect }) {
  const [step, setStep] = useState(0)
  const [showAdultModal, setShowAdultModal] = useState(null)
  const steps = [
    { title: 'Сколько вас?', key: 'players', options: PLAYER_PRESETS.map(p => ({ id: p.id, icon: <Users size={22} color="var(--accent-2)"/>, label: p.label, desc: `${p.range[0]}–${p.range[1]} человек` })) },
    { title: 'Какой вайб?', key: 'vibe', options: VIBES.map(v => ({ id: v.id, icon: <VibeIcon vibeId={v.id} size={22}/>, label: v.label, desc: v.hint })) },
    { title: 'Сколько времени?', key: 'duration', options: DURATION_PRESETS.map(d => ({ id: d.id, icon: <Timer size={22} color="var(--accent-2)"/>, label: d.label, desc: '' })) },
  ]
  const cur = steps[step]

  const handlePickerOptionClick = (key, id) => {
    if (key === 'vibe' && (id === 'adult' || id === 'ultra_adult')) {
      setShowAdultModal(id)
      return
    }
    setPicker(p => ({ ...p, [key]: id }))
    if (step < steps.length - 1) setStep(s => s + 1)
  }

  const confirmAdult = () => {
    const v = showAdultModal
    setPicker(p => ({ ...p, vibe: v }))
    setShowAdultModal(null)
    if (step < steps.length - 1) setStep(s => s + 1)
  }

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
            onClick={() => handlePickerOptionClick(cur.key, o.id)}
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

      {showAdultModal && (
        <AdultWarningModal vibe={showAdultModal} onConfirm={confirmAdult} onCancel={() => setShowAdultModal(null)} />
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
function GameDetailScreen({ game, onPickMode, onExit }) {
  return (
    <div className="game-detail-screen">
      {onExit && (
        <div className="screen-top-bar">
          <button className="screen-back-btn" onClick={onExit} aria-label="Назад к списку игр">
            <ArrowLeft size={16}/> К играм
          </button>
        </div>
      )}
      <div className="game-hero">
        <div className="game-hero-icon"><GameIcon gameId={game.id} size={40} color="var(--accent-2)"/></div>
        <h2>{game.title}</h2>
        <p className="lead">{game.short}</p>
        <div className="game-meta-row">
          <span className="tag"><Users size={11}/> 2+ чел.</span>
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

      {/* Режим игры — две крупные карточки с характером (живые градиенты). */}
      <p className="eyebrow" style={{marginTop: 14, marginBottom: 10}}><Play size={12}/> Режим игры</p>
      <div className="mode-card-grid">
        <button className="mode-card mode-card-local" onClick={() => onPickMode('one_phone')}>
          <div className="mode-card-glow" aria-hidden="true"/>
          <div className="mode-card-icon"><Play size={26}/></div>
          <div className="mode-card-text">
            <div className="mode-card-title">Играть на одном телефоне</div>
            <div className="mode-card-desc">Передаём телефон по кругу</div>
          </div>
          <span className="mode-card-arrow"><ChevronRight size={18}/></span>
        </button>
        <button className="mode-card mode-card-mp" onClick={() => onPickMode('multiplayer')}>
          <div className="mode-card-glow" aria-hidden="true"/>
          <div className="mode-card-icon"><Share2 size={26}/></div>
          <div className="mode-card-text">
            <div className="mode-card-title">Мультиплеер</div>
            <div className="mode-card-desc">У каждого свой телефон</div>
          </div>
          <span className="mode-card-arrow"><ChevronRight size={18}/></span>
        </button>
      </div>
    </div>
  )
}

/* ─── PlayerSetupScreen ──────────────────────────────────────────────────── */
// Single-player setup: режим уже выбран на DetailScreen, сразу вводим игроков,
// + выбор вайба и кол-ва карточек. Имена/количество и вайб запоминаются в
// localStorage и подставляются во все последующие single-сессии.
const SINGLE_SETUP_KEY = 'pu_single_setup'
function PlayerSetupScreen({ game, onStart, onBack, myName, settings, setSettings, auth, onAvatarClick, picker, setPicker, haptic, ownedPacks = [], onBuyVibe, onVibeBurst }) {
  const PLACEHOLDER_ME = 'Вы'
  const cleanReal = (s) => {
    const x = sanitizeName(s || '', 32)
    return x === PLACEHOLDER_ME ? '' : x
  }
  // Сохранённый сетап с прошлой сессии: имена/количество. Вайб берём из
  // глобального picker.vibe (общий источник для всех экранов).
  const savedSetup = (() => {
    try { return JSON.parse(localStorage.getItem(SINGLE_SETUP_KEY) || 'null') } catch { return null }
  })()
  const [names, setNames] = useState(() => {
    let initial = cleanReal(myName)
    if (!initial) {
      try { initial = cleanReal(localStorage.getItem('pu_my_name') || '') } catch {}
    }
    if (savedSetup?.names?.length >= 2) {
      // Если у юзера уже есть TG-имя — первым ставим его, иначе берём как было.
      return initial
        ? [initial, ...savedSetup.names.slice(1)]
        : savedSetup.names
    }
    return [initial || '', 'Игрок 2', 'Игрок 3']
  })
  const [showVibe, setShowVibe] = useState(false)
  // Поле 0 редактировано вручную?
  const firstEditedRef = useRef(false)
  useEffect(() => {
    const real = cleanReal(myName)
    if (!real || firstEditedRef.current) return
    setNames(n => (n[0] === real ? n : [real, ...n.slice(1)]))
  }, [myName])

  // Sanitize on-input. Пробелы между словами разрешены (sanitizeName схлопывает
  // повторные пробелы до одного и трим — это нужно, чтобы можно было ввести
  // «Имя Фамилия»). Опасные символы и управляющие — выпиливаются.
  const updateName = (i, val) => {
    const cleaned = sanitizeName(val, 32)
    if (i === 0) firstEditedRef.current = true
    setNames(n => n.map((name, idx) => idx === i ? cleaned : name))
  }
  const addPlayer = () => {
    if (names.length >= 10) return
    setNames(n => [...n, `Игрок ${n.length + 1}`])
  }
  const removePlayer = (i) => {
    if (names.length <= 2) return
    setNames(n => n.filter((_, idx) => idx !== i))
  }

  // Финальная очистка перед стартом + защита от пустых имён + persist setup.
  const handleStart = (rawNames) => {
    const finalNames = rawNames.map((n, i) => {
      const s = sanitizeName(n, 32)
      return s || `Игрок ${i + 1}`
    })
    try {
      const myFinal = finalNames[0]
      if (myFinal) {
        localStorage.setItem('pu_my_name', myFinal)
        api.updateMe({ display_name: myFinal }).catch(() => {})
      }
      localStorage.setItem(SINGLE_SETUP_KEY, JSON.stringify({ names: finalNames }))
    } catch {}
    onStart(finalNames, 'one_phone')
  }

  const vibe = VIBES.find(v => v.id === picker?.vibe) || VIBES[0]

  return (
    <div>
      <p className="eyebrow"><Users size={13}/> Локальная игра</p>
      <h2 style={{marginBottom:6}}>Кто играет?</h2>
      <p className="lead" style={{marginBottom:14}}>{game.title} · передаём телефон по кругу</p>

      <div className="setup-player-list">
        {names.map((name, i) => (
          <div key={i} className="setup-player-row">
            {i === 0 && avatarUrl(auth) ? (
              <button type="button" className="setup-player-emoji setup-player-avatar"
                onClick={() => onAvatarClick?.()} aria-label="Открыть профиль">
                <img src={avatarUrl(auth)} alt="" referrerPolicy="no-referrer"/>
              </button>
            ) : (
              <div className="setup-player-emoji">{EMOJIS[i % EMOJIS.length]}</div>
            )}
            <input
              className="setup-player-input"
              value={name}
              onChange={e => updateName(i, e.target.value)}
              placeholder={i === 0 ? 'Ваше имя' : `Игрок ${i + 1}`}
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

      {/* Вайб (открывает тот же модал что в bottom-nav) и кол-во карточек. */}
      <div className="setup-axis-card" style={{marginTop: 18}}>
        <button className="setup-axis-row" onClick={() => setShowVibe(true)}>
          <div className="setup-axis-key"><VibeIcon vibeId={vibe.id} size={16}/> Вайб</div>
          <div className="setup-axis-val">{vibe.label} <ChevronRight size={14}/></div>
        </button>
      </div>

      {setSettings && (
        <CardCountSelector
          game={game}
          settings={settings}
          setSettings={setSettings}
          style={{ marginTop: 14 }}
        />
      )}

      <button className="btn-primary mt-20" onClick={() => handleStart(names)}>
        <Play size={17}/> Начать игру
      </button>
      <button className="btn-ghost mt-12" style={{width:'100%',justifyContent:'center'}} onClick={onBack}>
        <ArrowLeft size={15}/> Назад
      </button>

      {showVibe && (
        <VibePickerModal
          currentVibe={picker?.vibe}
          ownedPacks={ownedPacks}
          onBuy={(v) => { setShowVibe(false); onBuyVibe?.(v) }}
          onPick={(v) => { setPicker(p => ({ ...p, vibe: v })); ev.vibeChange(v); setShowVibe(false); haptic?.('success'); onVibeBurst?.() }}
          onClose={() => setShowVibe(false)}
        />
      )}
    </div>
  )
}

/* ─── LobbyScreen ────────────────────────────────────────────────────────── */
// Лейбл «карточек/раундов/вопросов» в зависимости от типа игры.
function lobbyCountLabel(game) {
  const id = game?.id
  if (id === 'truth') return 'Карточек'
  if (id === 'would_rather') return 'Дилемм'
  if (['never','whoofus'].includes(id)) return 'Вопросов'
  if (['associations','five','alias','crocodile','whoami'].includes(id)) return 'Карточек'
  // (mafia/bunker/spy убраны)
  return 'Раундов'
}

function LobbyScreen({ game, players, room, settings, setSettings, showWarmupHint, onDismissHint, onStart, everyoneReady, onToggleReady, onAllReady, currentVibe, onChangeVibe, onChangeGame, haptic, isMultiplayer, isHost, roomId, onRoomPlayersUpdate, onGameStartedByHost, onRoomClosed, onLeaveLobby, onHostTransferred, auth, onPlayerAvatarClick, myId, ownedPacks = [], onBuyVibe, onVibeBurst }) {
  const [codeCopied, setCodeCopied] = useState(false)

  // Multiplayer polling in lobby — adaptive:
  // • visibility-gate (вкладка скрыта → пауза)
  // • если в комнате 1 игрок (тестируешь сам) — медленный heartbeat 8 c,
  //   иначе 3 c. Сразу же ускоряемся, когда кто-то заходит.
  // • If-None-Match: сервер вернёт 304 если ничего не менялось — экономит трафик.
  // Last seen serverRoom.state — нужно для детекции ТРАНЗИЦИИ lobby→playing.
  // Без этого, если хост уже стартовал, гость остался в лобби (нажав «В лобби»),
  // каждый poll бы заново выкидывал в раунд. Триггерим только при смене состояния.
  const lastServerStateRef = useRef(null)
  useEffect(() => {
    if (!isMultiplayer || !roomId) return
    let cancelled = false
    let timer = null
    let lastEtag = null
    const poll = async () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.hidden) { schedule(); return }
      try {
        const headers = { ...(lastEtag ? { 'If-None-Match': lastEtag } : {}), ...(myId ? { 'X-Player-Id': String(myId) } : {}) }
        const res = await fetch(`/api/room/${roomId}`, { headers })
        if (cancelled) return
        if (res.status === 304) { schedule(); return }
        if (!res.ok) { schedule(); return }
        const et = res.headers.get('etag'); if (et) lastEtag = et
        const serverRoom = await res.json()
        if (serverRoom.players && onRoomPlayersUpdate) onRoomPlayersUpdate(serverRoom)
        const prevState = lastServerStateRef.current
        lastServerStateRef.current = serverRoom.state
        // Хост сменил игру в лобби — гости подтянут (только если ещё не играем).
        if (serverRoom.gameId && serverRoom.gameId !== game.id && serverRoom.state === 'lobby' && onChangeGame) {
          onChangeGame(serverRoom.gameId)
        }
        // Хост поменял настройки (rounds/vibe) — гости подтягивают локально.
        if (serverRoom.settings && !isHost) {
          if (typeof serverRoom.settings.rounds === 'number' && serverRoom.settings.rounds !== settings?.rounds) {
            setSettings(s => ({ ...s, rounds: serverRoom.settings.rounds }))
          }
          if (serverRoom.settings.vibe && serverRoom.settings.vibe !== currentVibe && onChangeVibe) {
            onChangeVibe(serverRoom.settings.vibe)
          }
        }
        // Передача хоста (предыдущий хост вышел) — пересчёт isHost по hostId.
        if (serverRoom.hostId && myId && String(serverRoom.hostId) === String(myId) && !isHost) {
          onHostTransferred?.()
        }
        // Комната закрыта (последний игрок ушёл / хост закрыл) — уводим в меню.
        if (serverRoom.state === 'ended' && onRoomClosed) { onRoomClosed(); return }
        // Авто-переход в раунд — ТОЛЬКО при ТРАНЗИЦИИ (lobby→playing).
        // Без этого, если игрок вышел из ROUND в LOBBY вручную, его бы
        // каждый poll выкидывало обратно.
        if (serverRoom.state === 'playing' && prevState && prevState !== 'playing'
            && !isHost && onGameStartedByHost) {
          onGameStartedByHost()
        }
      } catch {}
      schedule()
    }
    const schedule = () => {
      if (cancelled) return
      const alone = (players?.length ?? 1) <= 1
      const delay = alone ? 8000 : 3000
      timer = setTimeout(poll, delay)
    }
    poll()
    const onVis = () => { if (!document.hidden) { if (timer) clearTimeout(timer); poll() } }
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVis) }
  }, [isMultiplayer, roomId, isHost, onRoomPlayersUpdate, onGameStartedByHost, onChangeGame, game.id, players?.length])

  const handleStartMultiplayer = () => {
    // startRound (в App) сам отправит deck + state='playing' в DO одним
    // запросом — это избегает гонки, при которой гости получают
    // state='playing' раньше чем deck.
    onStart()
  }

  // Хост: при изменении rounds/vibe пушим в DO. Debounce 500мс +
  // объединение rounds/vibe в один POST — на драг слайдера / быструю
  // перекрутку чипов вместо 5-10 запросов уходит ровно один.
  const settingsPushTimerRef = useRef(null)
  useEffect(() => {
    if (!isMultiplayer || !isHost || !roomId) return
    if (settingsPushTimerRef.current) clearTimeout(settingsPushTimerRef.current)
    settingsPushTimerRef.current = setTimeout(() => {
      const payload = { settings: { rounds: settings?.rounds, vibe: currentVibe } }
      fetch(`/api/room/${roomId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    }, 500)
    return () => { if (settingsPushTimerRef.current) clearTimeout(settingsPushTimerRef.current) }
  }, [isMultiplayer, isHost, roomId, settings?.rounds, currentVibe])

  // Выход из лобби: уведомляем DO, потом колбэк уведёт на главную "Играть".
  const handleLeave = async () => {
    if (isMultiplayer && roomId && myId) {
      try {
        await fetch(`/api/room/${roomId}/leave`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: myId }),
        })
      } catch {}
    }
    haptic?.('impact')
    onLeaveLobby?.()
  }

  const copyCode = () => {
    if (roomId) {
      navigator.clipboard?.writeText(roomId).catch(() => {})
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 2000)
      haptic?.('success')
    }
  }

  const inviteLink = async () => {
    if (!roomId) return
    const deeplink = miniAppLink(BOT_USERNAME, APP_SHORT_NAME, `room_${roomId}`)
    const text = `Присоединяйся к игре в PartyUp! 🎮 ${game.title} — комната ${roomId}`
    // Гость — копирует ссылку на комнату; залогиненный — нативный TG share.
    await doInviteShare({ deeplink, text, gameId: game.id, kind: 'room', evName: 'lobby_invite' })
  }

  // UI-state для модалок смены игры/вайба и инлайн-выбора кол-ва карточек.
  const [showGamePicker, setShowGamePicker] = useState(false)
  const [showVibe, setShowVibe] = useState(false)

  // В мультиплеере «Начать игру» доступна только хосту И при наличии минимум
  // одного гостя. Локальная игра — всегда доступна.
  const canStart = !isMultiplayer || (isHost && players.length >= 2)

  return (
    <div>
      {isMultiplayer && (
        <div className="screen-top-bar">
          <button className="screen-back-btn" onClick={handleLeave}
            aria-label="Выйти из лобби">
            <ArrowLeft size={16}/> Выйти из лобби
          </button>
        </div>
      )}
      {/* Шапка: «Онлайн-лобби» (mp) или «Локальная игра» */}
      <p className="eyebrow">
        {isMultiplayer
          ? <><Share2 size={13}/> Онлайн-лобби</>
          : <><Users size={13}/> Локальная игра</>}
      </p>
      <h2 style={{marginBottom: 6}}>
        {isMultiplayer
          ? (players.length < 2 ? 'Ожидание игроков' : 'Готовы начать!')
          : 'Готовы начать!'}
      </h2>

      {/* Карточка игры с кнопкой смены справа */}
      <div className="lobby-game-tag lobby-game-hero" style={{marginTop: 12}}>
        <div className="game-icon-token lobby-hero-icon">
          <GameIcon gameId={game.id} size={32} color="var(--accent-2)"/>
        </div>
        <div className="lobby-hero-text" style={{flex: 1}}>
          <div className="lobby-hero-title">{game.title}</div>
          <div className="lobby-hero-sub">{game.short}</div>
        </div>
        {(!isMultiplayer || isHost) && (
          <button
            type="button"
            className="lobby-change-game-btn"
            onClick={() => setShowGamePicker(true)}
            aria-label="Сменить игру"
          >
            <RotateCcw size={14}/> Сменить
          </button>
        )}
      </div>

      {/* Multiplayer: room code + invite (доступно всем участникам) */}
      {isMultiplayer && roomId && (
        <div className="mp-room-card">
          <div className="mp-room-label"><Share2 size={13}/> Код комнаты</div>
          <div className="mp-room-code mp-room-code-compact" onClick={copyCode} role="button" aria-label="Скопировать код">
            {roomId}
            <span className="mp-room-copy-icon">{codeCopied ? <Check size={14}/> : <Copy size={14}/>}</span>
          </div>
          <button className="btn-secondary mt-10" style={{width:'100%'}} onClick={inviteLink}>
            <Send size={15}/> Пригласить друзей
          </button>
        </div>
      )}

      {/* Players */}
      <p className="eyebrow" style={{marginBottom: 10}}><Users size={12}/> Игроки ({players.length})</p>
      <div className="player-list" role="list">
        {players.map(p => (
          <div key={p.id} className="player-row" role="listitem">
            <PlayerAvatar player={p} auth={auth} myId={myId} size={40} className="lobby-player-avatar"
              onClick={() => onPlayerAvatarClick?.(p)}/>
            <div style={{flex:1}}>
              <div className="player-name">{p.name}</div>
            </div>
            {(p.isHost || (room?.hostId && String(p.id) === String(room.hostId)))
              ? <span className="ready-badge host"><Crown size={11}/> Хост</span>
              : <span className="ready-badge yes"><Check size={12}/> Готов</span>}
          </div>
        ))}
      </div>

      {/* Inline: вайб + количество карточек — единый стиль, две строки одной карточкой. */}
      {(!isMultiplayer || isHost) ? (
        <div className="lobby-axis-stack">
          <div className="setup-axis-card">
            <button className="setup-axis-row" onClick={() => setShowVibe(true)}>
              <div className="setup-axis-key">
                <VibeIcon vibeId={currentVibe} size={16}/> Вайб
              </div>
              <div className="setup-axis-val">
                {VIBES.find(v => v.id === currentVibe)?.label || 'Разогрев'} <ChevronRight size={14}/>
              </div>
            </button>
          </div>
          <CardCountSelector game={game} settings={settings} setSettings={setSettings}/>
        </div>
      ) : (
        <div className="lobby-settings-card">
          <div className="lobby-settings-row">
            <span className="lobby-settings-key"><Dices size={12}/> {lobbyCountLabel(game)}</span>
            <span className="lobby-settings-val">{settings.rounds}</span>
          </div>
          <div className="lobby-settings-row">
            <span className="lobby-settings-key"><VibeIcon vibeId={currentVibe} size={12}/> Вайб</span>
            <span className="lobby-settings-val">{VIBES.find(v=>v.id===currentVibe)?.label || 'Разогрев'}</span>
          </div>
        </div>
      )}

      {/* Если игра уже идёт (state=playing) — приоритетная кнопка «Вернуться в игру»
          для всех. Это даёт гостю возможность снова войти после возврата в лобби. */}
      {isMultiplayer && room?.state === 'playing' ? (
        <button className="btn-primary mt-20" onClick={onStart}>
          <Play size={17}/> Вернуться в игру
        </button>
      ) : (!isMultiplayer || isHost) ? (
        <button
          className="btn-primary mt-20"
          disabled={!canStart}
          onClick={isMultiplayer ? handleStartMultiplayer : onStart}
          title={!canStart ? 'Подключите хотя бы одного игрока' : undefined}
        >
          <Play size={17}/> {canStart ? 'Начать игру' : 'Ждём минимум 1 игрока…'}
        </button>
      ) : (
        <button className="btn-primary mt-20" disabled aria-disabled="true">
          <Clock size={16}/> Ожидание лидера
        </button>
      )}

      {/* Модалки */}
      {showGamePicker && (
        <GamePickerModal
          currentId={game.id}
          onPick={(id) => {
            // Локально: меняем игру в App-level state. В mp: дополнительно посылаем gameId на сервер,
            // чтобы все игроки увидели смену.
            onChangeGame?.(id)
            setShowGamePicker(false)
          }}
          onClose={() => setShowGamePicker(false)}
        />
      )}
      {showVibe && (
        <VibePickerModal
          currentVibe={currentVibe}
          ownedPacks={ownedPacks}
          onBuy={(v) => { setShowVibe(false); onBuyVibe?.(v) }}
          onPick={(v) => { onChangeVibe(v); setShowVibe(false); haptic?.('success'); onVibeBurst?.() }}
          onClose={() => setShowVibe(false)}
        />
      )}
    </div>
  )
}

/* ─── GamePickerModal — компактная сетка простых игр, в один тап ────────── */
function GamePickerModal({ currentId, onPick, onClose }) {
  const items = GAMES.filter(g => g.simple)
  return (
    <div className="modal-backdrop welcome-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Сменить игру">
      <div className="welcome-modal vibe-picker-modal" onClick={e => e.stopPropagation()}>
        <p className="eyebrow" style={{justifyContent: 'center'}}><Dices size={13}/> Сменить игру</p>
        <h2 className="gradient-text" style={{textAlign: 'center', margin: '4px 0 14px'}}>Во что играем?</h2>
        <div className="vibe-picker-grid">
          {items.map(g => (
            <button
              key={g.id}
              className={`vibe-picker-tile ${g.id === currentId ? 'is-active' : ''}`}
              onClick={() => onPick(g.id)}
            >
              <span className="vibe-picker-icon"><GameIcon gameId={g.id} size={28} color="var(--accent-2)"/></span>
              <span className="vibe-picker-label">{g.title}</span>
              <span className="vibe-picker-hint">{g.short}</span>
              {g.id === currentId && <Check size={14} className="vibe-picker-check"/>}
            </button>
          ))}
        </div>
        <button className="btn-ghost" style={{width: '100%', justifyContent: 'center', marginTop: 18}} onClick={onClose}>
          <X size={15}/> Закрыть
        </button>
      </div>
    </div>
  )
}

/* ─── Shared Round Utilities ─────────────────────────────────────────────── */
// Универсальная аватарка игрока: TG-фото если игрок — это сам залогиненный юзер,
// иначе эмодзи. При клике — в профиль (либо переход на чужой TG-аккаунт).
function PlayerAvatar({ player, auth, onClick, className = '', size = 56, myId = null }) {
  // «Свой» игрок определяется ТРЕМЯ способами (в порядке надёжности):
  //   1) Прямое совпадение по myId (player.id === myId) — самый точный,
  //      потому что myId выставлен в App при createLobby/auth.
  //   2) Совпадение по tg-id (для мультиплеера/синхронизации с сервером).
  //   3) В локальной игре — host = я (т.к. добавленных игроков нет в TG).
  const myTgId = (auth?.mode === 'telegram')
    ? (auth?.tgUser?.id ?? auth?.user?.tg_id ?? null)
    : null
  const isMeById = myId && player?.id && String(player.id) === String(myId)
  const isMeByTg = !!myTgId && (
    (player?.telegramId != null && player.telegramId === myTgId) ||
    (player?.userId != null && player.userId === myTgId) ||
    (player?.id && String(player.id) === `tg_${myTgId}`)
  )
  const isMe = isMeById || isMeByTg
  // Фото показываем ВСЕМ, у кого оно есть на сервере (player.photo_url).
  // Если это я и сервер ещё не успел синкнуть — fallback на свой auth.
  const photo = player?.photo_url || (isMe ? avatarUrl(auth) : null)
  return (
    <button
      type="button"
      className={`active-player-emoji ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      onClick={onClick}
      aria-label={`Профиль ${player?.name || 'игрока'}`}
    >
      {photo
        ? <img src={photo} alt="" referrerPolicy="no-referrer"/>
        : <span>{player?.emoji || '🎮'}</span>}
    </button>
  )
}

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

function NextRoundBtn({ roundIndex, total, onNext, onEnd, isMultiplayer, isHost }) {
  const isLast = roundIndex >= total - 1
  // In multiplayer, only host can advance; non-host players see a waiting message
  if (isMultiplayer && !isHost) {
    return (
      <div className="mp-waiting-hint mt-16">
        <Clock size={13}/> Ждём следующий раунд от хоста…
      </div>
    )
  }
  return (
    <button className="btn-primary no-pulse mt-16" onClick={isLast ? onEnd : onNext}>
      {isLast ? <><Trophy size={17}/> Итоги</> : <><ChevronRight size={17}/> Следующий</>}
    </button>
  )
}

/* ─── RoundScreen dispatcher ─────────────────────────────────────────────── */
function RoundScreen({ game, round, roundIndex, total, players, scores, recordRoundScore, recordActiveMs, onNext, onEnd, haptic, isMultiplayer, isHost, roomId, onRoundSync, onGameEnded, auth, onAvatarClick, roomRoundState, onRoundStateSync, myId, onExitGame, onForceLobby }) {
  // Мультиплеер-поллинг (адаптивный):
  // • если игрок в комнате один — поллинг не нужен (некому что-то менять);
  // • вкладка скрыта — пауза;
  // • If-None-Match → 304 без тела, если ничего не менялось;
  // • при сетевой смене раунда — сразу же делаем ещё один poll, не ждём интервал.
  useEffect(() => {
    if (!isMultiplayer || !roomId) return
    if ((players?.length ?? 1) <= 1) return // соло-тест: не дёргаем DO вообще
    let cancelled = false
    let timer = null
    let lastSig = ''
    let lastEtag = null
    const poll = async () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.hidden) { schedule(); return }
      try {
        const headers = { ...(lastEtag ? { 'If-None-Match': lastEtag } : {}), ...(myId ? { 'X-Player-Id': String(myId) } : {}) }
        const res = await fetch(`/api/room/${roomId}`, { headers })
        if (cancelled) return
        if (res.status === 304) { schedule(); return }
        if (!res.ok) { schedule(); return }
        const et = res.headers.get('etag'); if (et) lastEtag = et
        const serverRoom = await res.json()
        if (serverRoom.state === 'ended') { onGameEnded?.(); return }
        if (serverRoom.roundIndex > roundIndex) { onRoundSync?.(serverRoom.roundIndex); return }
        if (serverRoom.roundIndex < roundIndex) { schedule(); return }
        // Хост принудительно вернул всех в лобби (кнопка "Завершить игру").
        if (serverRoom.state === 'lobby' && onForceLobby) { onForceLobby(); return }
        // Селективная сигнатура (дешевле, чем JSON.stringify) — учитывает
        // только релевантные поля. Для голосовалок берём количество ответов
        // (нам важно что кто-то добавился, а не точная разница).
        const r = serverRoom.round
        const sig = r
          ? `${r.choice||''}|${r.pickedAt||0}|${r.phase||''}|${r.startedAt||0}|${r.wordIdx||0}|${(r.score?.correct||0)+(r.score?.skipped||0)}|${Object.keys(r.votes||{}).length}|${Object.keys(r.answers||{}).length}`
          : 'null'
        if (sig !== lastSig) { lastSig = sig; onRoundStateSync?.(r || null) }
      } catch {}
      schedule()
    }
    const schedule = () => {
      if (cancelled) return
      timer = setTimeout(poll, 2000) // 2 c когда играем вдвоём+, в 2 раза реже чем было
    }
    poll()
    const onVis = () => { if (!document.hidden) { if (timer) clearTimeout(timer); poll() } }
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVis) }
  }, [isMultiplayer, roomId, roundIndex, onRoundSync, onGameEnded, onForceLobby, onRoundStateSync, players?.length])

  const props = { game, round, roundIndex, total, players, scores, recordRoundScore, recordActiveMs, onNext, onEnd, haptic, isMultiplayer, isHost, auth, onAvatarClick, roomId, roomRoundState, onRoundStateSync, myId }
  // Универсальная кнопка завершения игры. В мультиплеере ОБЯЗАТЕЛЬНО завершает
  // игру для ВСЕХ (DO state='lobby', roundIndex=0, round=null), чтобы не было
  // рассинхрона между игроками. В одиночной игре — выход в меню.
  const exitBar = onExitGame ? (
    <div className="screen-top-bar">
      <button className="screen-back-btn" onClick={onExitGame} aria-label="Завершить игру">
        <ArrowLeft size={16}/> Завершить игру
      </button>
    </div>
  ) : null
  let inner
  switch (game.roundType) {
    case 'truth_dare':   inner = <TruthOrDareRound {...props} />; break
    case 'never_have_i': inner = <NeverHaveIRound {...props} />; break
    case 'who_of_us':    inner = <WhoOfUsRound {...props} />; break
    case 'most_likely':  inner = <MostLikelyRound {...props} />; break
    case 'five_seconds': inner = <FiveSecondsRound {...props} />; break
    // spy/mafia/bunker удалены
    case 'alias':        inner = <AliasRound {...props} />; break
    case 'who_am_i':     inner = <WhoAmIRound {...props} />; break
    case 'fact_guess':   inner = <FactGuessRound {...props} />; break
    case 'meme_battle':  inner = <MemeBattleRound {...props} />; break
    case 'crocodile':    inner = <CrocodileRound {...props} />; break
    case 'taboo':        inner = <TabooRound {...props} />; break
    case 'hot_seat':     inner = <HotSeatRound {...props} />; break
    case 'associations': inner = <AssociationsRound {...props} />; break
    case 'would_rather': inner = <WouldRatherRound {...props} />; break
    default:             inner = <GenericRound {...props} />
  }
  return (
    <div>
      {exitBar}
      {inner}
    </div>
  )
}

/* ─── TruthOrDareRound ───────────────────────────────────────────────────── */
function TruthOrDareRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic, auth, onAvatarClick, isMultiplayer, isHost, roomId, roomRoundState, onRoundStateSync, recordActiveMs, myId }) {
  const activePlayer = players[roundIndex % players.length]

  // ── Определяем «мой ход» (multi-source проверка) ──
  // 1) по myId (стабильный локальный идентификатор игрока)
  // 2) по telegramId/userId (если apparent совпадение по TG-аккаунту)
  const myTgId = (auth?.mode === 'telegram') ? (auth?.tgUser?.id ?? auth?.user?.tg_id ?? null) : null
  const isMyTurn = useMemo(() => {
    if (!isMultiplayer) return true
    if (myId && activePlayer?.id && String(activePlayer.id) === String(myId)) return true
    if (myTgId != null && (
      activePlayer?.telegramId === myTgId || activePlayer?.userId === myTgId
    )) return true
    return false
  }, [isMultiplayer, myId, myTgId, activePlayer?.id, activePlayer?.telegramId, activePlayer?.userId])

  const vibeFiltered = useMemo(
    () => filterPromptsByVibe(game.samplePrompts, round.vibe || 'warmup'),
    [game.samplePrompts, round.vibe]
  )
  const truthPrompts = vibeFiltered.filter(p => p.type === 'Правда')
  const darePrompts = vibeFiltered.filter(p => p.type === 'Действие')

  // ── State ──
  // localChoice/localPrompt — single-player only.
  // В мультиплеере источник истины = roomRoundState (приходит из сервера/оптимистично).
  const [localChoice, setLocalChoice] = useState(null)
  const [localPrompt, setLocalPrompt] = useState(null)
  // Блокировка повторных нажатий пока идёт сетевой запрос.
  const [busy, setBusy] = useState(false)

  const choice = isMultiplayer ? (roomRoundState?.choice || null) : localChoice
  const shownPrompt = isMultiplayer
    ? (roomRoundState?.choice ? { type: roomRoundState.promptType, text: roomRoundState.promptText } : null)
    : localPrompt

  // Сбрасываем локальное состояние при смене раунда (важно для одноплеера и как safety-net).
  useEffect(() => {
    setLocalChoice(null); setLocalPrompt(null); setBusy(false)
  }, [roundIndex])

  // Замер времени активного хода.
  const turnStartRef = useRef(Date.now())
  useEffect(() => { turnStartRef.current = Date.now() }, [roundIndex])

  // Shuffled bags по типам — отдаём карточку без повторов, пока не пройдёт весь
  // пул; затем перемешиваем заново. Сбрасываем при смене вайба.
  const bagsRef = useRef({ truth: [], dare: [], vibeKey: '' })
  const drawFromBag = (type) => {
    const pool = type === 'truth' ? truthPrompts : darePrompts
    if (!pool.length) return null
    const vibeKey = `${round.vibe || 'warmup'}|${pool.length}`
    if (bagsRef.current.vibeKey !== vibeKey) {
      bagsRef.current = { truth: [], dare: [], vibeKey }
    }
    let bag = bagsRef.current[type]
    if (!bag || bag.length === 0) {
      bag = pool.map((_, i) => i)
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]]
      }
      bagsRef.current[type] = bag
    }
    return pool[bag.pop()]
  }

  // ── Выбор Правда/Действие ──
  const pick = async (type) => {
    if (!isMyTurn || busy || choice) return
    const pool = type === 'truth' ? truthPrompts : darePrompts
    if (!pool.length) return
    const p = drawFromBag(type) || pool[Math.floor(Math.random() * pool.length)]
    haptic('impact')
    if (isMultiplayer && roomId) {
      const optimistic = {
        choice: type,
        promptType: p?.type || (type === 'truth' ? 'Правда' : 'Действие'),
        promptText: p?.text || '',
        pickedBy: activePlayer.id,
        pickedAt: Date.now(),
      }
      // Моментальный локальный отклик — карточка появляется сразу.
      onRoundStateSync?.(optimistic)
      setBusy(true)
      try { await api.roomAction(roomId, { round: optimistic }) } catch {}
      setBusy(false)
    } else {
      setLocalChoice(type); setLocalPrompt(p)
    }
  }

  // ── Завершение хода (следующий раунд) ──
  // Оптимизация: один POST вместо двух (раньше handleNext посылал
  // {playerTime, round:null} + позже nextRound посылал {roundIndex}). Теперь
  // вкладываем roundIndex прямо сюда → DO сам сбросит round при смене idx.
  const handleNext = async () => {
    if (!isMyTurn || busy) return
    const ms = Math.max(0, Date.now() - (turnStartRef.current || Date.now()))
    if (isMultiplayer && roomId && activePlayer?.id) {
      setBusy(true)
      onRoundStateSync?.(null)
      try {
        const nextIdx = roundIndex + 1
        const isLast = nextIdx >= total
        await api.roomAction(roomId, {
          playerTime: { playerId: activePlayer.id, ms },
          ...(isLast ? {} : { roundIndex: nextIdx }),
        })
      } catch {}
      // App.nextRound выставит локальный setRoundIndex и навигирует на RESULTS если последний.
      onNext()
      setBusy(false)
      return
    }
    if (recordActiveMs && activePlayer?.id) recordActiveMs(activePlayer.id, ms)
    setLocalChoice(null); setLocalPrompt(null)
    onNext()
  }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <PlayerAvatar player={activePlayer} auth={auth} myId={myId} size={64}
          onClick={() => onAvatarClick?.(activePlayer)}/>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">{isMyTurn ? 'твой ход' : 'сейчас ходит'}</div>
        </div>
      </div>

      {!choice ? (
        <div className="td-choice-grid">
          <button
            type="button"
            className={`td-choice-btn td-truth ${!isMyTurn ? 'is-locked' : ''}`}
            disabled={!isMyTurn || busy}
            aria-disabled={!isMyTurn || busy}
            onClick={() => pick('truth')}>
            <Target size={32}/>
            <span>Правда</span>
            <span className="td-choice-hint">{isMyTurn ? 'Честный ответ' : 'Ждём ход'}</span>
          </button>
          <button
            type="button"
            className={`td-choice-btn td-dare ${!isMyTurn ? 'is-locked' : ''}`}
            disabled={!isMyTurn || busy}
            aria-disabled={!isMyTurn || busy}
            onClick={() => pick('dare')}>
            <Flame size={32}/>
            <span>Действие</span>
            <span className="td-choice-hint">{isMyTurn ? 'Задание' : 'Ждём ход'}</span>
          </button>
        </div>
      ) : (
        <div className="prompt-card prompt-card-reveal" style={{textAlign:'center'}}>
          <div className="prompt-type"><Sparkles size={12}/> {shownPrompt?.type}</div>
          <div className="prompt-text">{shownPrompt?.text}</div>
        </div>
      )}

      {choice && isMyTurn && (
        <button
          type="button"
          className="btn-primary no-pulse mt-16"
          disabled={busy}
          onClick={roundIndex >= total - 1 ? onEnd : handleNext}>
          {roundIndex >= total - 1
            ? <><Trophy size={17}/> Итоги</>
            : <><ChevronRight size={17}/> Следующий</>}
        </button>
      )}
      {choice && !isMyTurn && (
        <div className="mp-waiting-hint" style={{marginTop: 16}}>
          <Clock size={14}/> Ждём «Следующий» от {activePlayer.name}
        </div>
      )}
    </div>
  )
}

/* ─── NeverHaveIRound ──────────────────────────────────────────────────────
   - Локальная игра (один телефон): хост помечает за всех нажатиями на имена.
   - Мультиплеер: КАЖДЫЙ игрок голосует своим телефоном — «Было» / «Не было».
     Голоса сохраняются в room.round.votes, после голосования всех — реалтайм
     раскрытие. Хост (или любой клиент с активным ходом) жмёт «Следующий».
*/
function NeverHaveIRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic, isMultiplayer, isHost, roomId, roomRoundState, onRoundStateSync, myId }) {
  // ── Локальная ветка (single device) ───────────────────────────────────
  if (!isMultiplayer) {
    return <NeverHaveILocal game={game} round={round} roundIndex={roundIndex}
      total={total} players={players} onNext={onNext} onEnd={onEnd} haptic={haptic}/>
  }
  // ── Мультиплеер ───────────────────────────────────────────────────────
  const votes = roomRoundState?.votes || {}
  const myVote = myId ? votes[myId] : null
  const everyoneVoted = players.length > 0 && players.every(p => votes[p.id])
  const counts = {
    yes: Object.values(votes).filter(v => v === 'yes').length,
    no:  Object.values(votes).filter(v => v === 'no').length,
  }

  const submitVote = async (val) => {
    if (myVote || !myId) return
    haptic('impact')
    const next = { votes: { ...votes, [myId]: val }, pickedAt: Date.now() }
    onRoundStateSync?.(next) // optimistic local
    if (roomId) {
      try {
        await fetch(`/api/room/${roomId}/action`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ round: next }),
        })
      } catch {}
    }
  }

  const handleNext = async () => {
    // Сохраняем фин-результаты раунда (для общей статистики "Я никогда не").
    try {
      const prev = JSON.parse(localStorage.getItem('pu_never_stats') || '{}')
      for (const p of players) {
        const v = votes[p.id]
        if (!v) continue
        prev[p.id] = prev[p.id] || { yes: 0, no: 0, name: p.name }
        prev[p.id][v] += 1
        prev[p.id].name = p.name // обновляем имя
      }
      localStorage.setItem('pu_never_stats', JSON.stringify(prev))
    } catch {}
    onRoundStateSync?.(null) // очищаем перед следующим
    onNext()
  }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="prompt-card">
        <div className="prompt-type"><Sparkles size={12}/> Я никогда не…</div>
        <div className="prompt-text">…{round.promptText}</div>
      </div>

      {/* Моя кнопка голосования */}
      {!everyoneVoted && (
        <div className="never-vote-block">
          {myVote
            ? <div className="never-vote-done">
                Твой голос: <b>{myVote === 'yes' ? 'Было' : 'Не было'}</b>. Ждём остальных…
              </div>
            : <>
                <div className="never-vote-label">Твой ответ:</div>
                <div className="never-vote-row">
                  <button className="never-vote-btn never-vote-yes" onClick={() => submitVote('yes')}>
                    🙋 Было
                  </button>
                  <button className="never-vote-btn never-vote-no" onClick={() => submitVote('no')}>
                    🙅 Не было
                  </button>
                </div>
              </>
          }
          <div className="never-progress">
            {Object.keys(votes).length} из {players.length} проголосовали
          </div>
        </div>
      )}

      {/* После голосования всех — раскрытие */}
      {everyoneVoted && (
        <div className="never-reveal-block">
          <div className="never-reveal-summary">
            🙋 Было: <b>{counts.yes}</b> · 🙅 Не было: <b>{counts.no}</b>
          </div>
          <div className="never-reveal-list">
            {players.map(p => {
              const v = votes[p.id]
              return (
                <div key={p.id} className={`never-reveal-row ${v === 'yes' ? 'is-yes' : 'is-no'}`}>
                  <span className="never-player-emoji">{p.emoji}</span>
                  <span className="never-player-name">{p.name}</span>
                  <span className="never-reveal-vote">
                    {v === 'yes' ? '🙋 Было' : '🙅 Не было'}
                  </span>
                </div>
              )
            })}
          </div>
          {(isHost || players.length === 1) ? (
            <button className="btn-primary no-pulse mt-16"
              onClick={roundIndex >= total - 1 ? onEnd : handleNext}>
              {roundIndex >= total - 1 ? <><Trophy size={17}/> Итоги</> : <><ChevronRight size={17}/> Следующий</>}
            </button>
          ) : (
            <div className="mp-waiting-hint mt-16">
              <Clock size={14}/> Ждём «Следующий» от хоста
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Старая локальная версия — извлечена в отдельный компонент.
function NeverHaveILocal({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
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
        <div className="prompt-player" style={{marginTop:12}}>Признайтесь, если делали это:</div>
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
/* ─── VoteRound — single-player вариант (для local mode) ───────────────── */
function VoteRoundLocal({ game, round, roundIndex, total, players, onNext, onEnd, haptic, auth, onAvatarClick, myId }) {
  const [picked, setPicked] = useState(null)

  const vote = (targetId) => {
    haptic('impact')
    setPicked(targetId)
    // Аккумулируем для финальных ачивок
    try {
      const k = 'pu_whoofus_stats'
      const prev = JSON.parse(localStorage.getItem(k) || '{}')
      prev[targetId] = (prev[targetId] || 0) + 1
      localStorage.setItem(k, JSON.stringify(prev))
    } catch {}
  }

  const handleNext = () => { setPicked(null); onNext() }
  const winner = picked ? players.find(p => p.id === picked) : null

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="prompt-card">
        <div className="prompt-type"><Sparkles size={12}/> {round.promptType}</div>
        <div className="prompt-text">{round.promptText}</div>
      </div>

      <p className="eyebrow" style={{margin:'16px 0 10px'}}><Users size={12}/> Кто это?</p>
      <div className="player-vote-list">
        {players.map(p => {
          const isPicked = picked === p.id
          return (
            <button key={p.id}
              className={`player-vote-card ${isPicked ? 'is-picked' : ''} ${picked && !isPicked ? 'is-faded' : ''}`}
              onClick={() => !picked && vote(p.id)}
              disabled={!!picked}>
              <PlayerAvatar player={p} auth={auth} myId={myId} size={40}
                onClick={(e) => { e?.stopPropagation?.(); onAvatarClick?.(p) }}/>
              <span className="player-vote-name">{p.name}</span>
              {isPicked && <CircleCheck size={20} className="player-vote-check"/>}
            </button>
          )
        })}
      </div>

      {picked && winner && (
        <>
          <div className="vote-result-card">
            <div className="vote-result-label">Большинство за:</div>
            <div className="vote-result-winner">
              <PlayerAvatar player={winner} auth={auth} myId={myId} size={36}/>
              <strong>{winner.name}</strong>
            </div>
          </div>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── VoteRound — multiplayer (каждый голосует своим телефоном) ────────── */
function VoteRoundMP({ game, round, roundIndex, total, players, onNext, onEnd, haptic, auth, onAvatarClick, isHost, roomId, roomRoundState, onRoundStateSync, myId }) {
  const votes = roomRoundState?.votes || {}
  const myVote = myId ? votes[myId] : null
  const everyoneVoted = players.length > 0 && players.every(p => votes[p.id])

  // Подсчёт голосов на каждого игрока
  const counts = players.reduce((acc, p) => {
    acc[p.id] = Object.values(votes).filter(v => v === p.id).length
    return acc
  }, {})
  const maxVotes = Math.max(0, ...Object.values(counts))
  const winners = players.filter(p => counts[p.id] === maxVotes && maxVotes > 0)

  const submitVote = async (targetId) => {
    if (myVote || !myId) return
    haptic('impact')
    const next = { votes: { ...votes, [myId]: targetId }, pickedAt: Date.now() }
    onRoundStateSync?.(next)
    if (roomId) {
      try {
        await fetch(`/api/room/${roomId}/action`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ round: next }),
        })
      } catch {}
    }
  }

  const handleNext = async () => {
    // Накопим финальные ачивки: за кого голосовали — получает «балл узнаваемости»
    try {
      const k = 'pu_whoofus_stats'
      const prev = JSON.parse(localStorage.getItem(k) || '{}')
      for (const v of Object.values(votes)) {
        if (!v) continue
        prev[v] = (prev[v] || 0) + 1
      }
      localStorage.setItem(k, JSON.stringify(prev))
    } catch {}
    onRoundStateSync?.(null)
    onNext()
  }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="prompt-card">
        <div className="prompt-type"><Sparkles size={12}/> {round.promptType}</div>
        <div className="prompt-text">{round.promptText}</div>
      </div>

      {!everyoneVoted ? (
        <>
          <p className="eyebrow" style={{margin:'16px 0 10px'}}>
            <Users size={12}/>
            {myVote ? 'Твой голос засчитан · ждём остальных' : 'Кто это, по-твоему?'}
          </p>
          <div className="player-vote-list">
            {players.map(p => {
              const isMyChoice = myVote === p.id
              const hasVoted = !!votes[p.id]
              return (
                <button key={p.id}
                  className={`player-vote-card ${isMyChoice ? 'is-picked' : ''} ${myVote && !isMyChoice ? 'is-faded' : ''}`}
                  onClick={() => submitVote(p.id)}
                  disabled={!!myVote}>
                  <PlayerAvatar player={p} auth={auth} myId={myId} size={40}
                    onClick={(e) => { e?.stopPropagation?.(); onAvatarClick?.(p) }}/>
                  <span className="player-vote-name">{p.name}</span>
                  {hasVoted && <span className="player-vote-status" title="Уже проголосовал">✓</span>}
                  {isMyChoice && <CircleCheck size={20} className="player-vote-check"/>}
                </button>
              )
            })}
          </div>
          <div className="never-progress" style={{marginTop:14, textAlign:'center'}}>
            {Object.keys(votes).length} из {players.length} проголосовали
          </div>
        </>
      ) : (
        <>
          <div className="vote-result-card">
            <div className="vote-result-label">
              {winners.length === 1 ? 'Большинство за:' : `Ничья (${maxVotes} голос${maxVotes === 1 ? '' : 'а'} у каждого):`}
            </div>
            <div className="vote-winners-list">
              {winners.map(w => (
                <div key={w.id} className="vote-winner-row">
                  <PlayerAvatar player={w} auth={auth} myId={myId} size={48}/>
                  <strong>{w.name}</strong>
                  <span className="vote-winner-count">{counts[w.id]} голос{counts[w.id] === 1 ? '' : counts[w.id] < 5 ? 'а' : 'ов'}</span>
                </div>
              ))}
            </div>
            <div className="vote-detail-list">
              {players.map(p => (
                <div key={p.id} className="vote-detail-row">
                  <span className="vote-detail-from">{p.name}</span>
                  <ArrowLeft size={11} style={{transform:'rotate(180deg)'}}/>
                  <span className="vote-detail-to">{players.find(t => t.id === votes[p.id])?.name || '—'}</span>
                </div>
              ))}
            </div>
          </div>
          {(isHost || players.length === 1) ? (
            <button className="btn-primary no-pulse mt-16"
              onClick={roundIndex >= total - 1 ? onEnd : handleNext}>
              {roundIndex >= total - 1 ? <><Trophy size={17}/> Итоги</> : <><ChevronRight size={17}/> Следующий</>}
            </button>
          ) : (
            <div className="mp-waiting-hint mt-16">
              <Clock size={14}/> Ждём «Следующий» от хоста
            </div>
          )}
        </>
      )}
    </div>
  )
}

function WhoOfUsRound(props) {
  return props.isMultiplayer
    ? <VoteRoundMP {...props} />
    : <VoteRoundLocal {...props} />
}
function MostLikelyRound(props) { return <VoteRoundLocal {...props} /> }

/* ─── FiveSecondsRound ───────────────────────────────────────────────────── */
function FiveSecondsRound({ game, round, roundIndex, total, players, recordRoundScore, onNext, onEnd, haptic, isMultiplayer, isHost, roomId, roomRoundState, onRoundStateSync, myId }) {
  const activePlayer = players[roundIndex % players.length]
  // ── В мультиплеере таймер синхронизирован через DO: активный игрок
  //    жмёт «Поехали» → publish startedAt → все клиенты считают локально
  //    от этого момента; «Успел/Не успел» тоже доступно только активному.
  // ── В одиночном — обычный локальный flow.
  const isMyTurn = !isMultiplayer || (myId && String(activePlayer.id) === String(myId))

  // MP: phase/startedAt берутся из roomRoundState; local: useState
  const mpPhase = roomRoundState?.phase || 'ready'
  const mpStartedAt = roomRoundState?.startedAt || 0
  const mpResult = roomRoundState?.result || null
  const [localPhase, setLocalPhase] = useState('ready')
  const [localStartedAt, setLocalStartedAt] = useState(0)
  const [localResult, setLocalResult] = useState(null)
  const phase = isMultiplayer ? mpPhase : localPhase
  const startedAt = isMultiplayer ? mpStartedAt : localStartedAt
  const result = isMultiplayer ? mpResult : localResult

  // Синхронный отсчёт: оставшиеся секунды считаются от startedAt у каждого клиента.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (phase !== 'countdown' || !startedAt) return
    const t = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(t)
  }, [phase, startedAt])
  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0
  const count = Math.max(0, Math.ceil(5 - elapsed))

  // Авто-переход countdown → done когда время вышло
  useEffect(() => {
    if (phase !== 'countdown' || !startedAt) return
    if (elapsed >= 5) {
      if (isMultiplayer && isMyTurn && roomId) {
        const next = { phase: 'done', startedAt }
        onRoundStateSync?.(next)
        fetch(`/api/room/${roomId}/action`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ round: next }),
        }).catch(() => {})
      } else if (!isMultiplayer) {
        setLocalPhase('done')
      }
      haptic?.('success')
    }
  }, [elapsed, phase, startedAt, isMultiplayer, isMyTurn, roomId, onRoundStateSync, haptic])

  const start = () => {
    haptic('impact')
    const ts = Date.now()
    if (isMultiplayer && isMyTurn && roomId) {
      const next = { phase: 'countdown', startedAt: ts }
      onRoundStateSync?.(next)
      fetch(`/api/room/${roomId}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ round: next }),
      }).catch(() => {})
    } else {
      setLocalStartedAt(ts); setLocalPhase('countdown')
    }
  }

  const recordResult = (success) => {
    // Записываем в локальный per-game-аккумулятор для ачивок
    try {
      const k = 'pu_five_stats'
      const prev = JSON.parse(localStorage.getItem(k) || '{}')
      prev[activePlayer.id] = prev[activePlayer.id] || { success: 0, fail: 0 }
      if (success) prev[activePlayer.id].success += 1
      else prev[activePlayer.id].fail += 1
      localStorage.setItem(k, JSON.stringify(prev))
    } catch {}
  }

  const handleSuccess = async () => {
    haptic('success')
    recordRoundScore?.({ [activePlayer.id]: 1 })
    recordResult(true)
    if (isMultiplayer && roomId) {
      onRoundStateSync?.(null)
      try { await fetch(`/api/room/${roomId}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ round: null }),
      }) } catch {}
    } else {
      setLocalPhase('ready'); setLocalStartedAt(0); setLocalResult(null)
    }
    onNext()
  }
  const handleFail = async () => {
    haptic('impact')
    recordResult(false)
    if (isMultiplayer && roomId) {
      onRoundStateSync?.(null)
      try { await fetch(`/api/room/${roomId}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ round: null }),
      }) } catch {}
    } else {
      setLocalPhase('ready'); setLocalStartedAt(0); setLocalResult(null)
    }
    onNext()
  }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <PlayerAvatar player={activePlayer} auth={null} myId={myId} size={48}/>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">{isMyTurn ? 'твой ход' : 'отвечает'}</div>
        </div>
      </div>

      <div className="prompt-card">
        <div className="prompt-type"><Timer size={12}/> 5 секунд</div>
        <div className="prompt-text">{round.promptText}</div>
      </div>

      {phase === 'ready' && isMyTurn && (
        <button className="btn-primary mt-16" onClick={start}><Play size={17}/> Поехали!</button>
      )}
      {phase === 'ready' && !isMyTurn && (
        <div className="mp-waiting-hint mt-16">
          <Clock size={14}/> Ждём «Поехали» от {activePlayer.name}
        </div>
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
            <Timer size={20}/> Время вышло!
          </div>
          <p style={{textAlign:'center', color:'var(--muted)', fontSize:13, marginTop:8, marginBottom:4}}>
            {activePlayer.name} успел назвать три?
          </p>
          {isMyTurn ? (
            <div className="five-result-btns">
              <button className="five-btn-success" onClick={handleSuccess}>
                <Check size={20}/> Успел!
              </button>
              <button className="five-btn-fail" onClick={handleFail}>
                <X size={20}/> Не успел
              </button>
            </div>
          ) : (
            <div className="mp-waiting-hint mt-16">
              <Clock size={14}/> {activePlayer.name} оценивает результат…
            </div>
          )}
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
function AliasRound({ game, round, roundIndex, total, players, recordRoundScore, onNext, onEnd, haptic, isMultiplayer, isHost, roomId, roomRoundState, onRoundStateSync, myId, auth }) {
  // Один игрок объясняет слова из deck — остальные угадывают вслух.
  // В MP активный игрок (по индексу) видит слова и кнопки «Угадали / Пропустить»,
  // таймер синхронен. Очки идут в личный счёт активного игрока.
  const activePlayer = players[roundIndex % players.length]
  const isExplainer = !isMultiplayer || (myId && String(activePlayer.id) === String(myId))
  const words = game.samplePrompts || []

  const mpPhase = roomRoundState?.phase || 'ready'
  const mpStartedAt = roomRoundState?.startedAt || 0
  const mpWordIdx = roomRoundState?.wordIdx || 0
  const mpScore = roomRoundState?.score || { correct: 0, skipped: 0 }
  const [localPhase, setLocalPhase] = useState('ready')
  const [localStartedAt, setLocalStartedAt] = useState(0)
  const [localWordIdx, setLocalWordIdx] = useState(0)
  const [localScore, setLocalScore] = useState({ correct: 0, skipped: 0 })
  // Локальный буфер прироста для batch'инга (только в MP). На каждое
  // нажатие "Угадали/Пропустить" обновляем буфер мгновенно — отображение
  // плавное; в DO отсылаем agg раз в N (debounce) ИЛИ принудительно в
  // done/handleNext. До этого момента счёт у остальных может отставать
  // на ~500 мс — это ОК для "Элиаса", где счётчик не критичен.
  const [localBufScore, setLocalBufScore] = useState({ correct: 0, skipped: 0 })
  const [localBufWordIdx, setLocalBufWordIdx] = useState(0)
  const aliasFlushTimer = useRef(null)
  const phase = isMultiplayer ? mpPhase : localPhase
  const startedAt = isMultiplayer ? mpStartedAt : localStartedAt
  // wordIdx + score берём из локального буфера у объясняющего (мгновенный отклик),
  // у остальных — из mpScore/mpWordIdx (что приехало с сервера).
  const wordIdx = isMultiplayer
    ? (isExplainer ? Math.max(mpWordIdx, localBufWordIdx) : mpWordIdx)
    : localWordIdx
  const score = isMultiplayer
    ? (isExplainer
        ? { correct: Math.max(mpScore.correct, localBufScore.correct),
            skipped: Math.max(mpScore.skipped, localBufScore.skipped) }
        : mpScore)
    : localScore

  const ROUND_SEC = 60
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (phase !== 'playing' || !startedAt) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [phase, startedAt])
  const elapsed = startedAt ? (now - startedAt) / 1000 : 0
  const timeLeft = Math.max(0, Math.ceil(ROUND_SEC - elapsed))

  const syncState = async (patch) => {
    if (!isMultiplayer || !roomId) return
    const next = { phase, startedAt, wordIdx, score, ...patch }
    onRoundStateSync?.(next)
    try { await fetch(`/api/room/${roomId}/action`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ round: next }) }) } catch {}
  }

  // Сбросить буфер на сервер (вызывается debounce'нуто и принудительно).
  const flushAliasBuf = async () => {
    if (!isMultiplayer || !isExplainer || !roomId) return
    if (localBufScore.correct === 0 && localBufScore.skipped === 0 && localBufWordIdx === 0) return
    const merged = {
      correct: Math.max(mpScore.correct, localBufScore.correct),
      skipped: Math.max(mpScore.skipped, localBufScore.skipped),
    }
    const ni = Math.max(mpWordIdx, localBufWordIdx)
    setLocalBufScore({ correct: 0, skipped: 0 }); setLocalBufWordIdx(0)
    await syncState({ score: merged, wordIdx: ni })
  }

  // Авто-переход playing → done. При переходе обязательно flush'им буфер.
  useEffect(() => {
    if (phase !== 'playing' || !startedAt) return
    if (elapsed >= ROUND_SEC) {
      if (isMultiplayer && isExplainer) {
        // Финальный flush — гарантия что результат раунда не теряется.
        if (aliasFlushTimer.current) { clearTimeout(aliasFlushTimer.current); aliasFlushTimer.current = null }
        flushAliasBuf().then(() => syncState({ phase: 'done' }))
      } else if (!isMultiplayer) setLocalPhase('done')
      haptic?.('success')
    }
  }, [elapsed, phase, startedAt, isMultiplayer, isExplainer]) // eslint-disable-line

  // Cleanup при размонтировании — гарантия flush'а если игрок свернул.
  useEffect(() => {
    return () => {
      if (aliasFlushTimer.current) { clearTimeout(aliasFlushTimer.current); flushAliasBuf().catch(() => {}) }
    }
  }, []) // eslint-disable-line

  const startGame = async () => {
    const ts = Date.now()
    if (isMultiplayer && isExplainer) {
      await syncState({ phase: 'playing', startedAt: ts, wordIdx: 0, score: { correct: 0, skipped: 0 } })
    } else if (!isMultiplayer) {
      setLocalPhase('playing'); setLocalStartedAt(ts); setLocalWordIdx(0); setLocalScore({ correct: 0, skipped: 0 })
    }
  }
  // Локально мгновенно обновляем буфер; debounce flush в DO раз в 1.2 с —
  // вместо 5-10 POST'ов за 60-сек раунд получаем 1-2 batch'а + финальный.
  const scheduleAliasFlush = () => {
    if (aliasFlushTimer.current) clearTimeout(aliasFlushTimer.current)
    aliasFlushTimer.current = setTimeout(() => { flushAliasBuf().catch(() => {}) }, 1200)
  }
  const correct = () => {
    haptic('impact')
    const ni = Math.min(wordIdx + 1, Math.max(0, words.length - 1))
    if (isMultiplayer && isExplainer) {
      setLocalBufScore(b => ({ correct: (b.correct||0) + 1, skipped: b.skipped||0 }))
      setLocalBufWordIdx(ni)
      scheduleAliasFlush()
    } else if (!isMultiplayer) {
      setLocalScore(s => ({ correct: s.correct + 1, skipped: s.skipped }))
      setLocalWordIdx(ni)
    }
  }
  const skip = () => {
    const ni = Math.min(wordIdx + 1, Math.max(0, words.length - 1))
    if (isMultiplayer && isExplainer) {
      setLocalBufScore(b => ({ correct: b.correct||0, skipped: (b.skipped||0) + 1 }))
      setLocalBufWordIdx(ni)
      scheduleAliasFlush()
    } else if (!isMultiplayer) {
      setLocalScore(s => ({ correct: s.correct, skipped: s.skipped + 1 }))
      setLocalWordIdx(ni)
    }
  }

  const handleNext = async () => {
    if (score.correct > 0) recordRoundScore?.({ [activePlayer.id]: score.correct })
    if (isMultiplayer && roomId) {
      onRoundStateSync?.(null)
      try { await fetch(`/api/room/${roomId}/action`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ round: null }) }) } catch {}
    } else {
      setLocalPhase('ready'); setLocalScore({ correct: 0, skipped: 0 }); setLocalWordIdx(0)
    }
    onNext()
  }
  const urgentTime = timeLeft <= 10

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <PlayerAvatar player={activePlayer} auth={auth} myId={myId} size={48}/>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">{isExplainer ? 'твой ход — объясняй' : 'объясняет'}</div>
        </div>
      </div>

      {phase === 'ready' && isExplainer && (
        <>
          <div className="alias-rules-card">
            <p className="eyebrow"><MessageCircle size={12}/> Правила</p>
            <p style={{fontSize:14,color:'var(--muted)',marginTop:8,lineHeight:1.6}}>
              Объясняй слова за 60 секунд.<br/>
              Нельзя называть однокоренные слова.<br/>
              Остальные угадывают вслух.
            </p>
          </div>
          <button className="btn-primary mt-16" onClick={startGame}><Play size={17}/> Старт!</button>
        </>
      )}
      {phase === 'ready' && !isExplainer && (
        <div className="alias-rules-card">
          <p className="eyebrow"><MessageCircle size={12}/> Угадывайте</p>
          <p style={{fontSize:14,color:'var(--muted)',marginTop:8,lineHeight:1.6}}>
            {activePlayer.name} будет объяснять слова — угадывайте вслух.
          </p>
          <div className="mp-waiting-hint" style={{marginTop:12}}>
            <Clock size={14}/> Ждём «Старт» от {activePlayer.name}
          </div>
        </div>
      )}

      {phase === 'playing' && (
        <>
          <div className={`alias-timer ${urgentTime ? 'urgent' : ''}`}>{timeLeft}с</div>
          {isExplainer ? (
            <div className="alias-word-card" key={wordIdx}>
              <div className="alias-word">{words[wordIdx % words.length]?.text || '—'}</div>
            </div>
          ) : (
            <div className="alias-word-card">
              <div className="alias-word" style={{fontSize:48}}>🗣️</div>
              <div className="crocodile-hint">Угадывайте вслух!</div>
            </div>
          )}
          <div className="alias-score-row">
            <span className="alias-score-correct">✅ {score.correct}</span>
            <span className="alias-score-skipped">⏭️ {score.skipped}</span>
          </div>
          {isExplainer && (
            <div className="alias-action-row">
              <button className="alias-btn-correct" onClick={correct}><Check size={20}/> Угадали</button>
              <button className="alias-btn-skip" onClick={skip}><ChevronRight size={20}/> Пропустить</button>
            </div>
          )}
        </>
      )}

      {phase === 'done' && (
        <>
          <div className="alias-result-card">
            <div className="alias-result-score">{score.correct}</div>
            <div className="alias-result-label">слов угадано</div>
            {score.skipped > 0 && <div style={{fontSize:13,color:'var(--muted)',marginTop:4}}>пропущено: {score.skipped}</div>}
          </div>
          {(isExplainer || !isMultiplayer) ? (
            <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
          ) : (
            <div className="mp-waiting-hint mt-16">
              <Clock size={14}/> Ждём «Следующий» от {activePlayer.name}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ─── WhoAmIRound ────────────────────────────────────────────────────────── */
function WhoAmIRound({ game, round, roundIndex, total, players, recordRoundScore, onNext, onEnd, haptic, isMultiplayer, isHost, roomId, roomRoundState, onRoundStateSync, myId, auth }) {
  // Активный игрок (по очереди) — «загадан»: ОН НЕ должен видеть свой
  // персонаж, остальные видят и отвечают вслух «да/нет».
  // В MP это означает: на устройстве активного — поле для угадывания;
  // на остальных — карточка с персонажем.
  // В local (один телефон) — пасс-и-плей: показать персонажа всем, кроме
  // активного, потом передать телефон.
  const [phase, setPhase] = useState('setup') // 'setup' | 'playing' | 'guessed'
  const [qCount, setQCount] = useState(0)
  const [guessInput, setGuessInput] = useState('')
  const [wrongGuess, setWrongGuess] = useState(false)
  const [earnedPts, setEarnedPts] = useState(0)
  const activePlayer = players[roundIndex % players.length]
  const isMe = !!myId && String(activePlayer.id) === String(myId)
  const character = round.promptText
  // В MP мы пропускаем фазу 'setup' (нет необходимости передавать телефон) —
  // сразу 'playing'. Также активный игрок (isMe) НЕ должен видеть слово.
  const effectivePhase = isMultiplayer && phase === 'setup' ? 'playing' : phase

  const handleAnswer = (ans) => {
    haptic(ans === 'yes' ? 'impact' : 'selection')
    setQCount(c => c + 1)
  }

  const submitGuess = () => {
    const guess = guessInput.trim().toLowerCase()
    const target = character.toLowerCase()
    const correct = guess === target
      || target.includes(guess)
      || guess.includes(target.split(' ')[0])
    if (correct) {
      haptic('success')
      const pts = Math.max(1, 10 - Math.floor(qCount / 2))
      setEarnedPts(pts)
      recordRoundScore?.({ [activePlayer.id]: pts })
      setPhase('guessed')
    } else {
      haptic('error')
      setWrongGuess(true)
      setTimeout(() => setWrongGuess(false), 900)
    }
  }

  const handleGuessedManual = () => {
    haptic('success')
    recordRoundScore?.({ [activePlayer.id]: 1 })
    setEarnedPts(1)
    setPhase('guessed')
  }

  const handleNext = () => { setPhase('setup'); setQCount(0); setGuessInput(''); setEarnedPts(0); setWrongGuess(false); onNext() }

  // ── MP-ветка: спойлер-защита для активного + видимость персонажа другим ─
  if (isMultiplayer) {
    return (
      <div>
        <RoundHeader game={game} roundIndex={roundIndex} total={total} />
        <div className="active-player-banner">
          <PlayerAvatar player={activePlayer} auth={auth} myId={myId} size={48}/>
          <div>
            <div className="active-player-name">{activePlayer.name}</div>
            <div className="active-player-sub">{isMe ? 'твой ход — угадай!' : 'загадан'}</div>
          </div>
        </div>

        {effectivePhase !== 'guessed' && !isMe && (
          <div className="whoami-setup-card">
            <div className="prompt-type"><Search size={12}/> Персонаж у {activePlayer.name}</div>
            <div className="whoami-character">{character}</div>
            <p style={{fontSize:13,color:'var(--muted)',marginTop:12,lineHeight:1.55}}>
              {activePlayer.name} задаёт вопросы — отвечайте вслух «да» или «нет».
            </p>
          </div>
        )}

        {effectivePhase !== 'guessed' && isMe && (
          <>
            <div className="whoami-playing-banner" style={{marginTop:14}}>
              <div className="prompt-type"><Search size={12}/> Задай вопросы</div>
              <p style={{margin:'8px 0',color:'var(--muted)',fontSize:13,lineHeight:1.5}}>
                Узнай, кого тебе загадали. Спрашивай у группы — отвечают «да» или «нет».
              </p>
              <p style={{fontSize:13, fontWeight:600}}>Задано вопросов: {qCount}</p>
            </div>
            <div className="whoami-guess-row" style={{marginTop:14}}>
              <input
                className={`whoami-guess-input ${wrongGuess ? 'wrong' : ''}`}
                placeholder="Кого тебе загадали?"
                value={guessInput}
                onChange={e => setGuessInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submitGuess()}
                autoFocus
              />
              <button className="whoami-guess-btn" onClick={submitGuess} disabled={!guessInput.trim()}>
                <Check size={18}/>
              </button>
            </div>
            <button className="btn-ghost mt-12" style={{width:'100%',justifyContent:'center'}}
              onClick={() => { handleAnswer('yes'); }}>
              + Задал ещё вопрос
            </button>
          </>
        )}

        {effectivePhase === 'guessed' && (
          <>
            <div className="whoami-result-card">
              <div className="whoami-result-icon">🎉</div>
              <div className="whoami-result-title">Угадано!</div>
              <div className="whoami-result-character">{character}</div>
              <div className="whoami-result-pts">+{earnedPts} {earnedPts === 1 ? 'очко' : 'очка'} → {activePlayer.name}</div>
            </div>
            <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
          </>
        )}
      </div>
    )
  }
  // ── Local-ветка: pass-and-play (старая логика) ─────────────────────────

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

          <div className={`whoami-guess-row ${wrongGuess ? 'wrong-shake' : ''}`}>
            <input
              className="whoami-guess-input"
              placeholder="Введи догадку…"
              value={guessInput}
              onChange={e => setGuessInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitGuess()}
            />
            <button className="whoami-guess-btn" onClick={submitGuess} disabled={!guessInput.trim()}>
              <CircleCheck size={18}/>
            </button>
          </div>

          <button className="btn-ghost mt-10" style={{width:'100%',justifyContent:'center',fontSize:13}}
            onClick={handleGuessedManual}>
            <CircleCheck size={14}/> Угадал(а) устно — засчитать очко
          </button>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}

      {phase === 'guessed' && (
        <>
          <div className="whoami-guessed-card">
            <div className="whoami-guessed-icon">🎉</div>
            <div className="whoami-guessed-name">{character}</div>
            <div style={{fontSize:13,color:'var(--muted)',marginTop:6}}>
              За {qCount} вопросов · +{earnedPts} {earnedPts === 1 ? 'очко' : 'очков'}
            </div>
          </div>
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
/* ─── WouldRatherRound ─────────────────────────────────────────────────────
   Карточка с дилеммой А || Б. Игрок голосует, открывается статистика
   (% выборов на сервере), затем «Следующий» передаёт ход. */
function WouldRatherRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const activePlayer = players[roundIndex % players.length]
  const [picked, setPicked] = useState(null) // 'A' | 'B' | null
  const [stats, setStats] = useState(null)   // { a, b }
  const [voting, setVoting] = useState(false)

  // Reset on prompt change
  useEffect(() => { setPicked(null); setStats(null); setVoting(false) }, [round.id])

  // Parse "A||B" into two halves
  const raw = String(round.promptText || '')
  const sep = raw.includes('||') ? '||' : (raw.includes('|') ? '|' : '\n')
  const [optA, optB] = raw.split(sep).map(s => s.trim())
  const cardId = round.promptData?.id ?? null

  const vote = async (choice) => {
    if (picked || voting) return
    setPicked(choice); setVoting(true); haptic('impact')
    // Базовые цифры из карточки (если уже есть голоса) + наш голос локально
    const baseA = Number(round.promptData?.wr_a || 0)
    const baseB = Number(round.promptData?.wr_b || 0)
    let a = baseA + (choice === 'A' ? 1 : 0)
    let b = baseB + (choice === 'B' ? 1 : 0)
    if (cardId) {
      try {
        const r = await fetch('/api/wr/vote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card_id: cardId, choice }),
        })
        const d = await r.json().catch(() => ({}))
        if (r.ok && d?.ok) { a = Number(d.wr_a || a); b = Number(d.wr_b || b) }
      } catch {}
    }
    setStats({ a, b }); setVoting(false); haptic('success')
  }

  const handleNext = () => { setPicked(null); setStats(null); onNext() }

  const total_votes = stats ? (stats.a + stats.b) : 0
  const pctA = total_votes > 0 ? Math.round((stats.a / total_votes) * 100) : 0
  const pctB = total_votes > 0 ? 100 - pctA : 0

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <span className="active-player-emoji">{activePlayer.emoji}</span>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">что выберешь?</div>
        </div>
      </div>

      <div className="wr-wrap">
        <button
          className={`wr-card wr-a ${picked === 'A' ? 'wr-picked' : ''} ${picked && picked !== 'A' ? 'wr-faded' : ''}`}
          onClick={() => vote('A')} disabled={!!picked}
        >
          <div className="wr-letter">А</div>
          <div className="wr-text">{optA || '—'}</div>
          {stats && (
            <div className="wr-bar-wrap">
              <div className="wr-bar wr-bar-a" style={{ width: pctA + '%' }} />
              <span className="wr-pct">{pctA}%</span>
            </div>
          )}
        </button>

        <div className="wr-or">или</div>

        <button
          className={`wr-card wr-b ${picked === 'B' ? 'wr-picked' : ''} ${picked && picked !== 'B' ? 'wr-faded' : ''}`}
          onClick={() => vote('B')} disabled={!!picked}
        >
          <div className="wr-letter">Б</div>
          <div className="wr-text">{optB || '—'}</div>
          {stats && (
            <div className="wr-bar-wrap">
              <div className="wr-bar wr-bar-b" style={{ width: pctB + '%' }} />
              <span className="wr-pct">{pctB}%</span>
            </div>
          )}
        </button>
      </div>

      {stats && (
        <div className="wr-comment">
          {pctA === pctB
            ? <>🤝 Поровну. Кто-то должен объяснить свой выбор!</>
            : pctA > pctB
              ? <>🅰️ Большинство выбирает <b>А</b> ({pctA}%). Меньшинство — расскажите почему!</>
              : <>🅱️ Большинство выбирает <b>Б</b> ({pctB}%). Меньшинство — расскажите почему!</>
          }
        </div>
      )}

      {stats && (
        <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
      )}
    </div>
  )
}

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

/* ─── CrocodileRound ─────────────────────────────────────────────────────── */
function CrocodileRound({ game, round, roundIndex, total, players, recordRoundScore, onNext, onEnd, haptic, isMultiplayer, isHost, roomId, roomRoundState, onRoundStateSync, myId, auth }) {
  // Активный игрок показывает слово (видит его на своём экране), остальные
  // угадывают вслух. В MP — слово видит ТОЛЬКО активный игрок; остальные
  // видят таймер и подсказку «угадывайте вслух».
  const activePlayer = players[roundIndex % players.length]
  const isActor = !isMultiplayer || (myId && String(activePlayer.id) === String(myId))

  // MP-state: { phase, startedAt }
  const mpPhase = roomRoundState?.phase || 'ready'
  const mpStartedAt = roomRoundState?.startedAt || 0
  const [localPhase, setLocalPhase] = useState('ready')
  const [localStartedAt, setLocalStartedAt] = useState(0)
  const phase = isMultiplayer ? mpPhase : localPhase
  const startedAt = isMultiplayer ? mpStartedAt : localStartedAt
  const ROUND_SEC = 60

  // Синхронный таймер
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (phase !== 'playing' || !startedAt) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [phase, startedAt])
  const elapsed = startedAt ? (now - startedAt) / 1000 : 0
  const timeLeft = Math.max(0, Math.ceil(ROUND_SEC - elapsed))

  // Авто-переход в result когда время вышло
  useEffect(() => {
    if (phase !== 'playing' || !startedAt) return
    if (elapsed >= ROUND_SEC) {
      if (isMultiplayer && isActor && roomId) {
        const next = { phase: 'result', startedAt }
        onRoundStateSync?.(next)
        fetch(`/api/room/${roomId}/action`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ round: next }) }).catch(() => {})
      } else if (!isMultiplayer) {
        setLocalPhase('result')
      }
      haptic?.('success')
    }
  }, [elapsed, phase, startedAt, isMultiplayer, isActor, roomId, onRoundStateSync, haptic])

  const start = async () => {
    haptic('impact')
    const ts = Date.now()
    if (isMultiplayer && isActor && roomId) {
      const next = { phase: 'playing', startedAt: ts }
      onRoundStateSync?.(next)
      await fetch(`/api/room/${roomId}/action`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ round: next }) }).catch(() => {})
    } else {
      setLocalPhase('playing'); setLocalStartedAt(ts)
    }
  }

  const reset = async () => {
    if (isMultiplayer && roomId) {
      onRoundStateSync?.(null)
      try { await fetch(`/api/room/${roomId}/action`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ round: null }) }) } catch {}
    } else {
      setLocalPhase('ready'); setLocalStartedAt(0)
    }
  }

  const handleGuessed = async () => {
    haptic('success')
    recordRoundScore?.({ [activePlayer.id]: 2 })
    await reset(); onNext()
  }
  const handleMissed = async () => {
    haptic('impact')
    await reset(); onNext()
  }

  const urgentTime = timeLeft <= 10

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      <div className="active-player-banner">
        <PlayerAvatar player={activePlayer} auth={auth} myId={myId} size={48}/>
        <div>
          <div className="active-player-name">{activePlayer.name}</div>
          <div className="active-player-sub">{isActor ? 'твой ход — показывай' : 'показывает'}</div>
        </div>
      </div>

      {phase === 'ready' && isActor && (
        <>
          <div className="prompt-card" style={{textAlign:'center'}}>
            <div className="prompt-type"><Brain size={12}/> Слово для показа</div>
            <div className="prompt-text">{round.promptText}</div>
            <p style={{fontSize:13,color:'var(--muted)',marginTop:10,lineHeight:1.5}}>
              Только жесты и мимика — ни слова!<br/>Остальные угадывают.
            </p>
          </div>
          <button className="btn-primary mt-16" onClick={start}><Play size={17}/> Поехали! (60 сек)</button>
        </>
      )}
      {phase === 'ready' && !isActor && (
        <div className="prompt-card" style={{textAlign:'center'}}>
          <div className="prompt-type"><Brain size={12}/> Угадывайте</div>
          <p style={{margin:'10px 0',color:'var(--muted)'}}>
            {activePlayer.name} получит слово и будет показывать жестами.<br/>
            Угадывайте вслух — все вместе!
          </p>
          <div className="mp-waiting-hint">
            <Clock size={14}/> Ждём «Поехали» от {activePlayer.name}
          </div>
        </div>
      )}

      {phase === 'playing' && (
        <>
          <div className={`alias-timer ${urgentTime ? 'urgent' : ''}`}>{timeLeft}с</div>
          {isActor ? (
            <div className="crocodile-word-display">
              <div className="crocodile-word">{round.promptText}</div>
              <div className="crocodile-hint">Показывай, не говори!</div>
            </div>
          ) : (
            <div className="crocodile-word-display">
              <div className="crocodile-word" style={{fontSize:32}}>🎭</div>
              <div className="crocodile-hint">Угадывайте вслух — что показывает {activePlayer.name}?</div>
            </div>
          )}
        </>
      )}

      {phase === 'result' && (
        <>
          <div className="five-done-banner"><Timer size={20}/> Время вышло!</div>
          <p style={{textAlign:'center',color:'var(--muted)',fontSize:14,marginTop:8,marginBottom:4}}>
            Компания угадала «<strong>{round.promptText}</strong>»?
          </p>
          {isActor ? (
            <div className="five-result-btns">
              <button className="five-btn-success" onClick={handleGuessed}><Check size={20}/> Угадали!</button>
              <button className="five-btn-fail" onClick={handleMissed}><X size={20}/> Не угадали</button>
            </div>
          ) : (
            <div className="mp-waiting-hint mt-16">
              <Clock size={14}/> {activePlayer.name} оценивает результат…
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ─── TabooRound ─────────────────────────────────────────────────────────── */
function TabooRound({ game, round, roundIndex, total, players, recordRoundScore, onNext, onEnd, haptic }) {
  const [phase, setPhase] = useState('ready') // 'ready' | 'playing' | 'result'
  const [timeLeft, setTimeLeft] = useState(60)
  const [buzzerPressed, setBuzzerPressed] = useState(false)
  const activePlayer = players[roundIndex % players.length]
  const prompt = round.promptData
  const forbidden = prompt?.forbidden || []
  // Extract word from text (e.g. '☕ КОФЕ' → 'КОФЕ')
  const wordDisplay = prompt?.text || round.promptText

  useEffect(() => {
    if (phase !== 'playing') return
    if (timeLeft <= 0) { setPhase('result'); haptic('success'); return }
    const t = setTimeout(() => setTimeLeft(s => s - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, timeLeft, haptic])

  const start = () => { setPhase('playing'); setTimeLeft(60); setBuzzerPressed(false); haptic('impact') }

  const handleTaboo = () => {
    haptic('error')
    setBuzzerPressed(true)
    setPhase('result')
  }

  const handleGuessed = () => {
    haptic('success')
    recordRoundScore?.({ [activePlayer.id]: 2 })
    setPhase('ready'); setTimeLeft(60); setBuzzerPressed(false); onNext()
  }
  const handleMissed = () => {
    haptic('impact')
    setPhase('ready'); setTimeLeft(60); setBuzzerPressed(false); onNext()
  }

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
          <div className="taboo-card">
            <div className="taboo-word">{wordDisplay}</div>
            <div className="taboo-forbidden-label"><X size={12}/> Нельзя говорить:</div>
            <div className="taboo-forbidden-list">
              {forbidden.map((w, i) => (
                <span key={i} className="taboo-forbidden-chip">{w}</span>
              ))}
            </div>
          </div>
          <p style={{fontSize:13,color:'var(--muted)',textAlign:'center',marginTop:10,lineHeight:1.5}}>
            Объясни слово — не называя запрещённые слова.<br/>Остальные следят и жмут ТАБУ!
          </p>
          <button className="btn-primary mt-12" onClick={start}><Play size={17}/> Старт (60 сек)</button>
        </>
      )}

      {phase === 'playing' && (
        <>
          <div className={`alias-timer ${urgentTime ? 'urgent' : ''}`}>{timeLeft}с</div>
          <div className="taboo-card taboo-card-playing">
            <div className="taboo-word">{wordDisplay}</div>
            <div className="taboo-forbidden-label"><X size={12}/> Табу:</div>
            <div className="taboo-forbidden-list">
              {forbidden.map((w, i) => (
                <span key={i} className="taboo-forbidden-chip">{w}</span>
              ))}
            </div>
          </div>
          <button className="taboo-buzzer-btn" onClick={handleTaboo}>
            <Siren size={22}/> ТАБУ!
          </button>
        </>
      )}

      {phase === 'result' && (
        <>
          {buzzerPressed ? (
            <div className="taboo-buzzer-result">
              <div className="taboo-buzzer-icon">🚨</div>
              <div className="taboo-buzzer-title">ТАБУ сказано!</div>
              <div style={{fontSize:13,color:'var(--muted)',marginTop:4}}>Слово сгорело. Следующее!</div>
            </div>
          ) : (
            <div className="five-done-banner"><Timer size={20}/> Время вышло!</div>
          )}
          <p style={{textAlign:'center',color:'var(--muted)',fontSize:14,marginTop:12,marginBottom:4}}>
            Команда угадала слово?
          </p>
          <div className="five-result-btns">
            <button className="five-btn-success" onClick={handleGuessed}><Check size={20}/> Угадали!</button>
            <button className="five-btn-fail" onClick={handleMissed}><X size={20}/> {buzzerPressed ? 'Не успели' : 'Нет'}</button>
          </div>
        </>
      )}
    </div>
  )
}

/* ─── HotSeatRound ───────────────────────────────────────────────────────── */
function HotSeatRound({ game, round, roundIndex, total, players, onNext, onEnd, haptic }) {
  const [answered, setAnswered] = useState(false)
  const [reaction, setReaction] = useState(null)
  const activePlayer = players[roundIndex % players.length]

  const handleNext = () => { setAnswered(false); setReaction(null); onNext() }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />

      <div className="hot-seat-banner">
        <div className="hot-seat-fire" aria-hidden="true">🔥</div>
        <div className="hot-seat-player-row">
          <span className="hot-seat-emoji">{activePlayer.emoji}</span>
          <div>
            <div className="hot-seat-name">{activePlayer.name}</div>
            <div className="hot-seat-sub">на горячем стуле</div>
          </div>
        </div>
      </div>

      <div className="prompt-card">
        <div className="prompt-type"><Flame size={12}/> Вопрос</div>
        <div className="prompt-text">{round.promptText}</div>
      </div>

      {!answered ? (
        <button className="btn-primary mt-16" onClick={() => { setAnswered(true); haptic('impact') }}>
          <Check size={17}/> Ответил(а)!
        </button>
      ) : (
        <>
          <div className="reactions-row" role="group" aria-label="Реакции">
            {['🔥','😂','😳','💀','👏'].map(r => (
              <button key={r} className={`reaction-btn ${reaction === r ? 'tapped' : ''}`}
                onClick={() => { setReaction(r); haptic() }} aria-pressed={reaction === r}>{r}</button>
            ))}
          </div>
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── AssociationsRound ──────────────────────────────────────────────────── */
function AssociationsRound(props) {
  return props.isMultiplayer
    ? <AssociationsMP {...props} />
    : <AssociationsLocal {...props} />
}

/* ─── Associations — MP: каждый пишет свою ассоциацию на своём устройстве ─ */
function AssociationsMP({ game, round, roundIndex, total, players, recordRoundScore, onNext, onEnd, haptic, isHost, roomId, roomRoundState, onRoundStateSync, myId, auth, onAvatarClick }) {
  const answers = roomRoundState?.answers || {}
  const myAnswer = myId ? answers[myId] : null
  const everyoneSubmitted = players.length > 0 && players.every(p => answers[p.id])
  const [draft, setDraft] = useState('')

  const submit = async () => {
    const text = draft.trim()
    if (!text || myAnswer || !myId) return
    haptic('impact')
    const next = { answers: { ...answers, [myId]: text }, pickedAt: Date.now() }
    onRoundStateSync?.(next); setDraft('')
    if (roomId) {
      try { await fetch(`/api/room/${roomId}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ round: next }),
      }) } catch {}
    }
  }

  // При полном сборе ответов считаем совпадения для финального экрана + скоринг
  const matchGroups = everyoneSubmitted
    ? Object.values(answers).reduce((acc, v) => {
        const key = String(v || '').toLowerCase().trim()
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {})
    : {}
  const matchCount = Object.values(matchGroups).filter(c => c > 1).reduce((s, c) => s + c, 0)

  const handleNext = async () => {
    // Скоринг + ачивки: за каждое совпадение по +1 балл всем участникам группы
    const matchedScores = {}
    for (const p of players) {
      const a = String(answers[p.id] || '').toLowerCase().trim()
      if (a && matchGroups[a] > 1) {
        matchedScores[p.id] = matchGroups[a] - 1
      }
    }
    if (Object.keys(matchedScores).length) recordRoundScore?.(matchedScores)
    try {
      const k = 'pu_assoc_stats'
      const prev = JSON.parse(localStorage.getItem(k) || '{}')
      for (const [pid, pts] of Object.entries(matchedScores)) {
        prev[pid] = (prev[pid] || 0) + pts
      }
      localStorage.setItem(k, JSON.stringify(prev))
    } catch {}
    onRoundStateSync?.(null)
    onNext()
  }

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />
      {!everyoneSubmitted ? (
        <>
          <div className="assoc-trigger-card">
            <div className="prompt-type"><Sparkles size={12}/> Слово-триггер</div>
            <div className="assoc-word">{round.promptText}</div>
            <p style={{fontSize:13,color:'var(--muted)',marginTop:10,lineHeight:1.5}}>
              Напиши свою ассоциацию. За совпадение с другими игроками — +1 балл.
            </p>
          </div>
          {myAnswer ? (
            <div className="never-vote-done" style={{marginTop:14, textAlign:'center'}}>
              Твой ответ: <b>{myAnswer}</b>. Ждём остальных…
            </div>
          ) : (
            <div className="whoami-guess-row" style={{marginTop:14}}>
              <input
                className="whoami-guess-input"
                placeholder="Твоя ассоциация…"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()}
                autoFocus
                maxLength={40}
              />
              <button className="whoami-guess-btn" onClick={submit} disabled={!draft.trim()}>
                <Check size={18}/>
              </button>
            </div>
          )}
          <div className="never-progress" style={{marginTop:14, textAlign:'center'}}>
            {Object.keys(answers).length} из {players.length} ответили
          </div>
        </>
      ) : (
        <>
          <div className="assoc-trigger-card" style={{marginBottom:14}}>
            <div className="prompt-type"><Sparkles size={12}/> Слово-триггер</div>
            <div className="assoc-word" style={{fontSize:22}}>{round.promptText}</div>
          </div>
          <div className="assoc-reveal-list">
            {players.map(p => {
              const a = answers[p.id]
              const isMatch = a && matchGroups[a.toLowerCase().trim()] > 1
              return (
                <div key={p.id} className={`assoc-reveal-row ${isMatch ? 'is-match' : ''}`}>
                  <PlayerAvatar player={p} auth={auth} myId={myId} size={32}/>
                  <span className="assoc-player-name">{p.name}</span>
                  <span className="assoc-player-word">{a || '—'}</span>
                  {isMatch && <span className="assoc-match-badge">✓ Совпало!</span>}
                </div>
              )
            })}
          </div>
          {matchCount > 0 && (
            <div className="assoc-match-summary">
              🎯 {matchCount} ответ{matchCount === 1 ? '' : matchCount < 5 ? 'а' : 'ов'} в общую волну!
            </div>
          )}
          {(isHost || players.length === 1) ? (
            <button className="btn-primary no-pulse mt-16"
              onClick={roundIndex >= total - 1 ? onEnd : handleNext}>
              {roundIndex >= total - 1 ? <><Trophy size={17}/> Итоги</> : <><ChevronRight size={17}/> Следующий</>}
            </button>
          ) : (
            <div className="mp-waiting-hint mt-16">
              <Clock size={14}/> Ждём «Следующий» от хоста
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ─── Associations — Local: pass-and-play (старая логика) ─────────────── */
function AssociationsLocal({ game, round, roundIndex, total, players, recordRoundScore, onNext, onEnd, haptic, auth, myId }) {
  const [phase, setPhase] = useState('show') // 'show' | 'collect' | 'reveal'
  const [assocInputIdx, setAssocInputIdx] = useState(0)
  const [associations, setAssociations] = useState({}) // { playerId: string }
  const [currentInput, setCurrentInput] = useState('')

  const submitAssociation = () => {
    if (!currentInput.trim()) return
    const p = players[assocInputIdx]
    const updated = { ...associations, [p.id]: currentInput.trim() }
    setAssociations(updated)
    setCurrentInput('')
    if (assocInputIdx < players.length - 1) {
      setAssocInputIdx(i => i + 1)
    } else {
      // Подсчёт совпадений + аккумулирование ачивок
      const groups = {}
      for (const v of Object.values(updated)) {
        const k = String(v || '').toLowerCase().trim()
        groups[k] = (groups[k] || 0) + 1
      }
      const scores = {}
      for (const [pid, ans] of Object.entries(updated)) {
        const k = String(ans || '').toLowerCase().trim()
        if (groups[k] > 1) scores[pid] = groups[k] - 1
      }
      if (Object.keys(scores).length) recordRoundScore?.(scores)
      try {
        const sk = 'pu_assoc_stats'
        const prev = JSON.parse(localStorage.getItem(sk) || '{}')
        for (const [pid, pts] of Object.entries(scores)) {
          prev[pid] = (prev[pid] || 0) + pts
        }
        localStorage.setItem(sk, JSON.stringify(prev))
      } catch {}
      setPhase('reveal')
    }
    haptic('impact')
  }

  const handleNext = () => {
    setPhase('show'); setAssocInputIdx(0); setAssociations({}); setCurrentInput(''); onNext()
  }

  const currentInputPlayer = players[assocInputIdx]

  // Count matches
  const assocValues = Object.values(associations)
  const allSubmitted = Object.keys(associations).length >= players.length
  const matchGroups = allSubmitted
    ? assocValues.reduce((acc, v) => {
        const key = v.toLowerCase()
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {})
    : {}
  const matchCount = Object.values(matchGroups).filter(c => c > 1).reduce((s, c) => s + c, 0)

  return (
    <div>
      <RoundHeader game={game} roundIndex={roundIndex} total={total} />

      {phase === 'show' && (
        <>
          <div className="assoc-trigger-card">
            <div className="prompt-type"><Sparkles size={12}/> Слово-триггер</div>
            <div className="assoc-word">{round.promptText}</div>
            <p style={{fontSize:13,color:'var(--muted)',marginTop:10,lineHeight:1.5}}>
              Каждый по очереди называет одну ассоциацию.<br/>
              Совпали — оба получают очко!
            </p>
          </div>
          <button className="btn-primary mt-16" onClick={() => setPhase('collect')}>
            <Play size={17}/> Начать!
          </button>
        </>
      )}

      {phase === 'collect' && (
        <>
          <div className="assoc-trigger-card" style={{marginBottom:12}}>
            <div className="prompt-type"><Sparkles size={12}/> Слово-триггер</div>
            <div className="assoc-word" style={{fontSize:26}}>{round.promptText}</div>
          </div>

          <div className="active-player-banner">
            <span className="active-player-emoji">{currentInputPlayer.emoji}</span>
            <div>
              <div className="active-player-name">{currentInputPlayer.name}</div>
              <div className="active-player-sub">пишет ассоциацию</div>
            </div>
          </div>

          <div className="whoami-guess-row" style={{marginTop:12}}>
            <input
              className="whoami-guess-input"
              placeholder="Ассоциация…"
              value={currentInput}
              onChange={e => setCurrentInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitAssociation()}
              autoFocus
            />
            <button className="whoami-guess-btn" onClick={submitAssociation} disabled={!currentInput.trim()}>
              <Check size={18}/>
            </button>
          </div>

          <div className="fact-player-dots" style={{marginTop:12,justifyContent:'center'}}>
            {players.map((_, i) => (
              <div key={i} className={`fact-dot ${i < assocInputIdx ? 'done' : i === assocInputIdx ? 'current' : ''}`}/>
            ))}
          </div>
        </>
      )}

      {phase === 'reveal' && (
        <>
          <div className="assoc-trigger-card" style={{marginBottom:14}}>
            <div className="prompt-type"><Sparkles size={12}/> Слово-триггер</div>
            <div className="assoc-word" style={{fontSize:22}}>{round.promptText}</div>
          </div>
          <div className="assoc-reveal-list">
            {players.map(p => (
              <div key={p.id} className={`assoc-reveal-row ${matchGroups[associations[p.id]?.toLowerCase()] > 1 ? 'is-match' : ''}`}>
                <span className="assoc-player-emoji">{p.emoji}</span>
                <span className="assoc-player-name">{p.name}</span>
                <span className="assoc-player-word">{associations[p.id] || '—'}</span>
                {matchGroups[associations[p.id]?.toLowerCase()] > 1 && <span className="assoc-match-badge">✓ Совпало!</span>}
              </div>
            ))}
          </div>
          {matchCount > 0 && (
            <div className="assoc-match-summary">
              🎉 {matchCount} совпадений — молодцы!
            </div>
          )}
          <NextRoundBtn roundIndex={roundIndex} total={total} onNext={handleNext} onEnd={onEnd}/>
        </>
      )}
    </div>
  )
}

/* ─── JoinRoomScreen ─────────────────────────────────────────────────────── */
function JoinRoomScreen({ roomId, myPlayerId, onJoined, onBack, haptic, defaultName }) {
  // Имя берём по приоритету: TG-display / анон-ник > сохранённое > пусто.
  // 'Вы' считаем плейсхолдером (placeholder в инпуте), а не реальным именем.
  const PLACEHOLDER = 'Вы'
  const clean = (s) => {
    const x = sanitizeName(s || '', 32)
    return x === PLACEHOLDER ? '' : x
  }
  const initial = clean(defaultName) ||
                  clean((typeof window !== 'undefined' && localStorage.getItem('pu_my_name')) || '')
  const [name, setName] = useState(initial)
  const editedRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const autoJoinedRef = useRef(false)

  // При получении актуального defaultName — обновляем поле, если юзер не правил.
  useEffect(() => {
    const real = clean(defaultName)
    if (!real || editedRef.current) return
    setName(real)
  }, [defaultName])

  const performJoin = async (rawName) => {
    const cleaned = sanitizeName(rawName, 32)
    if (!cleaned) { setError('Введите имя'); return }
    setLoading(true)
    setError(null)
    try {
      const playerEmoji = ['🎉','🎮','🔥','✨','🌟','🎯','🦊','🎧'][Math.floor(Math.random() * 8)]
      try { localStorage.setItem('pu_my_name', cleaned) } catch {}
      const tgU = tgUser()
      const res = await fetch(`/api/room/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: myPlayerId, name: cleaned, emoji: playerEmoji,
          userId: tgU?.id || null, telegramId: tgU?.id || null,
          anonId: getAnonId() || null,
          photo_url: tgU?.photo_url || null, username: tgU?.username || null,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        setError(err.error === 'game_already_started' ? 'Игра уже началась' : 'Не удалось войти в комнату')
        setLoading(false)
        return
      }
      const room = await res.json()
      haptic?.('success')
      onJoined(room, cleaned)
    } catch (e) {
      setError('Ошибка подключения. Попробуй снова.')
      setLoading(false)
    }
  }

  const handleJoin = () => performJoin(name)

  // Авто-join: если имя уже известно (auth/localStorage) — заходим в лобби сразу.
  useEffect(() => {
    if (autoJoinedRef.current) return
    const ready = clean(defaultName) ||
                  clean((typeof window !== 'undefined' && localStorage.getItem('pu_my_name')) || '')
    if (ready) {
      autoJoinedRef.current = true
      performJoin(ready)
    }
  }, [defaultName]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <p className="eyebrow"><Share2 size={13}/> Мультиплеер</p>
      <h2 style={{marginBottom:6}}>Присоединиться</h2>
      <p className="lead" style={{marginBottom:20}}>Комната: <strong>{roomId}</strong></p>

      <div className="setup-player-list">
        <div className="setup-player-row">
          <div className="setup-player-emoji">🎮</div>
          <input
            className="setup-player-input"
            value={name}
            onChange={e => { editedRef.current = true; setName(sanitizeName(e.target.value, 32)) }}
            onKeyDown={e => e.key === 'Enter' && handleJoin()}
            placeholder="Ваше имя"
            maxLength={32}
            autoFocus={!name}
            disabled={loading}
          />
        </div>
      </div>

      {error && (
        <div className="mp-error-hint">
          <X size={14}/> {error}
        </div>
      )}

      <button className="btn-primary mt-16" onClick={handleJoin} disabled={loading || !name.trim()}>
        {loading ? 'Подключение…' : <><UserPlus size={17}/> Войти в комнату</>}
      </button>
      <button className="btn-ghost mt-12" style={{width:'100%',justifyContent:'center'}} onClick={onBack}>
        <ArrowLeft size={15}/> Назад
      </button>
    </div>
  )
}

/* ─── ResultsScreen ──────────────────────────────────────────────────────── */
// «Титулы» вместо победителя — для игр без явных очков (Truth, Hot Seat и т.п.).
// Считаем по активному времени и количеству ходов каждого игрока.
function TitlesBoard({ players, game }) {
  // Для «Я никогда не…» — рейтинг по числу признаний (нажатий «Было»).
  // Сверху больше всех, снизу — меньше. Для топ-3 — именованные ачивки.
  if (game?.id === 'never') {
    let stats = {}
    try { stats = JSON.parse(localStorage.getItem('pu_never_stats') || '{}') } catch {}
    const rows = players.map(p => ({
      ...p,
      yes: Number(stats[p.id]?.yes || 0),
      no:  Number(stats[p.id]?.no  || 0),
    }))
    const hasData = rows.some(r => r.yes + r.no > 0)
    if (hasData) {
      // Сортируем: больше «Было» → выше. При равенстве — больше «Не было» → ниже (более правильный игрок ниже).
      const sorted = [...rows].sort((a, b) => (b.yes - a.yes) || (a.no - b.no))
      const titles = [
        { icon: '🏆', name: 'Многое повидал', sub: 'Больше всех нажимал «Было»' },
        { icon: '🔥', name: 'Заводила вечера',  sub: 'Второе место по опыту' },
        { icon: '😎', name: 'Бывалый',          sub: 'Третье место по опыту' },
      ]
      return (
        <div className="titles-grid">
          {sorted.map((p, i) => {
            const t = titles[i]
            const sub = t ? t.sub : `Признаний: ${p.yes} · «не было»: ${p.no}`
            const name = t ? t.name : 'Достойный игрок'
            const icon = t ? t.icon : '✨'
            return (
              <div key={p.id} className="title-card">
                <div className="title-icon">{icon}</div>
                <div className="title-body">
                  <div className="title-name">{name}</div>
                  <div className="title-who">{p.emoji} {p.name}</div>
                  <div className="title-sub">{sub} · 🙋 {p.yes} · 🙅 {p.no}</div>
                </div>
              </div>
            )
          })}
        </div>
      )
    }
  }

  const withMs = players.map(p => ({
    ...p,
    activeMs: Number(p.activeMs || 0),
  }))
  const totalMs = withMs.reduce((s, p) => s + p.activeMs, 0)
  // Если активного времени совсем нет — fallback на «герои вечера» по индексам.
  if (totalMs === 0 || withMs.length === 0) {
    const labels = ['🎉 Герой вечера', '😂 Душа компании', '🎯 Главный участник']
    return (
      <div className="titles-grid">
        {withMs.slice(0, Math.min(3, withMs.length)).map((p, i) => (
          <div key={p.id} className="title-card">
            <div className="title-name">{p.emoji} {p.name}</div>
            <div className="title-line">{labels[i] || '✨ Игрок'}</div>
          </div>
        ))}
      </div>
    )
  }
  // Найдём носителей титулов
  const byTime = [...withMs].sort((a, b) => b.activeMs - a.activeMs)
  const slowest = byTime[0]                   // дольше всего отвечал
  const fastest = byTime[byTime.length - 1]   // самый быстрый
  // Средний хранитель (медиана) — «надёжный игрок»
  const median = byTime[Math.floor(byTime.length / 2)]

  const fmt = (ms) => {
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}с`
    const m = Math.floor(s / 60); const r = s % 60
    return r ? `${m}м ${r}с` : `${m}м`
  }
  const titles = []
  if (slowest && slowest.activeMs > 0) titles.push({
    icon: '🧠', name: 'Думатель', who: slowest, sub: `Дольше всех у руля — ${fmt(slowest.activeMs)}`,
  })
  if (fastest && fastest.activeMs > 0 && fastest.id !== slowest.id) titles.push({
    icon: '⚡', name: 'Молниеносный', who: fastest, sub: `Самые быстрые ходы — ${fmt(fastest.activeMs)}`,
  })
  if (median && median.id !== slowest.id && median.id !== fastest.id) titles.push({
    icon: '🎯', name: 'Стабильный', who: median, sub: `Уверенный темп всю игру`,
  })
  // Если игроков 2 — дополним «Герой вечера» от типа игры
  if (titles.length < 3 && withMs.length > 0) {
    const heroEmoji = game.id === 'truth' ? '🔥' : game.id === 'never' ? '🙅' : '🎉'
    titles.push({
      icon: heroEmoji, name: 'Герой вечера', who: byTime[0], sub: 'Душа компании',
    })
  }
  return (
    <div className="titles-grid">
      {titles.slice(0, 3).map((t, i) => (
        <div key={`${t.name}-${t.who.id}-${i}`} className="title-card">
          <div className="title-icon">{t.icon}</div>
          <div className="title-body">
            <div className="title-name">{t.name}</div>
            <div className="title-who">{t.who.emoji} {t.who.name}</div>
            <div className="title-sub">{t.sub}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ─── RatingList ────────────────────────────────────────────────────────
   Единый рейтинг 2-5 место на экране результатов. 1-е выводится в большой
   winner-card выше; здесь — последовательный список с per-place ачивками,
   очками и подписями. Источник «очков» меняется от игры: для truth/alias/
   crocodile/whoami/would_rather — это `scores`; для whoofus/never/five/
   associations берётся per-game stats из localStorage. */
const GAME_PLACE_TITLES = {
  // Каждый массив — 5 ачивок (1-е, 2-е, 3-е, 4-е, 5-е место).
  truth: [
    { medal: '🏆', title: 'Самый смелый', sub: 'Принял все вызовы вечера' },
    { medal: '🥈', title: 'Открытый',     sub: 'Без боязни признаний' },
    { medal: '🥉', title: 'Готов на всё', sub: 'Не отступал перед заданиями' },
    { medal: '🎯', title: 'Достойный собеседник', sub: 'Хорошо включился' },
    { medal: '✨', title: 'В игре',       sub: 'Часть весёлого вечера' },
  ],
  never: [
    { medal: '🏆', title: 'Многое повидал', sub: 'Больше всех нажимал «Было»' },
    { medal: '🥈', title: 'Заводила вечера', sub: 'Второе место по опыту' },
    { medal: '🥉', title: 'Бывалый',      sub: 'Опыт богатый' },
    { medal: '🎯', title: 'Знает жизнь',  sub: 'Достойный список приключений' },
    { medal: '✨', title: 'Был в теме',    sub: 'Часть огонька вечера' },
  ],
  whoofus: [
    { medal: '🏆', title: 'Звезда компании', sub: 'Большинство выбирало именно тебя' },
    { medal: '🥈', title: 'Душа компании', sub: 'Тебя замечают' },
    { medal: '🥉', title: 'Главное лицо', sub: 'В центре внимания' },
    { medal: '🎯', title: 'Заметный игрок', sub: 'Тебя помнят' },
    { medal: '✨', title: 'В кадре',       sub: 'Свой среди своих' },
  ],
  five: [
    { medal: '🏆', title: 'Молниеносный', sub: 'Без пауз и запинок' },
    { medal: '🥈', title: 'Чёткий ход',   sub: 'Почти не давал сбоев' },
    { medal: '🥉', title: 'Сообразительный', sub: 'Достойный темп' },
    { medal: '🎯', title: 'Стабильный',   sub: 'Уверенный результат' },
    { medal: '✨', title: 'В пятёрке',    sub: 'Не подвёл компанию' },
  ],
  associations: [
    { medal: '🏆', title: 'Думает как все', sub: 'Идеальное чувство компании' },
    { medal: '🥈', title: 'На общей волне', sub: 'Часто попадает в группу' },
    { medal: '🥉', title: 'Хорошо чувствует', sub: 'Совпадения не редкость' },
    { medal: '🎯', title: 'В команде',    sub: 'Свой ход мысли' },
    { medal: '✨', title: 'Часть потока', sub: 'Был на одной волне' },
  ],
  would_rather: [
    { medal: '🏆', title: 'Решительный',  sub: 'Выбирает уверенно' },
    { medal: '🥈', title: 'Без сомнений', sub: 'Знает, что хочет' },
    { medal: '🥉', title: 'Уверенный выбор', sub: 'Хорошие инстинкты' },
    { medal: '🎯', title: 'Свой вкус',    sub: 'Не идёт на поводу' },
    { medal: '✨', title: 'В игре',       sub: 'Часть жарких споров' },
  ],
  crocodile: [
    { medal: '🏆', title: 'Мастер пантомимы', sub: 'Слова угадываются мгновенно' },
    { medal: '🥈', title: 'Артистичный',   sub: 'Без слов всё понятно' },
    { medal: '🥉', title: 'Понятный',     sub: 'Жесты говорят сами' },
    { medal: '🎯', title: 'Старательный', sub: 'Не сдавался до конца' },
    { medal: '✨', title: 'В роли',        sub: 'Часть весёлого шоу' },
  ],
  alias: [
    { medal: '🏆', title: 'Король объяснений', sub: 'Слова летят как из автомата' },
    { medal: '🥈', title: 'Чёткий рассказчик', sub: 'Понятно и быстро' },
    { medal: '🥉', title: 'Хороший спикер', sub: 'Объяснил много' },
    { medal: '🎯', title: 'Понятный',     sub: 'Команда угадывала' },
    { medal: '✨', title: 'В команде',     sub: 'Внёс свой вклад' },
  ],
  whoami: [
    { medal: '🏆', title: 'Острый ум',    sub: 'Угадал быстрее всех' },
    { medal: '🥈', title: 'Умный сыщик',  sub: 'Грамотные вопросы' },
    { medal: '🥉', title: 'Догадливый',   sub: 'Хорошая интуиция' },
    { medal: '🎯', title: 'Любознательный', sub: 'Задавал много вопросов' },
    { medal: '✨', title: 'В деле',        sub: 'Не сдавался' },
  ],
}
const DEFAULT_PLACE_TITLES = [
  { medal: '🏆', title: 'Победитель',  sub: 'Главный герой вечера' },
  { medal: '🥈', title: 'Второе место', sub: 'Совсем рядом с первым' },
  { medal: '🥉', title: 'Третье место', sub: 'Достойный результат' },
  { medal: '🎯', title: 'В четвёрке',   sub: 'Хороший игрок' },
  { medal: '✨', title: 'В пятёрке',    sub: 'Часть компании' },
]

// Возвращает { value, unit } для каждой игры на основе нужного источника очков.
function computeGameRanking(players, scores, game) {
  const id = game?.id
  // Загружаем per-game stats для тех игр, где балл — не из scores.
  const loadStats = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} }
  }
  let rows = []
  let unit = 'оч.'
  if (id === 'whoofus') {
    const s = loadStats('pu_whoofus_stats')
    rows = players.map(p => ({ ...p, value: Number(s[p.id] || 0) }))
    unit = (n) => `${n} голос${n === 1 ? '' : n < 5 ? 'а' : 'ов'}`
  } else if (id === 'never') {
    const s = loadStats('pu_never_stats')
    rows = players.map(p => ({ ...p, value: Number(s[p.id]?.yes || 0) }))
    unit = (n) => `${n} призн.`
  } else if (id === 'five') {
    const s = loadStats('pu_five_stats')
    rows = players.map(p => ({ ...p, value: Number(s[p.id]?.success || 0), tieBreak: -Number(s[p.id]?.fail || 0) }))
    unit = (n) => `${n} удач`
  } else if (id === 'associations') {
    const s = loadStats('pu_assoc_stats')
    rows = players.map(p => ({ ...p, value: Number(s[p.id] || 0) }))
    unit = (n) => `${n} совп.`
  } else {
    rows = players.map(p => ({ ...p, value: Number(scores?.[p.id] || 0) }))
    unit = (n) => `${n} оч.`
  }
  rows.sort((a, b) => (b.value - a.value) || ((b.tieBreak||0) - (a.tieBreak||0)))
  return { rows, unit }
}

function RatingList({ players, scores, game, winnerId }) {
  const { rows, unit } = computeGameRanking(players, scores, game)
  // Кандидаты на места 2-5: всё после winnerId, фильтр value>0 опционален.
  const rest = rows.filter(r => String(r.id) !== String(winnerId)).slice(0, 4)
  if (!rest.length) return null
  const titles = GAME_PLACE_TITLES[game?.id] || DEFAULT_PLACE_TITLES
  const unitStr = (n) => typeof unit === 'function' ? unit(n) : `${n} ${unit}`
  return (
    <div className="rating-list" style={{marginTop: 16}}>
      <div className="rating-list-title">🏅 Рейтинг участников</div>
      <div className="rating-list-items">
        {rest.map((p, i) => {
          const place = i + 2 // начинаем со 2-го места
          const t = titles[place - 1] || titles[titles.length - 1]
          return (
            <div key={p.id} className={`rating-card rating-card-p${place}`}>
              <div className="rating-card-medal">{t.medal}<span className="rating-card-place">{place}</span></div>
              <PlayerAvatar player={p} auth={null} myId={null} size={48} className="rating-card-avatar"/>
              <div className="rating-card-body">
                <div className="rating-card-name">{p.name}</div>
                <div className="rating-card-title">{t.title}</div>
                <div className="rating-card-sub">{t.sub}</div>
              </div>
              <div className="rating-card-score">{unitStr(p.value)}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ResultsScreen({ game, players, scores, onAgain, onHome, onBackToLobby, isMultiplayer, isHost, roomId, onHostNavigated, myId }) {
  // Гости в мультиплеере поллят комнату медленно (3 c, с visibility-gate):
  // как только хост поменяет state на 'lobby' или 'playing' — навигатор
  // сам отправит гостей туда же, чтобы все были в одном месте.
  useEffect(() => {
    if (!isMultiplayer || isHost || !roomId || !onHostNavigated) return
    let cancelled = false, timer = null, lastEtag = null
    const poll = async () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.hidden) { schedule(); return }
      try {
        const headers = { ...(lastEtag ? { 'If-None-Match': lastEtag } : {}), ...(myId ? { 'X-Player-Id': String(myId) } : {}) }
        const res = await fetch(`/api/room/${roomId}`, { headers })
        if (cancelled) return
        if (res.status === 304) { schedule(); return }
        if (!res.ok) { schedule(); return }
        const et = res.headers.get('etag'); if (et) lastEtag = et
        const r = await res.json()
        if (r.state === 'lobby' || r.state === 'playing') { onHostNavigated(r.state); return }
      } catch {}
      schedule()
    }
    const schedule = () => { if (!cancelled) timer = setTimeout(poll, 3000) }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [isMultiplayer, isHost, roomId, onHostNavigated])

  const [shared, setShared] = useState(false)
  const hasScores = players.some(p => (scores[p.id] || 0) > 0)

  const ranked = useMemo(() =>
    [...players].sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0)),
    [players, scores]
  )

  const shareResultsToTelegram = useCallback(async () => {
    const lines = [`🎉 Итоги — ${game.title}`, '']
    const medals = ['🏆','🥈','🥉']
    ranked.forEach((p, i) => {
      const m = medals[i] || `${i+1}.`
      lines.push(`${m} ${p.name}${hasScores ? ` — ${scores[p.id]||0} оч.` : ''}`)
    })
    const deeplink = miniAppLink(BOT_USERNAME, APP_SHORT_NAME, `g_${game.id}`) || 'https://partyup-game.ru'
    lines.push('', `🎮 Сыграйте вместе: ${deeplink}`)
    const text = lines.join('\n')
    await doInviteShare({ deeplink, text, gameId: game.id, kind: 'results', evName: 'results' })
    setShared(true)
  }, [game, ranked, scores, hasScores])

const podiumMedals = ['🏆', '🥈', '🥉']
  const podiumLabels = ['Победитель', 'Второе место', 'Третье место']
  const top3 = ranked.slice(0, 3)

  // Игре-зависимый «титул» победителя: одна строчка, которая делает
  // карточку личной для каждой игры.
  const GAME_WINNER_TAGLINE = {
    truth:        { title: 'Самый смелый', sub: 'Принял все вызовы вечера' },
    never:        { title: 'Самая богатая жизнь', sub: 'Опыта — больше всех' },
    whoofus:      { title: 'Звезда компании', sub: 'Большинство выбирало именно тебя' },
    five:         { title: 'Самый быстрый ум', sub: 'Без пауз и запинок' },
    associations: { title: 'Думает как все', sub: 'Идеальное чувство компании' },
    would_rather: { title: 'Решительный', sub: 'Выбирает уверенно' },
  }
  const tagline = GAME_WINNER_TAGLINE[game.id] || { title: 'Главный герой вечера', sub: game.title }
  // Универсальный winner через computeGameRanking — корректно работает и для
  // игр без recordRoundScore (whoofus, never) через per-game stats из localStorage.
  const { rows: winnerRanked, unit: winnerUnit } = computeGameRanking(players, scores, game)
  const winner = winnerRanked[0] && winnerRanked[0].value > 0 ? winnerRanked[0] : ranked[0]
  const winnerValue = winner ? Number(winnerRanked.find(r => r.id === winner.id)?.value || 0) : 0
  const winnerUnitStr = typeof winnerUnit === 'function' ? winnerUnit(winnerValue) : `${winnerValue} ${winnerUnit}`

  return (
    <div className="results-v2">
      <div className="results-v2-eyebrow">
        <Trophy size={13}/> Игра завершена · {game.title}
      </div>

      {/* Социальная карточка победителя — это «трофей», на который хочется
          смотреть и которым хочется поделиться. */}
      {winner && (
        <div className="winner-card" data-vibe={winner.id}>
          <div className="winner-card-bg" aria-hidden="true"/>
          <div className="winner-card-confetti" aria-hidden="true">
            <span>🏆</span><span>✨</span><span>🎉</span><span>⭐</span><span>💫</span>
          </div>
          <div className="winner-card-content">
            <div className="winner-card-label">
              <Crown size={13}/> {tagline.title}
            </div>
            <div className="winner-avatar-wrap">
              <PlayerAvatar player={winner} auth={null} myId={null} size={96} className="winner-avatar"/>
            </div>
            <div className="winner-card-name">{winner.name}</div>
            <div className="winner-card-tagline">{tagline.sub}</div>
            {winnerValue > 0 && (
              <div className="winner-card-score">
                <span className="winner-card-score-n">{winnerValue}</span>
                <span className="winner-card-score-l">{winnerUnitStr.replace(String(winnerValue) + ' ', '')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Статистика "Я никогда не…" — кто сколько Было / Не было нажал */}
      {game.id === 'never' && (() => {
        let stats = {}
        try { stats = JSON.parse(localStorage.getItem('pu_never_stats') || '{}') } catch {}
        const rows = players.map(p => ({
          ...p,
          yes: Number(stats[p.id]?.yes || 0),
          no:  Number(stats[p.id]?.no  || 0),
        })).filter(r => r.yes + r.no > 0)
        if (!rows.length) return null
        rows.sort((a, b) => b.yes - a.yes)
        return (
          <div className="never-stats-card">
            <div className="never-stats-title">🙋 Кто что делал</div>
            <div className="never-stats-list">
              {rows.map(r => {
                const total = r.yes + r.no
                const pct = total ? Math.round((r.yes / total) * 100) : 0
                return (
                  <div key={r.id} className="never-stats-row">
                    <PlayerAvatar player={r} auth={null} myId={null} size={36} className="never-stats-avatar"/>
                    <div className="never-stats-info">
                      <div className="never-stats-name">{r.name}</div>
                      <div className="never-stats-bar"><div className="never-stats-fill" style={{width: pct + '%'}}/></div>
                    </div>
                    <div className="never-stats-counts">
                      <span title="Было">🙋 {r.yes}</span>
                      <span title="Не было">🙅 {r.no}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Whoofus / Five / Associations — единый RatingList ниже уже выводит
          места 2-5 с per-game ачивками. Отдельные стат-карточки удалены
          чтобы не дублировать. Для «Я никогда не» сохраняется отдельная
          карточка «🙋 Кто что делал» — она показывает балансы Было/Не было,
          это другая размерность данных. */}

      {/* Единый рейтинг 2-5 место. 1-е уже в большой winner-card сверху.
          Старые блоки (podium-row 2-3 и results-full-table) убраны — теперь
          один последовательный список с per-place ачивкой, очками и аватарами. */}
      <RatingList players={players} scores={scores} game={game} winnerId={winner?.id}/>

      {/* Share block — компактнее, в стилистике карточки */}
      <div className="share-card share-card-v2" style={{marginTop: 18}}>
        <p className="share-card-title">Сохранить результат 🎉</p>
        <p className="share-card-sub">Отправь в чат — пусть все завидуют</p>
        <button className="btn-primary no-pulse" onClick={shareResultsToTelegram} style={{opacity: shared ? 0.7 : 1}}>
          {shared ? <><Check size={17}/> Отправлено!</> : <><Send size={17}/> Поделиться в Telegram</>}
        </button>
      </div>

      {/* Action buttons.
          В мультиплеере решает только хост — у гостей кнопки disabled
          (и подписаны, что ждём лидера). Лидер выбирает: вернуться в то же
          лобби (с тем же roomId, чтобы продолжать с теми же людьми) или
          начать заново эту игру. */}
      <div className="results-actions">
        <button
          className="btn-primary no-pulse"
          disabled={isMultiplayer && !isHost}
          onClick={onAgain}
          title={isMultiplayer && !isHost ? 'Решение за хостом' : undefined}>
          <RotateCcw size={16}/> Начать новую игру
        </button>
        <button
          className="btn-secondary"
          disabled={isMultiplayer && !isHost}
          onClick={onBackToLobby || onHome}
          title={isMultiplayer && !isHost ? 'Решение за хостом' : undefined}>
          <Users size={16}/> Вернуться в лобби
        </button>
        {isMultiplayer && !isHost && (
          <div className="muted" style={{textAlign: 'center', marginTop: 6, fontSize: 12}}>
            <Clock size={11} style={{verticalAlign: '-1px'}}/> Ждём решение хоста…
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── SettingsScreen ─────────────────────────────────────────────────────── */
// Расширенная статистика игрока — одинаково для гостя и TG.
function ProfileStats({ stats, mode }) {
  const total = Number(stats?.total_sessions || 0)
  const finished = Number(stats?.finished_sessions || 0)
  const minutes = Math.round(Number(stats?.total_seconds || 0) / 60)
  const rounds = Number(stats?.total_rounds || 0)
  const totalScore = Number(stats?.total_score || 0)
  const rooms = Number(stats?.rooms || 0)
  const friends = Number(stats?.friends || 0)
  const gameMap = useMemo(() => Object.fromEntries(GAMES.map(g => [g.id, g])), [])
  const byGame = stats?.byGame || []
  const byVibe = stats?.byVibe || []
  const vibeMap = useMemo(() => Object.fromEntries(VIBES.map(v => [v.id, v])), [])
  const firstPlay = stats?.first_play
  const lastPlay = stats?.last_play
  const fmtRel = (ts) => {
    if (!ts) return '—'
    const diff = Date.now() - Number(ts)
    const d = Math.floor(diff / 86400000)
    if (d < 1) return 'сегодня'
    if (d < 2) return 'вчера'
    if (d < 7) return `${d} дн. назад`
    if (d < 60) return `${Math.floor(d/7)} нед. назад`
    return `${Math.floor(d/30)} мес. назад`
  }

  if (total === 0) {
    return (
      <div className="profile-empty">
        Пока нет сыгранных партий. Открой игру и сыграй первый раунд — статистика появится здесь.
      </div>
    )
  }

  return (
    <div className="profile-stats-wrap">
      <div className="profile-stats">
        <div className="profile-stat"><b>{total}</b><span>сессий</span></div>
        <div className="profile-stat"><b>{finished}</b><span>завершено</span></div>
        <div className="profile-stat"><b>{minutes}</b><span>минут</span></div>
      </div>
      <div className="profile-stats">
        <div className="profile-stat"><b>{rounds}</b><span>раундов</span></div>
        <div className="profile-stat"><b>{totalScore}</b><span>очков</span></div>
        <div className="profile-stat"><b>{mode === 'telegram' ? friends : '—'}</b><span>{mode === 'telegram' ? 'друзей' : 'гость'}</span></div>
      </div>

      {byGame.length > 0 && (
        <div className="profile-rank">
          <div className="profile-rank-label">Любимые игры</div>
          {byGame.slice(0, 5).map(r => (
            <div key={r.game_id} className="profile-rank-row">
              <span className="profile-rank-name">
                {gameMap[r.game_id]?.emoji || '🎮'} {gameMap[r.game_id]?.title || r.game_id}
              </span>
              <span className="profile-rank-val">{r.plays}×</span>
            </div>
          ))}
        </div>
      )}

      {byVibe.length > 0 && (
        <div className="profile-rank">
          <div className="profile-rank-label">Любимые вайбы</div>
          {byVibe.map(r => (
            <div key={r.vibe} className="profile-rank-row">
              <span className="profile-rank-name">
                {vibeMap[r.vibe]?.icon || '✨'} {vibeMap[r.vibe]?.label || r.vibe}
              </span>
              <span className="profile-rank-val">{r.plays}×</span>
            </div>
          ))}
        </div>
      )}

      <div className="profile-meta">
        <span>Первая партия: {fmtRel(firstPlay)}</span>
        <span>Последняя: {fmtRel(lastPlay)}</span>
        {mode === 'telegram' && rooms > 0 && <span>Онлайн-комнат: {rooms}</span>}
      </div>
    </div>
  )
}

function ProfileCard({ auth, onOpenPremium }) {
  const name = displayName(auth)
  const avatar = avatarUrl(auth)
  const isTg = auth.mode === 'telegram'
  const stats = auth.stats || {}
  const total = Number(stats.total_sessions || 0)
  const finished = Number(stats.finished_sessions || 0)
  const minutes = Math.round(Number(stats.total_seconds || 0) / 60)

  const isInTelegram = !!window.Telegram?.WebApp?.initData
  // Состояния bot-flow: 'idle' | 'waiting' (ждём подтверждения в боте) | 'error'
  const [loginState, setLoginState] = useState('idle')
  const pollRef = useRef(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // Bot-driven login: сайт создаёт токен → открываем нативный TG
  // (https://t.me/<bot>?start=auth_<token>) → юзер жмёт «Старт» → бот линкует
  // токен с tg_id → сайт через polling /api/auth/poll получает cookie.
  const loginViaBot = async () => {
    setLoginState('waiting')
    try {
      const r = await api.authStart()
      if (!r?.ok || !r.token) throw new Error('start_failed')

      // Открываем нативный TG (на мобиле сразу приложение, на десктопе — TG Desktop
      // или предложение установить). Используем https-ссылку — она универсальна.
      const link = r.deeplink_https
      const tg = window.Telegram?.WebApp
      if (tg?.openTelegramLink) tg.openTelegramLink(link)
      else window.open(link, '_blank', 'noopener')

      // Поллим каждые 1.5 сек до 5 минут.
      const startedAt = Date.now()
      const poll = async () => {
        try {
          const res = await fetch(`/api/auth/poll?token=${encodeURIComponent(r.token)}`, { credentials: 'include' })
          const data = await res.json().catch(() => ({}))
          if (data?.status === 'ok') {
            clearInterval(pollRef.current); pollRef.current = null
            window.location.reload()
            return
          }
          if (data?.status === 'expired' || data?.status === 'consumed' ||
              Date.now() - startedAt > 5 * 60 * 1000) {
            clearInterval(pollRef.current); pollRef.current = null
            setLoginState('error')
          }
        } catch {}
      }
      pollRef.current = setInterval(poll, 1500)
      poll() // first call сразу
    } catch {
      setLoginState('error')
    }
  }

  const cancelLogin = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    setLoginState('idle')
  }

  return (
    <div className="card profile-card" style={{marginBottom:12}}>
      <div className="profile-row">
        <div className="profile-avatar">
          {avatar
            ? <img src={avatar} alt="" referrerPolicy="no-referrer"/>
            : <span className="profile-avatar-initials">{name.slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="profile-info">
          <div className="profile-name">{name}</div>
          <div className="profile-status">
            {isTg && <><CircleCheck size={12} color="#30d158"/> Авторизован через Telegram</>}
            {auth.mode === 'anon' && <><Info size={12} color="var(--muted)"/> Гость (без Telegram)</>}
            {auth.mode === 'guest' && <><Info size={12} color="var(--muted)"/> Не авторизован</>}
          </div>
          {isTg && auth.tgUser?.is_premium ? (
            <div className="profile-badge">⭐ Telegram Premium</div>
          ) : null}
          {auth.premium?.active && (
            <button type="button" className="premium-badge"
              onClick={() => onOpenPremium?.()}
              aria-label="Открыть PartyUp Premium">
              <Sparkles size={11}/>
              <span className="premium-badge-text">PartyUp <span className="premium-glow">Premium</span></span>
            </button>
          )}
          {!auth.premium?.active && isTg && (
            <button type="button" className="premium-badge premium-badge-cta"
              onClick={() => onOpenPremium?.()}
              aria-label="Подключить PartyUp Premium">
              <Sparkles size={11}/>
              <span className="premium-badge-text">Подключить Premium</span>
            </button>
          )}
        </div>
      </div>
      {/* Статистика — для обоих режимов (TG и гостя) */}
      {auth.mode !== 'guest' && (
        <ProfileStats stats={stats} mode={auth.mode}/>
      )}
      {!isTg && (
        <div className="login-block">
          {loginState !== 'waiting' && (
            <button className="btn-tg-login mt-12" onClick={loginViaBot}>
              <Send size={16}/> Войти через Telegram
            </button>
          )}
          {loginState === 'waiting' && (
            <div className="login-waiting">
              <div className="login-waiting-spinner" aria-hidden="true"/>
              <div className="login-waiting-text">
                <strong>Открой Telegram и нажми «Старт»</strong>
                <span>Бот подтвердит вход — сессия откроется автоматически.</span>
              </div>
              <button className="btn-ghost" style={{width:'100%', justifyContent:'center', marginTop: 12}}
                onClick={cancelLogin}>
                Отменить
              </button>
            </div>
          )}
          {loginState === 'error' && (
            <div className="mp-error-hint" style={{marginTop: 10}}>
              <X size={14}/> Ссылка устарела или вход не подтверждён. Попробуй ещё раз.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// tg_id админа — единственная авторитарная проверка для рендера UI-кнопки
// «Админка». Это только защита от показа; реальный доступ режется на сервере
// (см. requireAdmin в worker.js). Если кто-то и подделает id в DevTools — он
// получит максимум пустую страницу, потому что /api/admin/* вернёт 403.
const ADMIN_TG_ID = 265489213
function isAdminAuth(auth) {
  const id = auth?.tgUser?.id ?? auth?.user?.tg_id
  return Number(id) === ADMIN_TG_ID
}

/* ─── ViewedProfileScreen — внутренний просмотр чужого профиля ──────────
   Берёт минимум данных из `player` (имя/аватар), подгружает stats c сервера.
   Никаких ссылок на TG, никакой кнопки "Открыть в Telegram". */
function ViewedProfileScreen({ player, onBack }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    const userId = player?.userId || player?.telegramId || null
    if (!userId) { setLoading(false); return }
    api.user(userId).then(r => {
      if (cancelled) return
      setData(r && r.ok ? { user: r.user, stats: r.stats } : null)
      setLoading(false)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [player])

  if (!player) {
    return (
      <div>
        <div className="screen-top-bar">
          <button className="screen-back-btn" onClick={onBack}><ArrowLeft size={16}/> Назад</button>
        </div>
        <p className="muted" style={{textAlign:'center', marginTop:40}}>Игрок не выбран</p>
      </div>
    )
  }

  const photo = data?.user?.photo_url || player.photo_url || null
  const name = data?.user?.name || player.name || 'Игрок'
  const isPremium = !!(data?.user?.premium || player.premium)
  const stats = data?.stats || null
  const memberSince = data?.user?.member_since
    ? new Date(data.user.member_since).toLocaleDateString('ru-RU', { year: 'numeric', month: 'long' })
    : null

  return (
    <div>
      <div className="screen-top-bar">
        <button className="screen-back-btn" onClick={onBack}><ArrowLeft size={16}/> Назад</button>
      </div>

      <p className="eyebrow"><Users size={13}/> Профиль игрока</p>
      <h2 style={{marginBottom: 14}}>{name}</h2>

      <div className="card profile-card" style={{marginBottom: 12}}>
        <div className="profile-row">
          <div className="profile-avatar">
            {photo
              ? <img src={photo} alt="" referrerPolicy="no-referrer"/>
              : <span className="profile-avatar-initials">{(player.emoji || name.slice(0,1).toUpperCase())}</span>}
          </div>
          <div className="profile-info">
            <div className="profile-name">{name}</div>
            {memberSince && (
              <div className="profile-status">
                <Clock size={12} color="var(--muted)"/> На PartyUp с {memberSince}
              </div>
            )}
            {isPremium && (
              <div className="premium-badge" style={{pointerEvents:'none'}}>
                <Sparkles size={11}/>
                <span className="premium-badge-text">PartyUp <span className="premium-glow">Premium</span></span>
              </div>
            )}
          </div>
        </div>
      </div>

      {loading && <div className="profile-empty">Загружаем статистику…</div>}

      {!loading && !stats && (
        <div className="profile-empty">
          У этого игрока пока нет публичной статистики. Сыграйте вместе — она появится здесь.
        </div>
      )}

      {!loading && stats && (() => {
        const total = Number(stats?.total_sessions || 0)
        const finished = Number(stats?.finished_sessions || 0)
        const minutes = Math.round(Number(stats?.total_seconds || 0) / 60)
        const rounds = Number(stats?.total_rounds || 0)
        const totalScore = Number(stats?.total_score || 0)
        const rooms = Number(stats?.rooms || 0)
        if (total === 0) {
          return <div className="profile-empty">У этого игрока пока нет сыгранных партий.</div>
        }
        // Самая необходимая статистика — 6 цифр в 2 ряда.
        return (
          <div className="profile-stats-wrap">
            <div className="profile-stats">
              <div className="profile-stat"><b>{total}</b><span>сессий</span></div>
              <div className="profile-stat"><b>{finished}</b><span>завершено</span></div>
              <div className="profile-stat"><b>{minutes}</b><span>минут</span></div>
            </div>
            <div className="profile-stats">
              <div className="profile-stat"><b>{rounds}</b><span>раундов</span></div>
              <div className="profile-stat"><b>{totalScore}</b><span>очков</span></div>
              <div className="profile-stat"><b>{rooms}</b><span>комнат</span></div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function ProfileScreen({ auth, onReturnToGame, onOpenPremium }) {
  return (
    <div>
      <p className="eyebrow"><Users size={13}/> Профиль</p>
      <div className="profile-screen-head">
        <h2 className="profile-screen-name">{displayName(auth)}</h2>
        {onReturnToGame && (
          <button className="profile-return-btn" onClick={onReturnToGame}>
            <Play size={14}/> Вернуться в игру
          </button>
        )}
      </div>
      <ProfileCard auth={auth} onOpenPremium={onOpenPremium} />
    </div>
  )
}

// Открытие админки: 1) получить токен по initData/cookie,
// 2) открыть /api/admin/vault?token=… во внешнем браузере.
// Используется только из SettingsScreen у админа.
async function openAdminPanel() {
  let token = null
  try {
    const r = await api.adminToken()
    token = r?.token
    if (!token) {
      const why = r?.error ? `сервер ответил: ${r.error}` : 'сервер не вернул token'
      alert(`Не удалось получить токен админки.\n${why}`)
      return
    }
  } catch (e) {
    alert('Сеть/ошибка при запросе токена: ' + (e?.message || 'unknown'))
    return
  }
  const url = `${window.location.origin}/api/admin/vault?token=${encodeURIComponent(token)}`
  const tg = window.Telegram?.WebApp
  try { if (tg?.openLink) { tg.openLink(url, { try_instant_view: false }); return } } catch {}
  const w = window.open(url, '_blank', 'noopener')
  if (!w) {
    try { await navigator.clipboard?.writeText(url) } catch {}
    alert(`Браузер заблокировал popup. Ссылка скопирована в буфер обмена.\n\n${url}`)
  }
}

function SettingsScreen({ settings, setSettings, onBack, auth, onOpenPremium }) {
  const [hapticsOn, setHapticsOn] = useState(() => localStorage.getItem('pu_haptics') !== 'off')
  const [theme, setTheme] = useState(() => localStorage.getItem('pu_theme') || 'dark')

  const toggleHaptics = () => {
    const next = !hapticsOn
    setHapticsOn(next)
    localStorage.setItem('pu_haptics', next ? 'on' : 'off')
  }

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'vibrant' : 'dark'
    setTheme(next)
    localStorage.setItem('pu_theme', next)
    document.documentElement.className = next === 'vibrant' ? 'theme-vibrant' : ''
  }

  const openSupport = () => {
    // Команда /support боту откроет диалог сразу с подсказкой описать вопрос
    // одним сообщением — webhook handle перешлёт админу.
    const link = `https://t.me/${BOT_USERNAME}?start=support`
    const tg = window.Telegram?.WebApp
    if (tg?.openTelegramLink) tg.openTelegramLink(link)
    else window.open(link, '_blank', 'noopener')
  }

  const rows = [] // настройки игры теперь живут в CreateLobby (под каждую игру свои)

  return (
    <div>
      <p className="eyebrow"><Settings size={13}/> Настройки</p>
      <h2 style={{marginBottom:20}}>Параметры приложения</h2>

      {/* PartyUp Premium — отдельный пункт сверху, чтобы сразу видеть статус подписки */}
      <button type="button"
        className={`settings-premium-card ${auth?.premium?.active ? 'is-active' : ''}`}
        onClick={() => onOpenPremium?.()}
        aria-label="PartyUp Premium">
        <div className="settings-premium-icon"><Sparkles size={22}/></div>
        <div className="settings-premium-body">
          <div className="settings-premium-title">
            PartyUp <span className="premium-glow">Premium</span>
          </div>
          <div className="settings-premium-sub">
            {auth?.premium?.active
              ? `Активна до ${new Date(auth.premium.until).toLocaleDateString('ru-RU')}`
              : 'Все паки сразу · 199⭐ ≈ 300 ₽ · 30 дней'}
          </div>
        </div>
        <ChevronRight size={18} color="var(--accent-2)"/>
      </button>

      {/* App preferences */}
      <div className="card" style={{marginBottom:12}}>
        <div className="settings-list">
          <div className="settings-row">
            <div>
              <div className="settings-label"><Sparkles size={16}/> Тема</div>
              <div className="settings-label-sub">Цветовое оформление</div>
            </div>
            <button
              className={`settings-toggle-btn ${theme === 'vibrant' ? 'is-on' : ''}`}
              onClick={toggleTheme}
              aria-pressed={theme === 'vibrant'}>
              {theme === 'vibrant' ? '🌈 Яркая' : '🌙 Тёмная'}
            </button>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-label"><Rocket size={16}/> Вибрация</div>
              <div className="settings-label-sub">Haptic feedback при действиях</div>
            </div>
            <button
              className={`settings-toggle-btn ${hapticsOn ? 'is-on' : ''}`}
              onClick={toggleHaptics}
              aria-pressed={hapticsOn}>
              {hapticsOn ? 'Вкл' : 'Выкл'}
            </button>
          </div>
        </div>
      </div>

      {/* Support */}
      <div className="card" style={{marginBottom:20}}>
        <div className="settings-list">
          <button className="settings-row settings-row-btn" onClick={openSupport}>
            <div>
              <div className="settings-label"><Send size={16}/> Поддержка</div>
              <div className="settings-label-sub">Написать в Telegram</div>
            </div>
            <ChevronRight size={16} color="var(--muted)"/>
          </button>
          <div className="settings-row">
            <div>
              <div className="settings-label" style={{color:'var(--muted)',fontSize:13}}>Язык</div>
              <div className="settings-label-sub">Меняется в настройках Telegram</div>
            </div>
            <span className="tag">🇷🇺 Русский</span>
          </div>
        </div>
      </div>

      {/* Админка — рендерится ТОЛЬКО для tg_id === ADMIN_TG_ID.
          Двойная защита: (1) проверка id здесь скрывает кнопку у всех остальных;
          (2) на сервере /api/admin/* и /api/admin/issue-token режут любой
          запрос без валидной admin-сессии — даже если кто-то покажет кнопку
          через DevTools, доступа не будет. */}
      {isAdminAuth(auth) && (
        <div className="card" style={{marginBottom:12}}>
          <div className="settings-list">
            <button className="settings-row settings-row-btn" onClick={openAdminPanel}>
              <div>
                <div className="settings-label"><ShieldCheck size={16}/> Админка</div>
                <div className="settings-label-sub">Дашборд, контент, юзеры</div>
              </div>
              <ChevronRight size={16} color="var(--muted)"/>
            </button>
          </div>
        </div>
      )}

      <button className="btn-secondary" onClick={onBack}><ArrowLeft size={16}/> Назад</button>
    </div>
  )
}
