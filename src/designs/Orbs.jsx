import { useMemo, useState } from 'react'
import { GAMES } from '../games'
import { CATEGORY_META, gameIcon } from './shared'

export default function Orbs() {
  const [selectedId, setSelectedId] = useState('truth')
  const selected = useMemo(
    () => GAMES.find((game) => game.id === selectedId) || GAMES[0],
    [selectedId],
  )
  const meta = CATEGORY_META[selected.category]

  return (
    <section className="variant orbs-view">
      <div className="variant-title">
        <p className="eyebrow">Game Orbs</p>
        <h2>Планета мини-игр</h2>
        <p className="lead">Каждая игра — глянцевый жетон. Нажми на шар, чтобы собрать компанию вокруг режима.</p>
      </div>

      <div className="orb-layout">
        <div className="orb-cloud" aria-label="Игры">
          {GAMES.map((game, index) => (
            <button
              key={game.id}
              className={`game-orb orb-tone-${index % 6} ${selected.id === game.id ? 'is-active' : ''}`}
              onClick={() => setSelectedId(game.id)}
              type="button"
              style={{ '--float-delay': `${(index % 5) * 0.35}s` }}
            >
              <span className="orb-icon">{gameIcon(game)}</span>
              <span className="orb-label">{game.title}</span>
              {game.hot && <span className="hot-dot">🔥</span>}
            </button>
          ))}
        </div>

        <aside className="orb-detail panel">
          <span className="detail-icon">{gameIcon(selected)}</span>
          <p className="eyebrow">{meta?.icon} {meta?.label || selected.category}</p>
          <h3>{selected.title}</h3>
          <p>{selected.short}</p>
          <div className="metric-row">
            <span>👥 {selected.players}</span>
            <span>⏱️ {selected.time}</span>
            {selected.hot && <span>🔥 hot</span>}
          </div>
          <button className="primary-cta compact" type="button">
            <span>✨</span>
            Запустить режим
          </button>
        </aside>
      </div>
    </section>
  )
}
