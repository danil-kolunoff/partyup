import { useMemo, useState } from 'react'
import { GAMES } from '../games'
import { CATEGORY_META, VIBES, gameIcon } from './shared'

const MODE_IDS = ['вопросы', 'действия', 'голосование', 'объяснялки', 'мемы', 'детектив', 'скорость', 'угадайка']

export default function Console() {
  const [vibe, setVibe] = useState(VIBES[0].id)
  const [mode, setMode] = useState(MODE_IDS[0])

  const selectedVibe = VIBES.find((item) => item.id === vibe) || VIBES[0]
  const popularGames = useMemo(() => GAMES.filter((game) => game.hot).slice(0, 6), [])
  const modeGames = GAMES.filter((game) => game.category === mode)

  return (
    <section className="variant console-view">
      <div className="console-hero">
        <div className="burst-cluster" aria-hidden="true">
          <span className="burst-orb orb-xl">🎉</span>
          <span className="burst-orb orb-a">⏱️</span>
          <span className="burst-orb orb-b">😂</span>
          <span className="burst-orb orb-c">🕵️</span>
          <span className="burst-orb orb-d">✅</span>
        </div>

        <p className="eyebrow">Party Console</p>
        <h2>Запусти вечер за один тап</h2>
        <p className="lead">
          Не список игр, а панель запуска: выбери вайб, режим и дай приложению собрать быстрый Party Mix.
        </p>

        <button className="primary-cta" type="button">
          <span>🚀</span>
          Начать быструю игру
        </button>
      </div>

      <div className="console-grid">
        <div className="panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Atmosphere</p>
              <h3>Настройка вайба</h3>
            </div>
            <span className="soft-pill">{selectedVibe.icon} {selectedVibe.hint}</span>
          </div>

          <div className="vibe-grid">
            {VIBES.map((item) => (
              <button
                key={item.id}
                className={`vibe-card ${vibe === item.id ? 'is-active' : ''}`}
                onClick={() => setVibe(item.id)}
                type="button"
              >
                <span className="plastic-icon">{item.icon}</span>
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Modes</p>
              <h3>Выбери режим</h3>
            </div>
            <span className="soft-pill">{modeGames.length || GAMES.length} игр</span>
          </div>

          <div className="mode-grid">
            {MODE_IDS.map((category) => {
              const meta = CATEGORY_META[category]
              return (
                <button
                  key={category}
                  className={`mode-tile tone-${meta?.tone || 'violet'} ${mode === category ? 'is-active' : ''}`}
                  onClick={() => setMode(category)}
                  type="button"
                >
                  <span className="plastic-icon">{meta?.icon}</span>
                  <span>{meta?.label || category}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Trending</p>
            <h3>Популярно сегодня</h3>
          </div>
          <span className="soft-pill">hot mix 🔥</span>
        </div>

        <div className="popular-row">
          {popularGames.map((game) => (
            <article className="popular-card" key={game.id}>
              <span className="plastic-icon">{gameIcon(game)}</span>
              <strong>{game.title}</strong>
              <small>{game.short}</small>
              <span className="mini-meta">👥 {game.players} · {game.time}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
