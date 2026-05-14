# PartyUp 🎉

Веб-игра для Telegram Mini App: набор вечериночных игр для компании.

## Игры
- 🗣️ Элиас
- 🙅 Я никогда не…
- 🎯 Правда или действие
- 👥 Кто из нас
- 🕵️ Шпион
- 🐊 Крокодил
- ⏱️ 5 секунд
- 😂 Мем-батл
- ❓ Кто я?
- 📊 Кто скорее всего…
- 🔍 Угадай факт о друге

## Стек
- React 19 + Vite 8 (SPA)
- Cloudflare Workers + Static Assets (фронт + бэк в одном)
- Telegram Mini App SDK (`telegram-web-app.js`)

## Разработка
```bash
npm install
npm run dev          # локальный dev-сервер
npm run build        # сборка в dist/
npm run deploy       # build + wrangler deploy
```

## Структура
```
src/
  App.jsx     — каталог игр и экран выбранной игры
  games.js    — список игр
  worker.js   — Cloudflare Worker (статика + /api/*)
  main.jsx    — точка входа React
  App.css     — стили
wrangler.jsonc — конфиг Worker'а
```

## Что дальше
- Реализовать игры по одной (проще всего начать с «5 секунд», «Крокодил», «Правда или действие»)
- Подключить онлайн-комнаты через Durable Objects (по образцу `perekup`)
- Telegram-аутентификация через `initData`
