import { useEffect, useMemo, useState } from 'react'
import Console from './designs/Console'
import Orbs from './designs/Orbs'
import Deck from './designs/Deck'
import NeonRoom from './designs/NeonRoom'
import Sticker from './designs/Sticker'
import './theme.css'
import './App.css'

const DESIGN_VARIANTS = [
  {
    id: 'console',
    icon: '🎛️',
    title: 'Party Console',
    subtitle: 'панель запуска',
    Component: Console,
  },
  {
    id: 'orbs',
    icon: '🔮',
    title: 'Game Orbs',
    subtitle: 'шары режимов',
    Component: Orbs,
  },
  {
    id: 'deck',
    icon: '🧩',
    title: 'Party Deck',
    subtitle: 'задания',
    Component: Deck,
  },
  {
    id: 'room',
    icon: '🌆',
    title: 'Neon Room',
    subtitle: 'лобби',
    Component: NeonRoom,
  },
  {
    id: 'sticker',
    icon: '💬',
    title: 'Sticker UI',
    subtitle: 'telegram-native',
    Component: Sticker,
  },
]

function App() {
  const [activeId, setActiveId] = useState(DESIGN_VARIANTS[0].id)

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (tg) {
      tg.ready()
      tg.expand()
    }
  }, [])

  const active = useMemo(
    () => DESIGN_VARIANTS.find((variant) => variant.id === activeId) || DESIGN_VARIANTS[0],
    [activeId],
  )

  const ActiveDesign = active.Component

  return (
    <div className="app-shell">
      <div className="party-bg" aria-hidden="true">
        <span className="confetti c1" />
        <span className="confetti c2" />
        <span className="confetti c3" />
        <span className="confetti c4" />
      </div>

      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark">PU</div>
          <div>
            <p className="eyebrow">Glossy 3D social party app</p>
            <h1>PartyUp</h1>
          </div>
        </div>
        <div className="asset-note">
          <span>✨</span>
          Emoji prototype icons
        </div>
      </header>

      <nav className="design-switcher" aria-label="Выбор варианта дизайна">
        {DESIGN_VARIANTS.map((variant) => (
          <button
            key={variant.id}
            className={`design-tab ${variant.id === activeId ? 'is-active' : ''}`}
            onClick={() => setActiveId(variant.id)}
            type="button"
          >
            <span className="tab-icon">{variant.icon}</span>
            <span>
              <strong>{variant.title}</strong>
              <small>{variant.subtitle}</small>
            </span>
          </button>
        ))}
      </nav>

      <main className="design-stage">
        <ActiveDesign />
      </main>
    </div>
  )
}

export default App
