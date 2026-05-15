import { useState } from 'react'
import { GAMES } from '../games'
import { PLAYERS, REACTIONS, gameIcon } from './shared'

const RESULT_CARDS = [
  { title: 'Главный шпион вечера', value: 'Дима', icon: '🕵️' },
  { title: 'Король кринж-ответов', value: 'Аня', icon: '😂' },
  { title: 'Мемолог комнаты', value: 'Саша', icon: '🔥' },
]

export default function Sticker() {
  const [counts, setCounts] = useState({})

  const increment = (gameId, reaction) => {
    const key = `${gameId}-${reaction}`
    setCounts((current) => ({ ...current, [key]: (current[key] || 0) + 1 }))
  }

  return (
    <section className="variant sticker-view">
      <div className="variant-title">
        <p className="eyebrow">Sticker UI</p>
        <h2>Telegram-native вайб</h2>
        <p className="lead">Интерфейс как набор премиальных 3D-стикеров: реакции, баблы и шарящиеся итоги.</p>
      </div>

      <div className="sticker-layout">
        <div className="sticker-feed">
          {GAMES.slice(0, 10).map((game, index) => (
            <article className={`sticker-card sticker-${index % 4}`} key={game.id}>
              <span className="sticker-icon">{gameIcon(game)}</span>
              <div className="sticker-copy">
                <div>
                  <h3>{game.title}</h3>
                  <p>{game.short}</p>
                </div>
                <div className="metric-row">
                  <span>👥 {game.players}</span>
                  <span>⏱️ {game.time}</span>
                </div>
                <div className="reaction-row small">
                  {REACTIONS.slice(0, 4).map((reaction) => {
                    const count = counts[`${game.id}-${reaction}`] || 0
                    return (
                      <button
                        key={reaction}
                        className={count ? 'is-active' : ''}
                        onClick={() => increment(game.id, reaction)}
                        type="button"
                      >
                        {reaction}{count ? ` ${count}` : ''}
                      </button>
                    )
                  })}
                </div>
              </div>
            </article>
          ))}
        </div>

        <aside className="share-panel panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Share cards</p>
              <h3>Итоги раунда</h3>
            </div>
            <span className="soft-pill">в чат</span>
          </div>

          <div className="player-bubbles">
            {PLAYERS.map((player, index) => (
              <span key={player}>{['😎', '😂', '🪩', '🔥', '✨'][index]} {player}</span>
            ))}
          </div>

          <div className="result-stack">
            {RESULT_CARDS.map((card) => (
              <article className="result-card" key={card.title}>
                <span>{card.icon}</span>
                <small>{card.title}</small>
                <strong>{card.value}</strong>
              </article>
            ))}
          </div>

          <button className="primary-cta compact" type="button">
            <span>💌</span>
            Поделиться итогами
          </button>
        </aside>
      </div>
    </section>
  )
}
