import { useEffect, useState } from 'react'
import { GAMES } from './games'
import './App.css'

function App() {
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (tg) {
      tg.ready()
      tg.expand()
    }
  }, [])

  if (selected) {
    return (
      <div className="screen">
        <button className="back" onClick={() => setSelected(null)}>← Назад</button>
        <div className="game-detail">
          <div className="game-emoji big">{selected.emoji}</div>
          <h1>{selected.title}</h1>
          <p className="muted">{selected.short}</p>
          <div className="meta">
            <span>👥 {selected.players}</span>
            <span>⏱️ {selected.time}</span>
          </div>
          <p className="soon">Игра скоро будет доступна 🚧</p>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <header className="hero">
        <h1>🎉 PartyUp</h1>
        <p className="muted">Пак вечериночных игр для компании</p>
      </header>
      <div className="grid">
        {GAMES.map((g) => (
          <button key={g.id} className="card" onClick={() => setSelected(g)}>
            <div className="game-emoji">{g.emoji}</div>
            <div className="game-title">{g.title}</div>
            <div className="game-short">{g.short}</div>
          </button>
        ))}
      </div>
      <footer className="foot muted">v0.1 · Telegram Mini App</footer>
    </div>
  )
}

export default App
