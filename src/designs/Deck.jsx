import { useMemo, useState } from 'react'
import { PARTY_TASKS, REACTIONS } from './shared'

export default function Deck() {
  const [round, setRound] = useState(2)
  const [taskIndex, setTaskIndex] = useState(0)
  const [reaction, setReaction] = useState(null)
  const task = PARTY_TASKS[taskIndex]
  const nextTask = PARTY_TASKS[(taskIndex + 1) % PARTY_TASKS.length]

  const progress = useMemo(() => `${Math.min(round * 10, 90)}%`, [round])

  const nextRound = () => {
    setTaskIndex((index) => (index + 1) % PARTY_TASKS.length)
    setRound((value) => value + 1)
    setReaction(null)
  }

  return (
    <section className="variant deck-view">
      <div className="variant-title">
        <p className="eyebrow">Party Deck</p>
        <h2>Колода заданий, не карт</h2>
        <p className="lead">Из стопки вылетает вопрос, действие, голосование или быстрый челлендж.</p>
      </div>

      <div className="deck-table">
        <div className="round-panel panel">
          <div className="round-top">
            <span className="soft-pill">Раунд {round}</span>
            <span className="soft-pill">{task.type}</span>
          </div>

          <div className="progress-track">
            <span style={{ width: progress }} />
          </div>

          <div className="task-card">
            <span className="task-icon">{task.icon}</span>
            <p className="eyebrow">Вылетевшее задание</p>
            <h3>{task.title}</h3>
            <div className="reaction-row">
              {REACTIONS.map((item) => (
                <button
                  key={item}
                  className={reaction === item ? 'is-active' : ''}
                  onClick={() => setReaction(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="task-actions">
              <button className="primary-cta compact" type="button">
                {task.action}
              </button>
              <button className="ghost-button" onClick={nextRound} type="button">
                Следующий вопрос
              </button>
            </div>
          </div>
        </div>

        <div className="tile-stack" aria-hidden="true">
          <div className="stack-tile tile-back">
            <span>{nextTask.icon}</span>
            <strong>{nextTask.type}</strong>
          </div>
          <div className="stack-tile tile-mid">
            <span>💬</span>
            <strong>Party Mix</strong>
          </div>
          <div className="stack-tile tile-front">
            <span>{task.icon}</span>
            <strong>{task.type}</strong>
          </div>
        </div>
      </div>
    </section>
  )
}
