import { useMemo, useState } from 'react'
import { GAMES } from '../games'
import { PLAYERS, gameIcon } from './shared'

const ROOM_OBJECTS = [
  { gameId: 'alias', label: 'Микрофон', icon: '🎙️', x: 14, y: 54 },
  { gameId: 'spy', label: 'Маска', icon: '🕵️', x: 73, y: 28 },
  { gameId: 'five', label: 'Таймер', icon: '⏱️', x: 68, y: 63 },
  { gameId: 'memes', label: 'Экран', icon: '😂', x: 30, y: 27 },
  { gameId: 'truth', label: 'Коробка вопросов', icon: '⁉️', x: 47, y: 73 },
]

export default function NeonRoom() {
  const [activeGameId, setActiveGameId] = useState('memes')
  const activeGame = useMemo(
    () => GAMES.find((game) => game.id === activeGameId) || GAMES[0],
    [activeGameId],
  )

  return (
    <section className="variant room-view">
      <div className="variant-title">
        <p className="eyebrow">Neon Party Room</p>
        <h2>Лобби вечеринки</h2>
        <p className="lead">Комната как будущая основа для мультиплеера: игроки, объекты-игры и запуск общего раунда.</p>
      </div>

      <div className="room-layout">
        <div className="party-room panel">
          <div className="room-header">
            <div>
              <p className="eyebrow">Room 404</p>
              <h3>Пятница без правил</h3>
            </div>
            <span className="soft-pill">5 online</span>
          </div>

          <div className="avatar-strip">
            {PLAYERS.map((player, index) => (
              <div className="avatar-chip" key={player}>
                <span>{['😎', '😂', '🪩', '🔥', '✨'][index]}</span>
                <small>{player}</small>
              </div>
            ))}
          </div>

          <div className="room-scene">
            <div className="dance-floor" />
            {ROOM_OBJECTS.map((item) => {
              const game = GAMES.find((candidate) => candidate.id === item.gameId)
              return (
                <button
                  key={item.gameId}
                  className={`room-object ${activeGameId === item.gameId ? 'is-active' : ''}`}
                  onClick={() => setActiveGameId(item.gameId)}
                  type="button"
                  style={{ left: `${item.x}%`, top: `${item.y}%` }}
                >
                  <span>{item.icon}</span>
                  <small>{item.label}</small>
                  <em>{game?.title}</em>
                </button>
              )
            })}
          </div>
        </div>

        <aside className="room-side panel">
          <span className="detail-icon">{gameIcon(activeGame)}</span>
          <p className="eyebrow">Выбранный объект</p>
          <h3>{activeGame.title}</h3>
          <p>{activeGame.short}</p>
          <div className="metric-row">
            <span>👥 {activeGame.players}</span>
            <span>⏱️ {activeGame.time}</span>
          </div>
          <button className="primary-cta compact" type="button">
            <span>🪩</span>
            Запустить комнату
          </button>
        </aside>
      </div>
    </section>
  )
}
