import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initAnalytics, ev } from './lib/analytics.js'
import { api } from './lib/api.js'

initAnalytics()
ev.open({ path: window.location.pathname, ref: document.referrer || null })

// Аутентификация в Telegram (или anon-режим вне TG) — не блокирует рендер.
api.auth().then((r) => {
  if (r?.ok) ev.authOk(r.mode)
}).catch(() => {})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
