// Cloudflare Worker для PartyUp.
// - отдаёт собранный фронт из ./dist (binding ASSETS)
// - /api/health           — заглушка
// - /api/tg/webhook       — Telegram bot webhook
// - /api/auth             — валидация Telegram initData + upsert юзера
// - /api/me               — профиль текущего юзера + статистика
// - /api/track            — приём событий телеметрии
// - /api/session/*        — start/finish игровой сессии
// - /api/room/:id/*       — Durable Object мультиплеера + зеркалирование в D1
// - /api/payments/*       — Telegram Stars (заготовка)

import { buildInlineResults } from './worker-inline.js';

const WEBAPP_URL_DEFAULT = 'https://partyup-game.ru';
const BOT_USERNAME_DEFAULT = 'PartyUp_Gamebot';
const APP_SHORT_NAME_DEFAULT = 'play';

function botUsername(env) { return env.BOT_USERNAME || BOT_USERNAME_DEFAULT; }
function appShortName(env) { return env.APP_SHORT_NAME || APP_SHORT_NAME_DEFAULT; }
function directLink(env, startParam) {
  const base = `https://t.me/${botUsername(env)}/${appShortName(env)}`;
  return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : base;
}

/* ─── utils ──────────────────────────────────────────────────────────────── */
function now() { return Date.now(); }
function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function safeJson(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/* ─── CORS ───────────────────────────────────────────────────────────────── */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data, X-Anon-Id',
};
function corsJson(data, status = 200) {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

/* ─── Telegram initData валидация ────────────────────────────────────────── */
// см. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

async function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const enc = new TextEncoder();
  const secretKey = await hmacSha256(enc.encode('WebAppData'), enc.encode(botToken));
  const sig = await hmacSha256(secretKey, enc.encode(dataCheckString));
  const sigHex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sigHex !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  // отбросим протухшие initData (>24ч)
  if (authDate && now() / 1000 - authDate > 24 * 3600) return null;

  const userJson = params.get('user');
  const user = userJson ? safeJson(userJson) : null;
  const startParam = params.get('start_param') || null;
  return { user, startParam, authDate };
}

/* ─── D1 helpers ─────────────────────────────────────────────────────────── */
async function upsertUser(env, tgUser, refUserId = null) {
  if (!env.DB || !tgUser?.id) return null;
  const ts = now();
  // display_name: «Имя Фамилия» из TG, иначе username, иначе fallback.
  const fullName = [tgUser.first_name || '', tgUser.last_name || ''].join(' ').trim();
  const display = fullName || tgUser.username || `Игрок ${tgUser.id}`;
  await env.DB.prepare(
    `INSERT INTO users (tg_id, username, first_name, last_name, language_code, is_premium, photo_url, display_name, ref_user_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       language_code = excluded.language_code,
       is_premium = excluded.is_premium,
       photo_url = COALESCE(excluded.photo_url, users.photo_url),
       display_name = excluded.display_name,
       last_seen_at = excluded.last_seen_at`
  ).bind(
    tgUser.id,
    tgUser.username || null,
    tgUser.first_name || null,
    tgUser.last_name || null,
    tgUser.language_code || null,
    tgUser.is_premium ? 1 : 0,
    tgUser.photo_url || null,
    display,
    refUserId || null,
    ts,
    ts,
  ).run();

  return env.DB.prepare('SELECT * FROM users WHERE tg_id = ?').bind(tgUser.id).first();
}

/* ─── Анонимные ники из 2 слов ────────────────────────────────────────── */
const NICK_ADJ = [
  'Быстрый','Тихий','Дерзкий','Хитрый','Смелый','Весёлый','Спокойный','Острый',
  'Мудрый','Грозный','Тёплый','Холодный','Лёгкий','Дикий','Гордый','Скрытый',
  'Яркий','Шумный','Ловкий','Звёздный','Лесной','Ночной','Утренний','Северный',
];
const NICK_NOUN = [
  'Тигр','Сокол','Барс','Волк','Лис','Ёж','Бобр','Енот',
  'Орёл','Медведь','Кот','Пёс','Кит','Дельфин','Заяц','Олень',
  'Ястреб','Лев','Журавль','Ворон','Краб','Лось','Сом','Носорог',
  'Бизон','Сурок','Удав','Хорёк','Барсук','Шершень','Тукан','Феникс',
];

function stringHash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(s).length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}
function generateNickname(seed) {
  const h = stringHash32(seed);
  const adj = NICK_ADJ[h % NICK_ADJ.length];
  const noun = NICK_NOUN[Math.floor(h / NICK_ADJ.length) % NICK_NOUN.length];
  return `${adj} ${noun}`;
}

async function upsertAnon(env, anonId) {
  if (!env.DB || !anonId) return null;
  const ts = now();
  // Если запись новая — сразу проставляем сгенерированный ник, чтобы он
  // фиксировался на всю сессию (a-la «Дерзкий Лис»). Существующую запись
  // не перезатираем: ник остаётся стабильным до TG-логина.
  const nickname = generateNickname(anonId);
  await env.DB.prepare(
    `INSERT INTO anon_users (anon_id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(anon_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       name = COALESCE(anon_users.name, excluded.name)`
  ).bind(anonId, nickname, ts, ts).run();
  return env.DB.prepare('SELECT * FROM anon_users WHERE anon_id = ?').bind(anonId).first();
}

/* ─── Миграция данных анона в TG-аккаунт при первом логине ───────────── */
async function migrateAnonToUser(env, anonId, userId) {
  if (!env.DB || !anonId || !userId) return { migrated: false };
  const ts = now();
  const r1 = await env.DB.prepare(
    `UPDATE sessions SET user_id = ?, anon_id = NULL WHERE anon_id = ? AND user_id IS NULL`
  ).bind(userId, anonId).run();
  const r2 = await env.DB.prepare(
    `UPDATE events SET user_id = ?, anon_id = NULL WHERE anon_id = ? AND user_id IS NULL`
  ).bind(userId, anonId).run();
  const r3 = await env.DB.prepare(
    `UPDATE room_players SET user_id = ?, anon_id = NULL WHERE anon_id = ? AND user_id IS NULL`
  ).bind(userId, anonId).run();
  await env.DB.prepare(`DELETE FROM anon_users WHERE anon_id = ?`).bind(anonId).run();
  await env.DB.prepare(
    `INSERT INTO events (ts, user_id, type, props) VALUES (?, ?, 'anon_merged', ?)`
  ).bind(ts, userId, JSON.stringify({ anonId, sessions: r1.meta?.changes || 0, events: r2.meta?.changes || 0, rooms: r3.meta?.changes || 0 })).run();
  return {
    migrated: true,
    sessions: r1.meta?.changes || 0,
    events: r2.meta?.changes || 0,
    rooms: r3.meta?.changes || 0,
  };
}

async function getUserStats(env, userId) {
  if (!env.DB || !userId) return null;
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total_sessions,
       SUM(CASE WHEN finished = 1 THEN 1 ELSE 0 END) AS finished_sessions,
       SUM(COALESCE(duration_sec, 0)) AS total_seconds,
       SUM(COALESCE(rounds_played, 0)) AS total_rounds,
       (SELECT COALESCE(SUM(active_ms),0) FROM session_players sp WHERE sp.session_id IN (SELECT id FROM sessions s2 WHERE s2.user_id = ?)) AS total_active_ms,
       MIN(started_at) AS first_play,
       MAX(started_at) AS last_play
     FROM sessions WHERE user_id = ?`
  ).bind(userId, userId).first();
  const byGame = await env.DB.prepare(
    `SELECT game_id, COUNT(*) AS plays FROM sessions WHERE user_id = ? GROUP BY game_id ORDER BY plays DESC LIMIT 10`
  ).bind(userId).all();
  const byVibe = await env.DB.prepare(
    `SELECT vibe, COUNT(*) AS plays FROM sessions WHERE user_id = ? AND vibe IS NOT NULL GROUP BY vibe ORDER BY plays DESC`
  ).bind(userId).all();
  const rooms = await env.DB.prepare(
    `SELECT COUNT(DISTINCT room_id) AS rooms FROM sessions WHERE user_id = ? AND room_id IS NOT NULL`
  ).bind(userId).first();
  const friends = await env.DB.prepare(
    `SELECT COUNT(DISTINCT rp2.user_id) AS friends
     FROM room_players rp1 JOIN room_players rp2 ON rp2.room_id = rp1.room_id AND rp2.user_id != rp1.user_id
     WHERE rp1.user_id = ? AND rp2.user_id IS NOT NULL`
  ).bind(userId).first();
  const totalScore = await env.DB.prepare(
    `SELECT SUM(COALESCE(score,0)) AS total_score FROM session_players WHERE user_id = ?`
  ).bind(userId).first();
  return {
    ...row,
    byGame: byGame.results || [],
    byVibe: byVibe.results || [],
    rooms: rooms?.rooms || 0,
    friends: friends?.friends || 0,
    total_score: totalScore?.total_score || 0,
  };
}

// Статистика для гостевой сессии (anon_id).
async function getAnonStats(env, anonId) {
  if (!env.DB || !anonId) return null;
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total_sessions,
       SUM(CASE WHEN finished = 1 THEN 1 ELSE 0 END) AS finished_sessions,
       SUM(COALESCE(duration_sec, 0)) AS total_seconds,
       SUM(COALESCE(rounds_played, 0)) AS total_rounds,
       (SELECT COALESCE(SUM(active_ms),0) FROM session_players sp WHERE sp.session_id IN (SELECT id FROM sessions s2 WHERE s2.anon_id = ?)) AS total_active_ms,
       MIN(started_at) AS first_play,
       MAX(started_at) AS last_play
     FROM sessions WHERE anon_id = ?`
  ).bind(anonId, anonId).first();
  const byGame = await env.DB.prepare(
    `SELECT game_id, COUNT(*) AS plays FROM sessions WHERE anon_id = ? GROUP BY game_id ORDER BY plays DESC LIMIT 10`
  ).bind(anonId).all();
  const byVibe = await env.DB.prepare(
    `SELECT vibe, COUNT(*) AS plays FROM sessions WHERE anon_id = ? AND vibe IS NOT NULL GROUP BY vibe ORDER BY plays DESC`
  ).bind(anonId).all();
  return { ...row, byGame: byGame.results || [], byVibe: byVibe.results || [] };
}

async function bumpDaily(env, metric, gameId = '') {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO daily_stats (day, metric, game_id, value) VALUES (?, ?, ?, 1)
     ON CONFLICT(day, metric, game_id) DO UPDATE SET value = value + 1`
  ).bind(todayKey(), metric, gameId || '').run();
}

/* ─── Auth helper для запросов с initData / cookie / anon ───────────────── */
async function resolveCaller(request, env) {
  const initData = request.headers.get('X-Init-Data') || '';
  const anonId = request.headers.get('X-Anon-Id') || null;
  let userId = null;
  let startParam = null;
  if (initData && env.TELEGRAM_BOT_TOKEN) {
    const v = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
    if (v?.user?.id) {
      userId = v.user.id;
      startParam = v.startParam;
      await upsertUser(env, v.user);
    }
  }
  // fallback на cookie-сессию от Login Widget
  if (!userId) {
    const sessTok = getCookieValue(request.headers.get('Cookie') || '', 'pu_sess');
    if (sessTok) {
      const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;
      const sess = await verifySession(sessTok, secret);
      if (sess?.uid) userId = sess.uid;
    }
  }
  if (!userId && anonId) await upsertAnon(env, anonId);
  return { userId, anonId, startParam };
}

/* ─── Telegram bot ───────────────────────────────────────────────────────── */
async function tg(env, method, payload) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  return res.json();
}

// Установить персональную menu-кнопку чата с ботом на Mini App.
// После этого у юзера всегда видна кнопка снизу-слева, тап → Mini App открывается мгновенно.
async function ensureMenuButton(env, chatId) {
  try {
    await tg(env, 'setChatMenuButton', {
      chat_id: chatId,
      menu_button: {
        type: 'web_app',
        text: '🎮 Играть',
        web_app: { url: env.WEBAPP_URL || WEBAPP_URL_DEFAULT },
      },
    });
  } catch (e) { console.error('setChatMenuButton', e); }
}

async function handleUpdate(update, env) {
  // inline-режим: @PartyUp_Gamebot <команда> → расширенный набор результатов.
  // См. src/worker-inline.js — поддерживает игры, карточки, вайбы, room <ID>, помощь.
  if (update.inline_query) {
    const q = update.inline_query;
    const results = buildInlineResults(env, q.query || '', directLink);
    await tg(env, 'answerInlineQuery', {
      inline_query_id: q.id,
      // cache_time = 0 для случайных карточек: важно, чтобы при следующем вызове
      // юзер получил другую карточку, а не закэшированную.
      cache_time: 0,
      is_personal: true,
      results,
      button: {
        text: 'Открыть PartyUp',
        // direct link к Mini App — Telegram откроет его, если юзер нажмёт на саму кнопку-подсказку.
        web_app: { url: env.WEBAPP_URL || WEBAPP_URL_DEFAULT },
      },
    });
    return;
  }

  // callback_query от inline-сообщений (монетка, кубики, выбор человека).
  // Используем inline_message_id для editMessageText — это позволяет
  // редактировать сообщения, отправленные через inline-режим в любой чат.
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = String(cb.data || '');
    const imid = cb.inline_message_id; // только для inline-сообщений
    const userName = cb.from?.first_name || 'Игрок';

    try {
      if (data === 'coin' && imid) {
        const result = Math.random() < 0.5 ? '🟡 Орёл' : '⚪ Решка';
        await tg(env, 'editMessageText', {
          inline_message_id: imid,
          parse_mode: 'HTML',
          text: `🪙 <b>${result}</b>\n\n${escapeHtml(userName)} подбросил${cb.from?.language_code === 'ru' ? '(а)' : ''} монетку.`,
          reply_markup: {
            inline_keyboard: [[
              { text: '🔄 Ещё раз', callback_data: 'coin' },
              { text: '🎮 PartyUp', url: directLink(env, 'coin') },
            ]],
          },
        });
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: result });
        return;
      }

      const diceMatch = data.match(/^dice_(\d+)$/);
      if (diceMatch && imid) {
        const sides = Math.min(1000, Math.max(2, Number(diceMatch[1])));
        const roll = 1 + Math.floor(Math.random() * sides);
        const emoji = sides === 2 ? (roll === 1 ? '🟦' : '🟥') :
                      sides === 6 ? ['','⚀','⚁','⚂','⚃','⚄','⚅'][roll] || '🎲' : '🎲';
        await tg(env, 'editMessageText', {
          inline_message_id: imid,
          parse_mode: 'HTML',
          text: `${emoji} <b>d${sides} → ${roll}</b>\n\n${escapeHtml(userName)} бросил${cb.from?.language_code === 'ru' ? '(а)' : ''} кубик.`,
          reply_markup: {
            inline_keyboard: [[
              { text: `🔄 Ещё раз d${sides}`, callback_data: `dice_${sides}` },
              { text: '🎮 PartyUp', url: directLink(env, 'dice') },
            ]],
          },
        });
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: `d${sides}: ${roll}` });
        return;
      }

      // Выбор случайного из тех, кто нажал «Я в деле».
      // Список участников храним в самом тексте сообщения (имена + zero-width-разделитель)
      // — это позволяет работать без БД и переживать рестарты worker'а.
      if (data === 'who_join' && imid) {
        const orig = cb.message?.text || '';
        // Парсим текущих участников из строки «Участники: A, B, C»
        const m = orig.match(/Участники:\s*(.+?)(?:\n|$)/);
        const list = m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!list.includes(userName)) list.push(userName);
        const newText =
          '🎯 <b>Кого выбираем?</b>\n\n' +
          'Жми «Я в деле», когда соберётесь — любой жмёт «Выбрать!».\n\n' +
          `Участники: ${list.join(', ')}`;
        await tg(env, 'editMessageText', {
          inline_message_id: imid,
          parse_mode: 'HTML',
          text: newText,
          reply_markup: {
            inline_keyboard: [
              [{ text: `✋ Я в деле (${list.length})`, callback_data: 'who_join' }],
              [{ text: '🎲 Выбрать!', callback_data: 'who_pick' }],
            ],
          },
        });
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'В деле!' });
        return;
      }

      if (data === 'who_pick' && imid) {
        const orig = cb.message?.text || '';
        const m = orig.match(/Участники:\s*(.+?)(?:\n|$)/);
        const list = m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!list.length) {
          await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Никто ещё не нажал «Я в деле»', show_alert: true });
          return;
        }
        const winner = list[Math.floor(Math.random() * list.length)];
        await tg(env, 'editMessageText', {
          inline_message_id: imid,
          parse_mode: 'HTML',
          text: `🎯 <b>Выбран: ${escapeHtml(winner)}</b>\n\nИз ${list.length}: ${list.join(', ')}`,
          reply_markup: {
            inline_keyboard: [[{ text: '🎮 PartyUp', url: directLink(env, 'pick') }]],
          },
        });
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: `Выбран: ${winner}` });
        return;
      }

      // Неизвестный callback — мягко закрываем «крутилку»
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
    } catch (e) {
      console.error('callback_query', e);
      try { await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Ошибка' }); } catch {}
    }
    return;
  }

  // chosen_inline_result — пользователь выбрал inline-результат и отправил его.
  // Логируем как share-событие, чтобы видеть какие команды реально используются.
  if (update.chosen_inline_result && env.DB) {
    const c = update.chosen_inline_result;
    try {
      await env.DB.prepare(
        `INSERT INTO events (ts, user_id, type, props) VALUES (?, ?, 'inline_chosen', ?)`
      ).bind(
        now(),
        c.from?.id || null,
        JSON.stringify({ resultId: c.result_id, query: c.query || '' }),
      ).run();
    } catch (e) { console.error('chosen_inline_result log', e); }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(/\s+/)[0].split('@')[0];
  const startArg = (text.split(/\s+/)[1] || '').trim() || null; // /start <param>

  // Кнопка «Играть» — используем direct link Mini App.
  // Это и web_app, и URL (Telegram сам откроет Mini App инлайн).
  const playButton = {
    inline_keyboard: [[{ text: '🎮 Открыть PartyUp', url: directLink(env, startArg || 'start') }]],
  };

  if (cmd === '/start' || cmd === '/play') {
    const firstName = msg.from?.first_name || 'друг';
    if (msg.from?.id) await upsertUser(env, msg.from);
    // Постоянная menu-кнопка → Mini App в один тап в любой момент.
    await ensureMenuButton(env, chatId);

    // /start auth_<token> — подтверждение логина с сайта.
    if (startArg && /^auth_[A-Za-z0-9]{8,40}$/.test(startArg) && msg.from?.id) {
      const token = startArg.slice(5);
      const row = await env.DB.prepare(
        `SELECT created_at, user_id FROM auth_tokens WHERE token = ?`
      ).bind(token).first();
      if (!row) {
        await tg(env, 'sendMessage', { chat_id: chatId,
          text: 'Ссылка не найдена. Открой сайт ещё раз и нажми «Войти через Telegram».' });
      } else if (now() - row.created_at > 5 * 60 * 1000) {
        await tg(env, 'sendMessage', { chat_id: chatId,
          text: 'Ссылка устарела. Открой сайт и попроси новый код.' });
      } else {
        await env.DB.prepare(
          `UPDATE auth_tokens SET user_id = ?, claimed_at = ? WHERE token = ?`
        ).bind(msg.from.id, now(), token).run();
        await tg(env, 'sendMessage', {
          chat_id: chatId, parse_mode: 'HTML',
          text: `✅ <b>Готово, ${escapeHtml(firstName)}!</b>\n\nВернись на сайт — сессия откроется автоматически.`,
        });
      }
      return;
    }

    // Если /start пришёл с параметром-комнатой — сразу шлём ссылку на эту комнату.
    if (startArg && /^room[_-][A-Z0-9]{4,12}$/i.test(startArg)) {
      const roomId = startArg.replace(/^room[_-]/i, '').toUpperCase();
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: `Тебя зовут в комнату <b>${escapeHtml(roomId)}</b> 🎮\nЖми, чтобы войти:`,
        reply_markup: {
          inline_keyboard: [[{ text: `🚪 Войти в ${roomId}`, url: directLink(env, `room_${roomId}`) }]],
        },
      });
      return;
    }

    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `Привет, <b>${escapeHtml(firstName)}</b> 🎉\n\n` +
        `<b>PartyUp</b> — 16 игр для весёлой компании в одном Mini App. ` +
        `Мафия, Бункер, Элиас, Шпион, Правда или действие и ещё 11.\n\n` +
        `⚡ Старт за 10 секунд — без регистраций\n` +
        `👥 От 2 до 20 игроков\n` +
        `🌶️ Вайбы: смешной, острый, для близких, 18+\n` +
        `🔗 Онлайн-комнаты — играй с друзьями по ссылке\n\n` +
        `Жми кнопку ниже или меню «🎮 Играть» в чате — Mini App откроется сразу.\n\n` +
        `💡 В любом чате набери <code>@${botUsername(env)} карточка</code> — кину случайный вопрос «Правды или действия» или «Я никогда не…».`,
      reply_markup: playButton,
    });
    return;
  }

  // /start support либо /support — пользователь хочет в поддержку.
  // Ставим pending-флаг; следующее сообщение пересылается админу.
  if ((cmd === '/start' && startArg === 'support') || cmd === '/support') {
    if (msg.from?.id && env.DB) {
      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS support_pending (tg_id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL)`
        ).run();
        await env.DB.prepare(
          `INSERT INTO support_pending (tg_id, started_at) VALUES (?, ?)
           ON CONFLICT(tg_id) DO UPDATE SET started_at = excluded.started_at`
        ).bind(msg.from.id, now()).run();
      } catch (e) { console.error('support flag', e); }
    }
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `📬 <b>Поддержка PartyUp</b>\n\n` +
        `Опиши проблему, идею или вопрос <b>одним сообщением</b> — я передам это автору. ` +
        `Можешь прикрепить скриншот.\n\n` +
        `<i>Если передумал — просто напиши /start, и забудем про это.</i>`,
    });
    return;
  }

  // Если для юзера выставлен support-флаг — следующее сообщение пересылаем админу.
  if (env.DB && msg.from?.id && msg.from.id !== ADMIN_USER_ID && !text.startsWith('/')) {
    try {
      const pending = await env.DB.prepare(
        `SELECT started_at FROM support_pending WHERE tg_id = ?`
      ).bind(msg.from.id).first();
      if (pending) {
        // Снимаем флаг.
        await env.DB.prepare(`DELETE FROM support_pending WHERE tg_id = ?`).bind(msg.from.id).run();
        // Пересылаем оригинальное сообщение админу (forwardMessage сохранит фото/файл).
        try {
          await tg(env, 'forwardMessage', {
            chat_id: ADMIN_USER_ID,
            from_chat_id: chatId,
            message_id: msg.message_id,
          });
        } catch {}
        // Доп.метаданные о юзере администратору.
        const u = msg.from;
        const meta =
          `📬 <b>Support</b> от @${u.username || '—'} (${u.first_name || ''} ${u.last_name || ''}, id=${u.id})\n` +
          `lang=${u.language_code || '?'}, premium=${u.is_premium ? '⭐' : '—'}`;
        try {
          await tg(env, 'sendMessage', {
            chat_id: ADMIN_USER_ID,
            parse_mode: 'HTML',
            text: meta,
          });
        } catch {}
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: '✅ Спасибо, передал. Я отвечу здесь же, в этом чате.',
        });
        return;
      }
    } catch (e) { console.error('support flow', e); }
  }

  // /vault — секретная админская команда, выдаёт ссылку с токеном только админу.
  if (cmd === '/vault') {
    if (msg.from?.id !== ADMIN_USER_ID) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: '🔒 Нет доступа.' });
      return;
    }
    const url = `${env.WEBAPP_URL || WEBAPP_URL_DEFAULT}/api/admin/vault?token=${encodeURIComponent(vaultToken(env))}`;
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `🗃 <b>Vault</b>\n\n` +
        `Открой ссылку в любом браузере (даже без авторизации):\n` +
        `<a href="${url}">${url}</a>\n\n` +
        `Токен встроен в ссылку. Не публикуй её.`,
      disable_web_page_preview: true,
    });
    return;
  }

  if (cmd === '/help') {
    await ensureMenuButton(env, chatId);
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `<b>Что умеет @${botUsername(env)}</b>\n\n` +
        `<b>В Mini App:</b>\n` +
        `• 16 игр для компании от 2 до 20 человек\n` +
        `• Локальный режим (один телефон) и онлайн-комнаты\n` +
        `• Умный подбор по вайбу и числу игроков\n\n` +
        `<b>В любом чате через inline (набирай @${botUsername(env)} …):</b>\n` +
        `• <code>правда</code> · <code>действие</code> · <code>никогда</code> · <code>скорее</code> — случайные карточки\n` +
        `• <code>карточка</code> — 4 случайные карточки разом\n` +
        `• <code>вайб смешной</code> / <code>вайб острый</code> — подборка игр\n` +
        `• <code>шпион</code>, <code>алиас</code>, <code>truth</code>… — карточка конкретной игры\n` +
        `• <code>монетка</code> — подбросить монетку\n` +
        `• <code>d20</code> — бросить кубик 1–20\n` +
        `• <code>дуэль</code> — мини-игра «кто быстрее тапнет»\n` +
        `• <code>room ABC123</code> — пригласить в свою комнату`,
      reply_markup: playButton,
    });
    return;
  }

  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Жми «🎮 Открыть PartyUp» 👇',
    reply_markup: playButton,
  });
}

/* ─── GameRoom Durable Object ────────────────────────────────────────────── */
export class GameRoom {
  constructor(state, env) { this.state = state; this.env = env; }

  async mirrorRoom(room) {
    if (!this.env.DB) return;
    const ts = now();
    await this.env.DB.prepare(
      `INSERT INTO rooms (id, host_user_id, game_id, vibe, rounds, state, round_index, players_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         game_id = excluded.game_id,
         vibe = excluded.vibe,
         rounds = excluded.rounds,
         state = excluded.state,
         round_index = excluded.round_index,
         players_count = excluded.players_count,
         updated_at = excluded.updated_at,
         ended_at = CASE WHEN excluded.state = 'ended' THEN excluded.updated_at ELSE rooms.ended_at END`
    ).bind(
      room.id,
      Number.isInteger(room.hostId) ? room.hostId : null,
      room.gameId || null,
      room.settings?.vibe || null,
      room.settings?.rounds || 6,
      room.state || 'lobby',
      room.roundIndex || 0,
      (room.players || []).length,
      room.createdAt || ts,
      ts,
    ).run();
  }

  async mirrorPlayer(roomId, player) {
    if (!this.env.DB) return;
    await this.env.DB.prepare(
      `INSERT INTO room_players (room_id, player_id, user_id, name, emoji, is_host, ready, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, player_id) DO UPDATE SET
         name = excluded.name,
         emoji = excluded.emoji,
         ready = excluded.ready`
    ).bind(
      roomId, player.id,
      Number.isInteger(player.userId) ? player.userId : null,
      player.name || null,
      player.emoji || null,
      player.isHost ? 1 : 0,
      player.ready ? 1 : 0,
      now(),
    ).run();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (method === 'GET' && url.pathname === '/state') {
      const room = await this.state.storage.get('room');
      if (!room) return corsJson({ error: 'room_not_found' }, 404);
      // 304 если клиент уже знает эту версию (экономит трафик, тело DO дешевле)
      const inm = request.headers.get('if-none-match');
      const tag = `"v${room.version || 0}"`;
      if (inm && inm === tag) {
        return new Response(null, { status: 304, headers: { ...CORS_HEADERS, ETag: tag, 'Cache-Control': 'no-store' } });
      }
      return new Response(JSON.stringify(room), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ETag: tag, 'Cache-Control': 'no-store' },
      });
    }

    if (method === 'POST' && url.pathname === '/init') {
      const body = await request.json();
      const ts = now();
      const room = {
        id: body.id,
        hostId: body.hostId,
        gameId: body.gameId,
        settings: body.settings || { rounds: 6, vibe: 'warmup' },
        players: body.players || [],
        state: 'lobby',
        roundIndex: 0,
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      };
      await this.state.storage.put('room', room);
      await this.mirrorRoom(room);
      for (const p of room.players) await this.mirrorPlayer(room.id, { ...p, isHost: p.id === room.hostId, ready: true });
      return corsJson(room);
    }

    if (method === 'POST' && url.pathname === '/join') {
      const body = await request.json();
      const room = await this.state.storage.get('room');
      if (!room) return corsJson({ error: 'room_not_found' }, 404);
      if (room.state !== 'lobby') return corsJson({ error: 'game_already_started' }, 400);
      const player = {
        id: body.id,
        name: body.name,
        emoji: body.emoji || '🎉',
        userId: body.userId || null,
        telegramId: body.telegramId || body.userId || null,
        photo_url: body.photo_url || null,
        username: body.username || null,
      };
      if (!room.players.some(p => p.id === player.id)) room.players.push(player);
      room.version = (room.version || 0) + 1;
      room.updatedAt = now();
      await this.state.storage.put('room', room);
      await this.mirrorRoom(room);
      await this.mirrorPlayer(room.id, { ...player, isHost: false, ready: true });
      return corsJson(room);
    }

    if (method === 'POST' && url.pathname === '/action') {
      const body = await request.json();
      const room = await this.state.storage.get('room');
      if (!room) return corsJson({ error: 'room_not_found' }, 404);
      if (body.state !== undefined) room.state = body.state;
      if (body.roundIndex !== undefined) {
        // Сменился индекс раунда — сбрасываем round-state.
        room.roundIndex = body.roundIndex;
        room.round = null;
      }
      // Per-round state (выбор «Правда/Действие», открытая карточка и т.д.)
      // Используется для синхронизации действий хода между игроками.
      if (body.round !== undefined) {
        room.round = body.round; // null → сброс, { choice, promptText, ... } → новое состояние
      }
      // Замер времени активного хода — фиксируем «когда игрок начал свой ход».
      // Клиент посылает duration (ms) при завершении хода — суммируем в плеер.
      if (body.playerTime && room.players) {
        const { playerId, ms } = body.playerTime;
        const p = room.players.find(x => x.id === playerId);
        if (p) p.activeMs = (p.activeMs || 0) + Math.max(0, Number(ms) || 0);
      }
      room.version = (room.version || 0) + 1;
      room.updatedAt = now();
      await this.state.storage.put('room', room);
      await this.mirrorRoom(room);
      return corsJson(room);
    }

    return corsJson({ error: 'not_found' }, 404);
  }
}

/* ─── API handlers ───────────────────────────────────────────────────────── */
// Telegram Login Widget. Юзер логинится через telegram.org/oauth, бот получает
// {id, first_name, last_name, username, photo_url, auth_date, hash}.
// Валидируем hash через HMAC-SHA256 с секретом = SHA256(bot_token).
// См. https://core.telegram.org/widgets/login#checking-authorization
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function validateWidgetData(data, botToken) {
  if (!data || !data.hash || !botToken) return null;
  const { hash, ...fields } = data;
  const dataCheckString = Object.keys(fields)
    .sort()
    .map(k => `${k}=${fields[k]}`)
    .join('\n');
  const enc = new TextEncoder();
  const secretKey = await sha256(enc.encode(botToken));
  const sig = await hmacSha256(secretKey, enc.encode(dataCheckString));
  const sigHex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sigHex !== hash) return null;
  // защита от старых auth_date (>24ч)
  if (fields.auth_date && (now() / 1000 - Number(fields.auth_date) > 24 * 3600)) return null;
  return {
    id: Number(fields.id),
    first_name: fields.first_name || '',
    last_name: fields.last_name || '',
    username: fields.username || '',
    photo_url: fields.photo_url || '',
  };
}

// Подписываем сессию своим HMAC, чтобы не таскать БД per-request.
async function signSession(payload, secret) {
  const body = btoa(JSON.stringify(payload));
  const sig = await hmacSha256(new TextEncoder().encode(secret), new TextEncoder().encode(body));
  const sigHex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${body}.${sigHex}`;
}

async function verifySession(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const enc = new TextEncoder();
  const expected = await hmacSha256(enc.encode(secret), enc.encode(body));
  const expectedHex = [...expected].map(b => b.toString(16).padStart(2, '0')).join('');
  if (expectedHex !== sig) return null;
  try {
    const data = JSON.parse(atob(body));
    if (data.exp && data.exp < Math.floor(now() / 1000)) return null;
    return data;
  } catch { return null; }
}

function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map(s => s.trim());
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0 && p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}

/* ─── Bot-driven login (нативное приложение Telegram) ────────────────────── */
// Сайт создаёт одноразовый токен, открывает t.me/<bot>?start=auth_<token>
// → нативный TG. Юзер жмёт «Старт», бот видит auth_<token> и проставляет
// user_id в auth_tokens. Сайт поллит /api/auth/poll и получает cookie.
const AUTH_TOKEN_TTL_SEC = 5 * 60;

function randomToken(n = 22) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}

async function handleAuthStart(request, env) {
  const token = randomToken();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO auth_tokens (token, created_at) VALUES (?, ?)`
  ).bind(token, ts).run();

  // Удаляем мусор (старые непринятые токены) лениво.
  await env.DB.prepare(
    `DELETE FROM auth_tokens WHERE created_at < ?`
  ).bind(ts - AUTH_TOKEN_TTL_SEC * 1000).run();

  const bot = botUsername(env);
  return corsJson({
    ok: true,
    token,
    deeplink_https: `https://t.me/${bot}?start=auth_${token}`,
    deeplink_tg: `tg://resolve?domain=${bot}&start=auth_${token}`,
    ttl: AUTH_TOKEN_TTL_SEC,
  });
}

async function handleAuthPoll(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const anonId = url.searchParams.get('anon') || request.headers.get('X-Anon-Id') || null;
  if (!token) return corsJson({ error: 'no_token' }, 400);
  const row = await env.DB.prepare(
    `SELECT user_id, created_at, claimed_at, consumed_at FROM auth_tokens WHERE token = ?`
  ).bind(token).first();
  if (!row) return corsJson({ status: 'unknown' }, 404);

  const ts = now();
  // протух
  if (ts - row.created_at > AUTH_TOKEN_TTL_SEC * 1000) {
    await env.DB.prepare(`DELETE FROM auth_tokens WHERE token = ?`).bind(token).run();
    return corsJson({ status: 'expired' });
  }
  // ждём подтверждения
  if (!row.user_id) return corsJson({ status: 'pending' });
  // уже использован — больше не отдаём cookie
  if (row.consumed_at) return corsJson({ status: 'consumed' });

  // помечаем как использованный и ставим cookie
  await env.DB.prepare(
    `UPDATE auth_tokens SET consumed_at = ? WHERE token = ?`
  ).bind(ts, token).run();

  // Если у юзера была анон-сессия в браузере — переносим стату в TG-аккаунт.
  if (anonId) {
    try { await migrateAnonToUser(env, anonId, row.user_id); } catch (e) { console.error('migrate', e); }
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE tg_id = ?').bind(row.user_id).first();
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;
  const exp = Math.floor(ts / 1000) + 30 * 86400;
  const sess = await signSession({ uid: row.user_id, exp }, secret);

  return new Response(JSON.stringify({ status: 'ok', user }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Set-Cookie': `pu_sess=${encodeURIComponent(sess)}; Path=/; Max-Age=${30 * 86400}; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

async function handleAuthWidget(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!env.TELEGRAM_BOT_TOKEN) return corsJson({ error: 'no_bot_token' }, 500);
  const validated = await validateWidgetData(body, env.TELEGRAM_BOT_TOKEN);
  if (!validated) return corsJson({ error: 'invalid_widget_data' }, 401);

  await upsertUser(env, validated);
  const user = await env.DB.prepare('SELECT * FROM users WHERE tg_id = ?').bind(validated.id).first();

  // подпишем сессию на 30 дней
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN; // fallback
  const exp = Math.floor(now() / 1000) + 30 * 86400;
  const token = await signSession({ uid: validated.id, exp }, secret);

  await bumpDaily(env, 'auth_widget');
  return new Response(JSON.stringify({ ok: true, mode: 'telegram', user }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Set-Cookie': `pu_sess=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 86400}; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

async function handleAuth(request, env) {
  const body = await request.json().catch(() => ({}));
  const initData = body.initData || request.headers.get('X-Init-Data') || '';
  const anonId = body.anonId || request.headers.get('X-Anon-Id') || null;

  // 1. Mini App initData (приоритет)
  if (initData && env.TELEGRAM_BOT_TOKEN) {
    const v = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
    if (v?.user?.id) {
      const user = await upsertUser(env, v.user);
      // Если был anon-id — переносим статистику в TG-аккаунт.
      let migration = null;
      if (anonId) migration = await migrateAnonToUser(env, anonId, v.user.id);
      await bumpDaily(env, 'auth');
      return corsJson({ ok: true, mode: 'telegram', user, startParam: v.startParam, migration });
    }
  }

  // 2. Cookie-сессия от bot-login (web-режим вне TG)
  const sessTok = getCookieValue(request.headers.get('Cookie') || '', 'pu_sess');
  if (sessTok) {
    const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;
    const sess = await verifySession(sessTok, secret);
    if (sess?.uid && env.DB) {
      const user = await env.DB.prepare('SELECT * FROM users WHERE tg_id = ?').bind(sess.uid).first();
      if (user) {
        let migration = null;
        if (anonId) migration = await migrateAnonToUser(env, anonId, sess.uid);
        return corsJson({ ok: true, mode: 'telegram', user, migration });
      }
    }
  }

  // 3. Anon
  if (anonId) {
    const user = await upsertAnon(env, anonId);
    return corsJson({ ok: true, mode: 'anon', anonId, user });
  }
  return corsJson({ error: 'no_credentials' }, 400);
}

// Серверная страховка от грязных имён: трим, удаление управляющих
// и потенциально опасных для разметки/JSON знаков, лимит длины.
function sanitizeDisplayName(raw, maxLen = 32) {
  if (raw == null) return '';
  let s = String(raw);
  s = s.replace(/[ -​-‏‪-‮⁦-⁩]/g, '');
  s = s.replace(/[<>`"'{}\\]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
    const code = s.charCodeAt(s.length - 1);
    if (code >= 0xD800 && code <= 0xDBFF) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

async function handleMeUpdate(request, env) {
  const { userId, anonId } = await resolveCaller(request, env);
  const body = await request.json().catch(() => ({}));
  const display = sanitizeDisplayName(body.display_name, 32);
  if (!display) return corsJson({ error: 'invalid_name' }, 400);

  if (userId) {
    await env.DB.prepare(`UPDATE users SET display_name = ?, last_seen_at = ? WHERE tg_id = ?`)
      .bind(display, now(), userId).run();
    return corsJson({ ok: true, mode: 'telegram', display_name: display });
  }
  if (anonId) {
    await env.DB.prepare(`UPDATE anon_users SET name = ?, last_seen_at = ? WHERE anon_id = ?`)
      .bind(display, now(), anonId).run();
    return corsJson({ ok: true, mode: 'anon', display_name: display });
  }
  return corsJson({ error: 'no_credentials' }, 401);
}

// Диагностика: кто я с точки зрения сервера.
async function handleWhoAmI(request, env) {
  const initData = request.headers.get('X-Init-Data') || '';
  const cookie = request.headers.get('Cookie') || '';
  const anonId = request.headers.get('X-Anon-Id') || null;
  const sessTok = getCookieValue(cookie, 'pu_sess');
  let initDataResult = null;
  if (initData && env.TELEGRAM_BOT_TOKEN) {
    const v = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
    initDataResult = v?.user?.id ? { ok: true, uid: v.user.id } : { ok: false };
  }
  let sessionResult = null;
  if (sessTok) {
    const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;
    const sess = await verifySession(sessTok, secret);
    sessionResult = sess?.uid ? { ok: true, uid: sess.uid } : { ok: false };
  }
  const { userId } = await resolveCaller(request, env);
  return corsJson({
    resolvedUserId: userId,
    isAdmin: userId === ADMIN_USER_ID,
    haveInitData: !!initData,
    initDataResult,
    haveSessionCookie: !!sessTok,
    sessionResult,
    haveAnonId: !!anonId,
  });
}

async function handleMe(request, env) {
  const { userId, anonId } = await resolveCaller(request, env);
  if (userId) {
    const user = await env.DB.prepare('SELECT * FROM users WHERE tg_id = ?').bind(userId).first();
    const stats = await getUserStats(env, userId);
    return corsJson({ mode: 'telegram', user, stats });
  }
  if (anonId) {
    const user = await env.DB.prepare('SELECT * FROM anon_users WHERE anon_id = ?').bind(anonId).first();
    const stats = await getAnonStats(env, anonId);
    return corsJson({ mode: 'anon', user, stats });
  }
  return corsJson({ mode: 'guest', user: null, stats: null });
}

async function handleTrack(request, env) {
  const body = await request.json().catch(() => ({}));
  const events = Array.isArray(body.events) ? body.events : (body.type ? [body] : []);
  if (!events.length) return corsJson({ ok: true, accepted: 0 });
  const { userId, anonId } = await resolveCaller(request, env);
  const ts = now();
  const stmts = events.map(e =>
    env.DB.prepare(
      `INSERT INTO events (ts, user_id, anon_id, session_id, room_id, type, game_id, vibe, props)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      e.ts || ts,
      userId || null,
      anonId || null,
      e.sessionId || null,
      e.roomId || null,
      String(e.type || 'unknown'),
      e.gameId || null,
      e.vibe || null,
      e.props ? JSON.stringify(e.props) : null,
    )
  );
  if (env.DB) await env.DB.batch(stmts);
  // лёгкая агрегация
  for (const e of events) {
    if (e.type === 'open') await bumpDaily(env, 'open');
    if (e.type === 'game_start') await bumpDaily(env, 'game_start', e.gameId || '');
    if (e.type === 'game_finish') await bumpDaily(env, 'game_finish', e.gameId || '');
  }
  return corsJson({ ok: true, accepted: events.length });
}

async function handleSessionStart(request, env) {
  const body = await request.json().catch(() => ({}));
  const { userId, anonId } = await resolveCaller(request, env);
  const id = body.id || crypto.randomUUID();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, anon_id, game_id, vibe, mode, players_count, rounds_total, room_id, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(
    id, userId || null, anonId || null,
    String(body.gameId || 'unknown'),
    body.vibe || null,
    body.mode || null,
    Number(body.playersCount) || null,
    Number(body.roundsTotal) || null,
    body.roomId || null,
    ts,
  ).run();

  if (Array.isArray(body.players)) {
    const stmts = body.players.map(p =>
      env.DB.prepare(
        `INSERT INTO session_players (session_id, player_local_id, user_id, name, emoji, score)
         VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(session_id, player_local_id) DO NOTHING`
      ).bind(id, p.id, p.userId || null, p.name || null, p.emoji || null)
    );
    if (stmts.length) await env.DB.batch(stmts);
  }
  return corsJson({ ok: true, sessionId: id });
}

async function handleSessionFinish(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.id) return corsJson({ error: 'missing_id' }, 400);
  const ts = now();
  const sess = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(body.id).first();
  if (!sess) return corsJson({ error: 'session_not_found' }, 404);
  const dur = Math.max(0, Math.round((ts - (sess.started_at || ts)) / 1000));
  await env.DB.prepare(
    `UPDATE sessions SET finished_at = ?, duration_sec = ?, rounds_played = ?, finished = 1 WHERE id = ?`
  ).bind(ts, dur, Number(body.roundsPlayed) || 0, body.id).run();

  if (body.scores && typeof body.scores === 'object') {
    const stmts = Object.entries(body.scores).map(([pid, score]) =>
      env.DB.prepare(
        `INSERT INTO session_players (session_id, player_local_id, score) VALUES (?, ?, ?)
         ON CONFLICT(session_id, player_local_id) DO UPDATE SET score = excluded.score`
      ).bind(body.id, pid, Number(score) || 0)
    );
    if (stmts.length) await env.DB.batch(stmts);
  }
  // Активное время игроков (сумма ms за их ходы) — для аналитики и титулов.
  if (body.activeTimes && typeof body.activeTimes === 'object') {
    const stmts = Object.entries(body.activeTimes).map(([pid, ms]) =>
      env.DB.prepare(
        `INSERT INTO session_players (session_id, player_local_id, active_ms) VALUES (?, ?, ?)
         ON CONFLICT(session_id, player_local_id) DO UPDATE SET active_ms = COALESCE(session_players.active_ms,0) + excluded.active_ms`
      ).bind(body.id, pid, Math.max(0, Number(ms) || 0))
    );
    if (stmts.length) await env.DB.batch(stmts);
  }

  // bump aggregate stats для зарегистрированного юзера
  if (sess.user_id) {
    const wins = body.winnerUserId === sess.user_id ? 1 : 0;
    await env.DB.prepare(
      `UPDATE users SET total_games = total_games + 1, total_wins = total_wins + ?, total_score = total_score + ? WHERE tg_id = ?`
    ).bind(wins, Number(body.totalScore) || 0, sess.user_id).run();
  }
  await bumpDaily(env, 'game_finish', sess.game_id || '');
  return corsJson({ ok: true });
}

// Список соигроков текущего юзера — все, кто был с ним в одной комнате.
// JOIN-self по room_players: rp1 = я, rp2 = другие в тех же комнатах.
async function handleFriends(request, env) {
  const { userId } = await resolveCaller(request, env);
  if (!userId) return corsJson({ ok: true, rows: [] });
  const rs = await env.DB.prepare(
    `SELECT rp2.user_id,
            COALESCE(u.display_name, u.first_name) AS display_name,
            u.username, u.photo_url,
            COUNT(DISTINCT rp2.room_id) AS games_together,
            MAX(rp2.joined_at) AS last_seen
     FROM room_players rp1
     JOIN room_players rp2 ON rp2.room_id = rp1.room_id AND rp2.user_id != rp1.user_id
     LEFT JOIN users u ON u.tg_id = rp2.user_id
     WHERE rp1.user_id = ? AND rp2.user_id IS NOT NULL
     GROUP BY rp2.user_id
     ORDER BY last_seen DESC
     LIMIT 50`
  ).bind(userId).all();
  return corsJson({ ok: true, rows: rs.results || [] });
}

/* ─── Cards: чтение из БД для фронта ─────────────────────────────────────── */
async function handleCardsRead(request, env) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get('game_id');
  const vibe = url.searchParams.get('vibe') || null;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 200)));
  if (!gameId) return corsJson({ error: 'missing_game_id' }, 400);

  // Если задан vibe — выберем карточки, у которых vibes (csv) содержит этот вибe,
  // плюс «нейтральные» (vibes IS NULL или пусто) для базы.
  const rs = vibe
    ? await env.DB.prepare(
        `SELECT id, type, text, vibes, intensity, meta
         FROM cards WHERE game_id = ? AND approved = 1
           AND (vibes IS NULL OR vibes = '' OR ',' || vibes || ',' LIKE ?)
         ORDER BY RANDOM() LIMIT ?`
      ).bind(gameId, `%,${vibe},%`, limit).all()
    : await env.DB.prepare(
        `SELECT id, type, text, vibes, intensity, meta
         FROM cards WHERE game_id = ? AND approved = 1
         ORDER BY RANDOM() LIMIT ?`
      ).bind(gameId, limit).all();

  return corsJson({
    ok: true,
    rows: (rs.results || []).map(r => ({
      ...r,
      vibes: r.vibes ? String(r.vibes).split(',').filter(Boolean) : null,
      meta: r.meta ? safeJson(r.meta) : null,
    })),
  });
}

/* ─── Hidden admin: панель управления ────────────────────────────────────── */
// Single-page admin: статистика + CRUD по cards/packs/users + просмотр
// sessions/events/rooms. Все эндпоинты ходят ТОЛЬКО в D1 — DO не дёргаем,
// кроме явного "force end" (опц., вне default UI).
//
// Авторизация: 1) ?token=<VAULT_TOKEN>, 2) tg_id == ADMIN_USER_ID
// (через Mini App initData или cookie pu_sess после bot-login).
const VAULT_PATH = '/api/admin/vault';
const ADMIN_PATH = '/api/admin';
const ADMIN_USER_ID = 265489213; // Danil Kolunov (@danil_kolunoff)
// Токен берём ТОЛЬКО из секрета окружения (wrangler secret put VAULT_TOKEN).
// Никакого fallback в коде, чтобы публичный репозиторий не выдавал секрет.
function vaultToken(env) { return env.VAULT_TOKEN || ''; }

// Гард: env-токен ИЛИ tg_id == ADMIN_USER_ID. Constant-time compare,
// чтобы по тайменгу нельзя было побрутить токен символ-за-символом.
function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function requireAdmin(request, env) {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token') || '';
  const real = vaultToken(env);
  if (real && queryToken && timingSafeEqual(queryToken, real)) {
    return { ok: true, userId: ADMIN_USER_ID };
  }
  const { userId } = await resolveCaller(request, env);
  if (userId === ADMIN_USER_ID) return { ok: true, userId };
  return { ok: false, response: corsJson({ error: 'forbidden' }, 403) };
}

// Mini App открывает админку через внешний браузер (tg.openLink), а тот
// не несёт ни X-Init-Data, ни cookie. Поэтому admin сначала фетчит этот
// эндпоинт ИЗ Mini App (с initData → server подтверждает что это он),
// получает токен, и потом открывает /api/admin/vault?token=... в браузере.
async function handleAdminIssueToken(request, env) {
  const { userId } = await resolveCaller(request, env);
  if (userId !== ADMIN_USER_ID) return corsJson({ error: 'forbidden' }, 403);
  const t = vaultToken(env);
  if (!t) return corsJson({ error: 'token_not_configured' }, 500);
  return adminJson({ ok: true, token: t });
}

function adminJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/* ─── Admin SPA (one-file vanilla JS) ────────────────────────────────────── */
const ADMIN_SPA_HTML = `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PartyUp · Admin</title>
<style>
:root { color-scheme: dark; --bg:#0c0b15; --s1:#15131f; --s2:#1c1929; --s3:#2a2640; --b:#3d3760; --t:#e8e5f2; --m:#8a85a3; --a:#a78bfa; --a2:#c084fc; --ok:#4ade80; --warn:#fb923c; --err:#ef4444; --tg:#2aabee; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: 14px/1.5 -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--t); }
.app { max-width: 1320px; margin: 0 auto; padding: 18px 22px 60px; }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--s3); margin-bottom: 18px; }
.tab { padding: 10px 16px; background: none; border: none; color: var(--m); font: inherit; cursor: pointer; border-bottom: 2px solid transparent; border-radius: 8px 8px 0 0; }
.tab:hover { color: var(--t); background: var(--s1); }
.tab.active { color: var(--a); border-bottom-color: var(--a); background: var(--s2); }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; color: var(--a); margin: 22px 0 10px; }
.muted { color: var(--m); font-size: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
input, select, textarea, button { background: var(--s3); color: var(--t); border: 1px solid var(--b); padding: 7px 10px; border-radius: 7px; font: inherit; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--a); outline-offset: -1px; border-color: transparent; }
textarea { width: 100%; min-height: 90px; font-family: ui-monospace, monospace; font-size: 12px; }
button { cursor: pointer; }
button:hover { background: var(--b); }
button.primary { background: linear-gradient(135deg, var(--a) 0%, #7c3aed 100%); border-color: transparent; font-weight: 600; }
button.primary:hover { filter: brightness(1.07); }
button.danger { background: #4b1d22; border-color: #6e2731; color: #fca5a5; }
button.danger:hover { background: #5d2429; }
button.ghost { background: transparent; }
button:disabled { opacity: .4; cursor: not-allowed; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px,1fr)); gap: 10px; }
.kpi { background: var(--s2); padding: 14px 16px; border-radius: 12px; border: 1px solid var(--s3); }
.kpi .v { font-size: 26px; font-weight: 700; color: var(--a2); line-height: 1.1; }
.kpi .l { font-size: 11px; color: var(--m); text-transform: uppercase; letter-spacing: .05em; margin-top: 4px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
.card { background: var(--s2); border: 1px solid var(--s3); border-radius: 12px; padding: 14px 16px; }
.bar { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.bar .label { width: 110px; font-size: 12px; color: var(--m); }
.bar .track { flex: 1; height: 8px; background: var(--s1); border-radius: 4px; overflow: hidden; }
.bar .fill { height: 100%; background: linear-gradient(90deg, var(--a), var(--a2)); }
.bar .n { width: 40px; text-align: right; font-variant-numeric: tabular-nums; color: var(--a2); font-weight: 600; }
.chart { width: 100%; }
.chart-grid { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(18px, 1fr); gap: 3px; align-items: end; height: 140px; padding-bottom: 28px; position: relative; }
.chart-bar { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; position: relative; }
.chart-bar-fill { width: 100%; min-height: 1px; background: linear-gradient(180deg, var(--a) 0%, #7c3aed 100%); border-radius: 4px 4px 0 0; transition: opacity .15s; }
.chart-bar:hover .chart-bar-fill { opacity: .8; }
.chart-bar-label { position: absolute; bottom: -22px; font-size: 9px; color: var(--m); transform: rotate(-30deg); transform-origin: top left; white-space: nowrap; }
.chart-bar-val { position: absolute; top: -16px; font-size: 9px; color: var(--a2); opacity: 0; transition: opacity .15s; }
.chart-bar:hover .chart-bar-val { opacity: 1; }
.cov-table th, .cov-table td { padding: 6px 10px; text-align: center; }
.cov-table th { font-size: 10px; color: var(--m); white-space: nowrap; }
.cov-table th:first-child, .cov-table td:first-child { text-align: left; }
.cov-table th.cov-adult { color: #f472b6; }
.cov-cell { font-variant-numeric: tabular-nums; font-size: 12px; }
.cov-zero { color: var(--m); opacity: .5; }
.cov-low  { color: #fbbf24; }
.cov-mid  { color: var(--a2); }
.cov-high { color: var(--ok); font-weight: 600; }
.cov-sum  { color: var(--t); font-weight: 700; border-left: 1px solid var(--s3); }
.filters { background: var(--s2); padding: 12px; border-radius: 12px; margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.filters input, .filters select { min-width: 0; }
table { width: 100%; border-collapse: collapse; background: var(--s1); border-radius: 10px; overflow: hidden; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--s3); vertical-align: top; font-size: 13px; }
th { background: var(--s2); font-size: 11px; color: var(--m); text-transform: uppercase; letter-spacing: .04em; }
tr:hover { background: var(--s2); }
td.id { font-family: ui-monospace, monospace; color: var(--m); font-size: 11px; white-space: nowrap; }
td.type { font-weight: 700; color: var(--a); white-space: nowrap; }
td.text { max-width: 480px; }
td.text textarea { width: 100%; min-height: 60px; }
td.acts { white-space: nowrap; }
td.acts button { padding: 4px 8px; font-size: 12px; }
.chip { display: inline-block; padding: 1px 7px; margin: 1px 2px 1px 0; background: var(--s3); border-radius: 100px; font-size: 11px; color: var(--a2); }
.chip.warn { background: #4b321d; color: #fbbf24; }
.chip.ok { background: #1d3b2a; color: var(--ok); }
.chip.adult { background: #4b1d3b; color: #f472b6; }
.intensity { font-weight: 700; font-variant-numeric: tabular-nums; }
.intensity-1 { color: var(--ok); } .intensity-2 { color: #84cc16; }
.intensity-3 { color: #facc15; } .intensity-4 { color: var(--warn); } .intensity-5 { color: var(--err); }
.empty { padding: 32px; text-align: center; color: var(--m); background: var(--s1); border-radius: 10px; }
.pager { display: flex; gap: 8px; align-items: center; margin-top: 10px; justify-content: center; }
.pager .info { color: var(--m); font-size: 12px; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: grid; place-items: center; padding: 20px; z-index: 100; }
.modal { background: var(--s2); border: 1px solid var(--s3); border-radius: 14px; padding: 18px; max-width: 600px; width: 100%; max-height: 90vh; overflow: auto; }
.modal h3 { margin: 0 0 14px; }
.form-row { display: grid; grid-template-columns: 110px 1fr; gap: 10px; align-items: center; margin-bottom: 10px; }
.form-row label { color: var(--m); font-size: 12px; }
.form-row input, .form-row select, .form-row textarea { width: 100%; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--s2); border: 1px solid var(--s3); padding: 10px 18px; border-radius: 10px; z-index: 200; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
.toast.err { border-color: var(--err); }
.toast.ok { border-color: var(--ok); }
.json { font-family: ui-monospace, monospace; font-size: 11px; color: var(--a2); white-space: pre-wrap; word-break: break-all; }
.sel { width: 18px; height: 18px; accent-color: var(--a); }
.tools { background: var(--s2); border: 1px solid var(--s3); padding: 10px 12px; border-radius: 10px; margin: 10px 0; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.tools .sep { width: 1px; background: var(--s3); height: 20px; }
.spin::after { content: '⏳'; margin-left: 6px; }
.k { font-family: ui-monospace, monospace; background: var(--s3); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
</style></head>
<body>
<div class="app">
  <div class="row" style="margin-bottom: 14px;">
    <h1>🎛 PartyUp Admin</h1>
    <span class="spacer"></span>
    <span class="muted" id="conn"></span>
  </div>
  <div class="tabs" id="tabs"></div>
  <div id="view"></div>
</div>
<script>
/* ─── helpers ──────────────────────────────────────────────────────────── */
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const $ = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => [...el.querySelectorAll(q)];
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'bigint') {
      el.appendChild(document.createTextNode(String(c)));
    } else {
      el.appendChild(c);
    }
  }
  return el;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toast = (msg, kind = '') => {
  const t = h('div', { class: 'toast ' + kind }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
};
const fmtTs = (ts) => {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
};
async function api(path, init = {}) {
  const url = path + (path.includes('?') ? '&' : '?') + (TOKEN ? 'token=' + encodeURIComponent(TOKEN) : '');
  const opts = { ...init, headers: { ...(init.headers || {}), 'Cache-Control': 'no-store' } };
  if (init.body && typeof init.body === 'object' && !(init.body instanceof FormData)) {
    opts.body = JSON.stringify(init.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const err = data.error || ('HTTP ' + r.status);
    toast(err, 'err');
    throw new Error(err);
  }
  return data;
}

/* ─── known taxonomy ───────────────────────────────────────────────────── */
const VIBES = ['warmup','funny','spicy','chill','new_people','deep','adult','ultra_adult'];
const GAMES_LIST = []; // заполняется из stats
const CARD_TYPES_BY_GAME = {}; // { game_id: ['Правда','Действие', ...] }
function typesForGame(game) {
  if (game && CARD_TYPES_BY_GAME[game]) return CARD_TYPES_BY_GAME[game];
  // union по всем играм
  const all = new Set();
  for (const arr of Object.values(CARD_TYPES_BY_GAME)) arr.forEach(t => all.add(t));
  return [...all].sort();
}
let LAST_STATS = null;

/* ─── tabs / routing ───────────────────────────────────────────────────── */
const TABS = [
  { id: 'dashboard', label: '📊 Дашборд' },
  { id: 'cards',     label: '🃏 Карточки' },
  { id: 'packs',     label: '📦 Паки' },
  { id: 'users',     label: '👤 Юзеры' },
  { id: 'sessions',  label: '🎮 Сессии' },
  { id: 'events',    label: '📡 События' },
  { id: 'rooms',     label: '🏠 Комнаты' },
];
let activeTab = location.hash.replace('#', '') || 'dashboard';
if (!TABS.find(t => t.id === activeTab)) activeTab = 'dashboard';

function renderTabs() {
  const wrap = $('#tabs'); wrap.innerHTML = '';
  TABS.forEach(t => {
    wrap.appendChild(h('button', {
      class: 'tab' + (t.id === activeTab ? ' active' : ''),
      onclick: () => { activeTab = t.id; location.hash = t.id; renderTabs(); render(); },
    }, t.label));
  });
}
function render() {
  const view = $('#view'); view.innerHTML = '';
  ({
    dashboard: viewDashboard, cards: viewCards, packs: viewPacks,
    users: viewUsers, sessions: viewSessions, events: viewEvents, rooms: viewRooms,
  })[activeTab](view);
}

/* ─── Dashboard ────────────────────────────────────────────────────────── */
function fmtDuration(sec) {
  sec = Number(sec) || 0;
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  if (h > 0) return h + 'ч ' + m + 'м';
  if (m > 0) return m + 'м';
  return sec + 'с';
}
function drawDayChart(rows, valueKey, opts) {
  // rows: [{day:'YYYY-MM-DD', <valueKey>: number}]
  const max = Math.max(1, ...rows.map(r => Number(r[valueKey]) || 0));
  const wrap = h('div', { class: 'chart' });
  const grid = h('div', { class: 'chart-grid' });
  rows.forEach(r => {
    const val = Number(r[valueKey]) || 0;
    const height = max ? Math.round(val / max * 100) : 0;
    const fmtVal = opts?.fmt ? opts.fmt(val) : String(val);
    const bar = h('div', { class: 'chart-bar' },
      h('div', { class: 'chart-bar-fill', style: 'height:' + height + '%', title: r.day + ' · ' + fmtVal }),
      h('div', { class: 'chart-bar-label' }, r.day.slice(5)),
      h('div', { class: 'chart-bar-val' }, fmtVal),
    );
    grid.appendChild(bar);
  });
  wrap.appendChild(grid);
  return wrap;
}
async function viewDashboard(root) {
  root.appendChild(h('div', { class: 'muted' }, 'Загружаем…'));
  try {
    const s = await api('/api/admin/stats');
    LAST_STATS = s;
    GAMES_LIST.length = 0;
    [...new Set((s.byGameVibe || []).map(r => r.game_id))].sort().forEach(g => GAMES_LIST.push(g));
    // строим карту cards.type по играм
    for (const k of Object.keys(CARD_TYPES_BY_GAME)) delete CARD_TYPES_BY_GAME[k];
    (s.cardTypes || []).forEach(r => {
      if (!CARD_TYPES_BY_GAME[r.game_id]) CARD_TYPES_BY_GAME[r.game_id] = [];
      CARD_TYPES_BY_GAME[r.game_id].push(r.type);
    });
    root.innerHTML = '';
    const c = s.counters;
    const kpis = [
      ['Юзеры', c.users],
      ['Сессии · сегодня', c.sessionsDay], ['Сессии · неделя', c.sessionsWeek],
      ['Сессии · всего', c.sessionsTotal], ['Активные комнаты', c.activeRooms],
      ['Событий', c.eventsTotal],
    ];
    root.appendChild(h('div', { class: 'kpis' }, kpis.map(([l,v]) =>
      h('div', { class: 'kpi' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'l' }, l))
    )));

    // Графики по дням
    root.appendChild(h('h2', {}, 'Активность за 30 дней'));
    const charts = h('div', { class: 'grid2' });
    charts.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('b', {}, 'Уникальные игроки (DAU)'),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('span', { class: 'muted' }, 'user_id или anon_id'),
      ),
      (s.dauByDay || []).length
        ? drawDayChart(s.dauByDay, 'dau')
        : h('div', { class: 'muted' }, 'Нет данных'),
    ));
    charts.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('b', {}, 'Время сессий (мин)'),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('span', { class: 'muted' }, 'sum(duration_sec)'),
      ),
      (s.sessTimeByDay || []).length
        ? drawDayChart(s.sessTimeByDay.map(r => ({ day: r.day, min: Math.round((r.sec || 0)/60) })), 'min', { fmt: v => v + 'м' })
        : h('div', { class: 'muted' }, 'Нет данных'),
    ));
    charts.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('b', {}, 'Сессии в день'),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('span', { class: 'muted' }, 'COUNT(sessions)'),
      ),
      (s.sessTimeByDay || []).length
        ? drawDayChart(s.sessTimeByDay, 'sessions')
        : h('div', { class: 'muted' }, 'Нет данных'),
    ));
    root.appendChild(charts);
    const maxG = Math.max(1, ...(s.topGames || []).map(r => r.n));
    const grid = h('div', { class: 'grid2' }); root.appendChild(grid);
    grid.appendChild(h('div', { class: 'card' },
      h('h2', {}, 'Топ игр (7д)'),
      ...(s.topGames || []).map(r => h('div', { class: 'bar' },
        h('div', { class: 'label' }, r.game_id),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + (r.n/maxG*100) + '%' })),
        h('div', { class: 'n' }, String(r.n)),
      )),
      (s.topGames||[]).length ? null : h('div', { class: 'muted' }, 'Пусто'),
    ));
    const maxV = Math.max(1, ...(s.topVibes || []).map(r => r.n));
    grid.appendChild(h('div', { class: 'card' },
      h('h2', {}, 'Топ вайбов (7д)'),
      ...(s.topVibes || []).map(r => h('div', { class: 'bar' },
        h('div', { class: 'label' }, r.vibe),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + (r.n/maxV*100) + '%' })),
        h('div', { class: 'n' }, String(r.n)),
      )),
      (s.topVibes||[]).length ? null : h('div', { class: 'muted' }, 'Пусто'),
    ));
    // Retention + avg-session + funnel — три карточки в ряд
    root.appendChild(h('h2', {}, 'Поведение пользователей'));
    const beh = h('div', { class: 'grid2' });
    // Retention
    const ret = s.retention || {};
    const retPct = (r, c) => c > 0 ? Math.round((r/c) * 100) + '%' : '—';
    beh.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('b', {}, 'Retention'),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('span', { class: 'muted' }, 'когорта = closed window'),
      ),
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' },
          h('div', { class: 'v' }, retPct(ret.ret_d1, ret.cohort_d1)),
          h('div', { class: 'l' }, 'D1 · ' + (ret.ret_d1 || 0) + '/' + (ret.cohort_d1 || 0))),
        h('div', { class: 'kpi' },
          h('div', { class: 'v' }, retPct(ret.ret_d7, ret.cohort_d7)),
          h('div', { class: 'l' }, 'D7 · ' + (ret.ret_d7 || 0) + '/' + (ret.cohort_d7 || 0))),
        h('div', { class: 'kpi' },
          h('div', { class: 'v' }, retPct(ret.ret_d30, ret.cohort_d30)),
          h('div', { class: 'l' }, 'D30 · ' + (ret.ret_d30 || 0) + '/' + (ret.cohort_d30 || 0))),
      ),
      h('div', { class: 'muted', style: 'margin-top:8px; font-size:11px' },
        'Когорта = юзеры, чей first-day прошёл ≥N дней назад. Returned = была сессия точно на first+N день.'),
    ));
    // Avg session
    const avg = s.avgSession || {};
    beh.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('b', {}, 'Средняя длина сессии'),
      ),
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' },
          h('div', { class: 'v' }, fmtDuration(Math.round(avg.all?.avg || 0))),
          h('div', { class: 'l' }, 'всё время · n=' + (avg.all?.n || 0))),
        h('div', { class: 'kpi' },
          h('div', { class: 'v' }, fmtDuration(Math.round(avg.week?.avg || 0))),
          h('div', { class: 'l' }, '7 дней · n=' + (avg.week?.n || 0))),
      ),
      h('div', { class: 'muted', style: 'margin-top:8px; font-size:11px' },
        'AVG(duration_sec) только по finished-сессиям. Сессии без finish дольше часа auto-закрываются sweep-job.'),
    ));
    // Funnel
    const funnelOrder = ['open', 'game_select', 'game_start', 'game_finish'];
    const funnelMap = new Map((s.funnel || []).map(r => [r.type, r.users]));
    const funnelTop = funnelMap.get('open') || 0;
    beh.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('b', {}, 'Воронка (7 дней, уникальные)'),
      ),
      ...funnelOrder.map((step, i) => {
        const n = funnelMap.get(step) || 0;
        const pct = funnelTop > 0 ? Math.round(n/funnelTop*100) : 0;
        const conv = i > 0 && funnelMap.get(funnelOrder[i-1])
          ? Math.round(n/funnelMap.get(funnelOrder[i-1])*100) : null;
        return h('div', { class: 'bar' },
          h('div', { class: 'label', style: 'width:130px' }, step),
          h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + pct + '%' })),
          h('div', { class: 'n', style: 'width: 80px' },
            String(n) + ' · ' + pct + '%' + (conv != null ? ' (→' + conv + '%)' : '')),
        );
      }),
      h('div', { class: 'muted', style: 'margin-top:8px; font-size:11px' },
        'COUNT(DISTINCT user|anon) по событиям. Если каких-то шагов нет — клиент их пока не шлёт.'),
    ));
    root.appendChild(beh);

    // Event types — общая аналитика
    root.appendChild(h('h2', {}, 'События по типам (всё время)'));
    const evWrap = h('div', { class: 'card', style: 'padding: 12px;' });
    const evMax = Math.max(1, ...(s.eventTypes || []).map(r => r.n));
    if (!(s.eventTypes || []).length) evWrap.appendChild(h('div', { class: 'muted' }, 'Нет данных'));
    else (s.eventTypes || []).forEach(r => {
      evWrap.appendChild(h('div', { class: 'bar' },
        h('div', { class: 'label', style: 'width:160px' }, r.type),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + (r.n/evMax*100) + '%' })),
        h('div', { class: 'n' }, String(r.n)),
      ));
    });
    root.appendChild(evWrap);
    // Покрытие контента: матрица «игра × вайб». Карточки могут иметь несколько
    // тегов сразу — суммируем по каждому, чтобы видеть реальный пул на вайб.
    root.appendChild(h('h2', {}, 'Покрытие контента'));
    const byGV = s.byGameVibe || [];
    const games = [...new Set(byGV.map(r => r.game_id))].sort();
    const pivot = {}; // pivot[game][vibe] = n
    const noTag = {}; // карточки без вайба
    games.forEach(g => { pivot[g] = {}; noTag[g] = 0; });
    byGV.forEach(r => {
      const vibes = (r.vibes || '').split(',').filter(Boolean);
      if (!vibes.length) noTag[r.game_id] = (noTag[r.game_id] || 0) + r.n;
      else vibes.forEach(v => { pivot[r.game_id][v] = (pivot[r.game_id][v] || 0) + r.n; });
    });
    // Колонки = ВСЕ известные вайбы + «без тега». Гарантируем стабильный порядок.
    const cov = h('div', { class: 'card', style: 'padding: 0; overflow: auto;' });
    const cellClass = (n) => n === 0 ? 'cov-zero' : n < 20 ? 'cov-low' : n < 60 ? 'cov-mid' : 'cov-high';
    cov.appendChild(h('table', { class: 'cov-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Игра'),
        ...VIBES.map(v => h('th', { class: v==='adult'||v==='ultra_adult' ? 'cov-adult' : null }, v)),
        h('th', {}, '∅'),
        h('th', {}, 'Σ'),
      )),
      h('tbody', {}, games.map(g => {
        const total = VIBES.reduce((s, v) => s + (pivot[g][v] || 0), 0) + (noTag[g] || 0);
        return h('tr', {},
          h('td', { class: 'type' }, g),
          ...VIBES.map(v => {
            const n = pivot[g][v] || 0;
            return h('td', { class: 'cov-cell ' + cellClass(n) }, n ? String(n) : '·');
          }),
          h('td', { class: 'cov-cell ' + cellClass(noTag[g] || 0) }, noTag[g] ? String(noTag[g]) : '·'),
          h('td', { class: 'cov-cell cov-sum' }, String(total)),
        );
      })),
    ));
    root.appendChild(cov);
    root.appendChild(h('h2', {}, 'Последние сессии'));
    const rs = h('div', { class: 'card', style: 'padding: 0; overflow: auto;' });
    rs.appendChild(h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Когда'), h('th', {}, 'Игра'), h('th', {}, 'Вайб'),
        h('th', {}, 'Режим'), h('th', {}, 'Игроков'), h('th', {}, '✓'),
      )),
      h('tbody', {}, (s.recentSessions || []).map(r => h('tr', {},
        h('td', { class: 'id' }, fmtTs(r.started_at)),
        h('td', { class: 'type' }, r.game_id || '—'),
        h('td', {}, r.vibe || ''),
        h('td', {}, r.mode || ''),
        h('td', {}, String(r.players_count || 0)),
        h('td', {}, r.finished ? h('span', { class: 'chip ok' }, 'finished') : h('span', { class: 'chip warn' }, 'open')),
      ))),
    ));
    root.appendChild(rs);
  } catch (e) {
    root.innerHTML = ''; root.appendChild(h('div', { class: 'empty' }, 'Ошибка: ' + e.message));
  }
}

/* ─── Cards ────────────────────────────────────────────────────────────── */
const cardsState = { game: '', vibe: '', type: '', intensity: '', approved: '', q: '', limit: 50, offset: 0, total: 0, rows: [], sel: new Set() };
async function loadCards() {
  const qs = new URLSearchParams();
  for (const k of ['game','vibe','type','intensity','approved','q']) {
    if (cardsState[k]) qs.set(k === 'game' ? 'game_id' : k, cardsState[k]);
  }
  qs.set('limit', cardsState.limit); qs.set('offset', cardsState.offset);
  const d = await api('/api/admin/cards?' + qs.toString());
  cardsState.rows = d.rows; cardsState.total = d.total;
  cardsState.sel = new Set([...cardsState.sel].filter(id => d.rows.find(r => r.id === id)));
}
function viewCards(root) {
  const filters = h('div', { class: 'filters' });
  const selGame = h('select', { onchange: (e) => { cardsState.game = e.target.value; cardsState.offset = 0; refresh(); } });
  selGame.appendChild(h('option', { value: '' }, '— любая игра —'));
  GAMES_LIST.forEach(g => selGame.appendChild(h('option', { value: g, selected: g === cardsState.game ? 'selected' : null }, g)));
  filters.appendChild(selGame);

  const selVibe = h('select', { onchange: (e) => { cardsState.vibe = e.target.value; cardsState.offset = 0; refresh(); } });
  selVibe.appendChild(h('option', { value: '' }, '— любой вайб —'));
  selVibe.appendChild(h('option', { value: '__none__' }, '(без вайба)'));
  VIBES.forEach(v => selVibe.appendChild(h('option', { value: v, selected: v === cardsState.vibe ? 'selected' : null }, v)));
  filters.appendChild(selVibe);

  // Type — дропдаун из реальных значений в БД (зависит от выбранной игры).
  const selType = h('select', { onchange: (e) => { cardsState.type = e.target.value; cardsState.offset = 0; refresh(); } });
  selType.appendChild(h('option', { value: '' }, '— любой type —'));
  typesForGame(cardsState.game).forEach(t => selType.appendChild(h('option', { value: t, selected: t === cardsState.type ? 'selected' : null }, t)));
  filters.appendChild(selType);

  // Интенсивность 1..5 — «мягко → жёстко». Отдельный лейбл, чтобы не путать.
  const selI = h('select', {
    title: 'Интенсивность: 1 — мягко · 5 — жёстко',
    onchange: (e) => { cardsState.intensity = e.target.value; cardsState.offset = 0; refresh(); },
  });
  selI.appendChild(h('option', { value: '' }, 'Интенсивность'));
  ['1 — мягко', '2 — лайт', '3 — средне', '4 — острое', '5 — жёстко'].forEach((label, idx) => {
    const v = idx + 1;
    selI.appendChild(h('option', { value: v, selected: String(v) === cardsState.intensity ? 'selected' : null }, label));
  });
  filters.appendChild(selI);
  const selA = h('select', { onchange: (e) => { cardsState.approved = e.target.value; cardsState.offset = 0; refresh(); } });
  selA.appendChild(h('option', { value: '' }, '— approved —'));
  selA.appendChild(h('option', { value: '1', selected: cardsState.approved === '1' ? 'selected' : null }, '✓ одобрено'));
  selA.appendChild(h('option', { value: '0', selected: cardsState.approved === '0' ? 'selected' : null }, '✗ не одобрено'));
  filters.appendChild(selA);

  const search = h('input', { placeholder: 'поиск по тексту…', value: cardsState.q, style: 'flex:1; min-width: 180px;' });
  search.addEventListener('input', (e) => { cardsState.q = e.target.value; });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { cardsState.offset = 0; refresh(); } });
  filters.appendChild(search);

  filters.appendChild(h('button', { onclick: () => { cardsState.offset = 0; refresh(); } }, 'Найти'));
  filters.appendChild(h('button', { class: 'primary', onclick: openCreateCard }, '+ Создать'));
  filters.appendChild(h('button', { onclick: openBulkImport }, '📥 Импорт JSON'));
  root.appendChild(filters);

  const tools = h('div', { class: 'tools' });
  tools.appendChild(h('span', { class: 'muted', id: 'cs-info' }));
  tools.appendChild(h('span', { class: 'spacer', style: 'flex:1' }));
  tools.appendChild(h('button', { onclick: () => bulkAction('approve') }, '✓ Одобрить'));
  tools.appendChild(h('button', { onclick: () => bulkAction('unapprove') }, '✗ Снять'));
  tools.appendChild(h('span', { class: 'sep' }));
  tools.appendChild(h('button', { class: 'danger', onclick: () => bulkAction('delete') }, '🗑 Удалить'));
  root.appendChild(tools);

  const tableWrap = h('div', { id: 'cards-table' });
  root.appendChild(tableWrap);
  const pager = h('div', { class: 'pager', id: 'cards-pager' });
  root.appendChild(pager);

  async function refresh() {
    tableWrap.innerHTML = '<div class="muted" style="padding:10px">Загружаем…</div>';
    try {
      await loadCards();
      drawTable();
    } catch (e) { tableWrap.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>'; }
  }

  function drawTable() {
    $('#cs-info').textContent = 'Выбрано: ' + cardsState.sel.size + ' · показано ' + cardsState.rows.length + ' из ' + cardsState.total;
    if (!cardsState.rows.length) { tableWrap.innerHTML = ''; tableWrap.appendChild(h('div', { class: 'empty' }, 'Нет карточек по фильтрам')); pager.innerHTML = ''; return; }
    const cbAll = h('input', { type: 'checkbox', class: 'sel', onchange: (e) => {
      if (e.target.checked) cardsState.rows.forEach(r => cardsState.sel.add(r.id));
      else cardsState.rows.forEach(r => cardsState.sel.delete(r.id));
      drawTable();
    }});
    cbAll.checked = cardsState.rows.every(r => cardsState.sel.has(r.id));
    const tbl = h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { style: 'width:24px' }, cbAll),
        h('th', { style: 'width:50px' }, 'id'),
        h('th', { style: 'width:90px' }, 'game'),
        h('th', { style: 'width:90px' }, 'type'),
        h('th', {}, 'text'),
        h('th', { style: 'width:180px' }, 'vibes'),
        h('th', { style: 'width:40px' }, 'I'),
        h('th', { style: 'width:60px' }, '✓'),
        h('th', { style: 'width:130px' }, ''),
      )),
      h('tbody', {}, cardsState.rows.map(r => cardRow(r, drawTable))),
    );
    tableWrap.innerHTML = ''; tableWrap.appendChild(tbl);

    pager.innerHTML = '';
    pager.appendChild(h('button', { onclick: () => { if (cardsState.offset > 0) { cardsState.offset = Math.max(0, cardsState.offset - cardsState.limit); refresh(); } }, disabled: cardsState.offset === 0 ? '' : null }, '← Назад'));
    pager.appendChild(h('div', { class: 'info' }, (cardsState.offset+1) + '–' + Math.min(cardsState.offset + cardsState.rows.length, cardsState.total) + ' / ' + cardsState.total));
    pager.appendChild(h('button', { onclick: () => { if (cardsState.offset + cardsState.limit < cardsState.total) { cardsState.offset += cardsState.limit; refresh(); } }, disabled: cardsState.offset + cardsState.rows.length >= cardsState.total ? '' : null }, 'Вперёд →'));
    pager.appendChild(h('select', { onchange: (e) => { cardsState.limit = Number(e.target.value); cardsState.offset = 0; refresh(); } },
      ...[25,50,100,200].map(n => h('option', { value: n, selected: cardsState.limit === n ? 'selected' : null }, n + '/стр'))));
  }

  async function bulkAction(action) {
    const ids = [...cardsState.sel];
    if (!ids.length) return toast('Ничего не выбрано', 'err');
    if (action === 'delete' && !confirm('Удалить ' + ids.length + ' карточек? Это необратимо.')) return;
    try {
      const r = await api('/api/admin/cards/bulk', { method: 'POST', body: { action, ids } });
      toast('Готово: ' + (r.deleted || r.updated || 0), 'ok');
      cardsState.sel.clear();
      refresh();
    } catch {}
  }

  refresh();
}

function cardRow(r, redraw) {
  const cb = h('input', { type: 'checkbox', class: 'sel', onchange: (e) => {
    if (e.target.checked) cardsState.sel.add(r.id); else cardsState.sel.delete(r.id);
  }});
  cb.checked = cardsState.sel.has(r.id);
  const tr = h('tr', {},
    h('td', {}, cb),
    h('td', { class: 'id' }, '#' + r.id),
    h('td', { class: 'type' }, r.game_id || ''),
    h('td', {}, r.type || ''),
    h('td', { class: 'text' }, r.text || ''),
    h('td', {}, (r.vibes || []).length
      ? (r.vibes.map(v => h('span', { class: 'chip' + (v==='adult'||v==='ultra_adult' ? ' adult' : '') }, v)))
      : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'intensity intensity-' + (r.intensity || 2) }, String(r.intensity || 2)),
    h('td', {}, r.approved ? h('span', { class: 'chip ok' }, '✓') : h('span', { class: 'chip warn' }, '✗')),
    h('td', { class: 'acts' },
      h('button', { onclick: () => openEditCard(r, redraw) }, '✎'),
      ' ',
      h('button', { onclick: () => duplicateCard(r, redraw) }, '⎘'),
      ' ',
      h('button', { class: 'danger', onclick: async () => {
        if (!confirm('Удалить #' + r.id + '?')) return;
        await api('/api/admin/cards/' + r.id, { method: 'DELETE' });
        toast('Удалено', 'ok'); cardsState.rows = cardsState.rows.filter(x => x.id !== r.id); redraw();
      }}, '🗑'),
    ),
  );
  return tr;
}

async function duplicateCard(r, redraw) {
  const payload = { game_id: r.game_id, type: r.type, text: r.text + ' (копия)', vibes: r.vibes, intensity: r.intensity, meta: r.meta, pack_id: r.pack_id, approved: !!r.approved };
  await api('/api/admin/cards', { method: 'POST', body: payload });
  toast('Создана копия', 'ok');
  // обновим список с нуля
  if (typeof redraw === 'function') {
    cardsState.offset = 0;
    await loadCards();
    render();
  }
}

function openCreateCard() { openCardModal(null); }
function openEditCard(r) { openCardModal(r); }
function openCardModal(r) {
  const isEdit = !!r;
  const data = r ? { ...r, vibes: (r.vibes || []).join(',') } : { game_id: cardsState.game || '', type: '', text: '', vibes: cardsState.vibe && cardsState.vibe !== '__none__' ? cardsState.vibe : '', intensity: 2, approved: true, meta: null, pack_id: null };
  const inp = (k, type = 'input', extra = {}) => {
    const el = h(type === 'textarea' ? 'textarea' : type, { value: data[k] ?? '', ...extra });
    el.oninput = (e) => data[k] = e.target.value;
    if (type === 'textarea') el.textContent = data[k] ?? '';
    return el;
  };
  const metaTa = h('textarea', { placeholder: '{} или пусто' }, data.meta ? JSON.stringify(data.meta, null, 2) : '');
  const approvedCb = h('input', { type: 'checkbox' }); approvedCb.checked = !!data.approved;
  const intensityIn = h('input', { type: 'number', min: 1, max: 5, value: data.intensity || 2 });
  const gameIn = h('input', { value: data.game_id || '' });
  const typeIn = h('input', { value: data.type || '' });
  const textTa = h('textarea', {}, data.text || '');
  const vibesIn = h('input', { value: data.vibes || '', placeholder: 'csv: warmup,funny' });
  const packIn = h('input', { value: data.pack_id || '', placeholder: 'pack id (опционально)' });

  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
  const modal = h('div', { class: 'modal' });
  modal.appendChild(h('h3', {}, isEdit ? 'Редактировать #' + r.id : 'Новая карточка'));
  const rows = [
    ['game_id *', gameIn], ['type', typeIn], ['text *', textTa],
    ['vibes', vibesIn], ['intensity', intensityIn],
    ['approved', approvedCb], ['pack_id', packIn], ['meta (JSON)', metaTa],
  ];
  rows.forEach(([l, el]) => modal.appendChild(h('div', { class: 'form-row' }, h('label', {}, l), el)));
  const row = h('div', { class: 'row', style: 'justify-content: flex-end; gap: 8px; margin-top: 12px;' });
  row.appendChild(h('button', { onclick: () => bg.remove() }, 'Отмена'));
  row.appendChild(h('button', { class: 'primary', onclick: async () => {
    const payload = {
      game_id: gameIn.value.trim(),
      type: typeIn.value.trim() || null,
      text: textTa.value.trim(),
      vibes: vibesIn.value.split(',').map(s => s.trim()).filter(Boolean),
      intensity: Number(intensityIn.value) || 2,
      approved: approvedCb.checked,
      pack_id: packIn.value.trim() || null,
    };
    if (metaTa.value.trim()) {
      try { payload.meta = JSON.parse(metaTa.value); }
      catch { return toast('meta: невалидный JSON', 'err'); }
    } else payload.meta = null;
    if (!payload.game_id || !payload.text) return toast('Заполни game_id и text', 'err');
    try {
      if (isEdit) await api('/api/admin/cards/' + r.id, { method: 'PATCH', body: payload });
      else await api('/api/admin/cards', { method: 'POST', body: payload });
      toast(isEdit ? 'Сохранено' : 'Создано', 'ok');
      bg.remove();
      await loadCards(); render();
    } catch {}
  }}, 'Сохранить'));
  modal.appendChild(row);
  bg.appendChild(modal); document.body.appendChild(bg);
}

function openBulkImport() {
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
  const ta = h('textarea', { placeholder: '[{"game_id":"truth","type":"Правда","text":"…","vibes":["warmup"],"intensity":2}, …]', style: 'min-height:300px' });
  const modal = h('div', { class: 'modal' },
    h('h3', {}, 'Импорт JSON-массива'),
    h('p', { class: 'muted' }, 'Каждый элемент — карточка. Обязательно: game_id, text. По умолчанию approved=true, source="admin_bulk".'),
    ta,
    h('div', { class: 'row', style: 'justify-content: flex-end; gap: 8px; margin-top: 12px;' },
      h('button', { onclick: () => bg.remove() }, 'Отмена'),
      h('button', { class: 'primary', onclick: async () => {
        let items;
        try { items = JSON.parse(ta.value); }
        catch { return toast('Невалидный JSON', 'err'); }
        if (!Array.isArray(items) || !items.length) return toast('Нужен непустой массив', 'err');
        try {
          const r = await api('/api/admin/cards/bulk', { method: 'POST', body: { action: 'import', items } });
          toast('Импортировано: ' + r.inserted, 'ok');
          bg.remove();
          await loadCards(); render();
        } catch {}
      }}, 'Импортировать')),
  );
  bg.appendChild(modal); document.body.appendChild(bg);
}

/* ─── Packs ────────────────────────────────────────────────────────────── */
async function viewPacks(root) {
  root.appendChild(h('div', { class: 'tools' },
    h('span', { class: 'muted' }, 'Паки карточек (id, title, game_id, vibe, premium, price_stars).'),
    h('span', { class: 'spacer', style: 'flex:1' }),
    h('button', { class: 'primary', onclick: () => openPackModal(null) }, '+ Новый pack'),
  ));
  const wrap = h('div', {}); root.appendChild(wrap);
  async function refresh() {
    wrap.innerHTML = '<div class="muted">Загружаем…</div>';
    try {
      const d = await api('/api/admin/packs');
      wrap.innerHTML = '';
      if (!d.rows.length) { wrap.appendChild(h('div', { class: 'empty' }, 'Пусто. Создай первый pack.')); return; }
      wrap.appendChild(h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'id'), h('th', {}, 'title'), h('th', {}, 'game'), h('th', {}, 'vibe'),
          h('th', {}, 'premium'), h('th', {}, '★ цена'), h('th', {}, 'карт'), h('th', {}, ''),
        )),
        h('tbody', {}, d.rows.map(p => h('tr', {},
          h('td', { class: 'id' }, p.id),
          h('td', {}, p.title),
          h('td', { class: 'type' }, p.game_id || '—'),
          h('td', {}, p.vibe || '—'),
          h('td', {}, p.is_premium ? h('span', { class: 'chip warn' }, '★') : ''),
          h('td', {}, String(p.price_stars || 0)),
          h('td', { class: 'intensity intensity-2' }, String(p.cards_count || 0)),
          h('td', { class: 'acts' },
            h('button', { onclick: () => openPackModal(p, refresh) }, '✎'),
            ' ',
            h('button', { class: 'danger', onclick: async () => {
              if (!confirm('Удалить pack «' + p.id + '»? Карточки отвяжутся, но не удалятся.')) return;
              await api('/api/admin/packs/' + encodeURIComponent(p.id), { method: 'DELETE' });
              toast('Удалено', 'ok'); refresh();
            }}, '🗑'),
          ),
        ))),
      ));
    } catch (e) { wrap.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>'; }
  }
  refresh();
  window._packsRefresh = refresh;
}
function openPackModal(p, refresh) {
  const isEdit = !!p;
  const data = p ? { ...p } : { id: '', title: '', description: '', game_id: '', vibe: '', is_premium: false, price_stars: 0 };
  const idIn = h('input', { value: data.id, disabled: isEdit ? '' : null });
  const titleIn = h('input', { value: data.title || '' });
  const descIn = h('textarea', {}, data.description || '');
  const gameIn = h('input', { value: data.game_id || '' });
  const vibeIn = h('input', { value: data.vibe || '' });
  const premCb = h('input', { type: 'checkbox' }); premCb.checked = !!data.is_premium;
  const priceIn = h('input', { type: 'number', min: 0, value: data.price_stars || 0 });
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
  const modal = h('div', { class: 'modal' });
  modal.appendChild(h('h3', {}, isEdit ? 'Редактировать pack «' + p.id + '»' : 'Новый pack'));
  [['id *', idIn], ['title *', titleIn], ['description', descIn], ['game_id', gameIn],
   ['vibe', vibeIn], ['premium', premCb], ['★ цена', priceIn]
  ].forEach(([l, el]) => modal.appendChild(h('div', { class: 'form-row' }, h('label', {}, l), el)));
  modal.appendChild(h('div', { class: 'row', style: 'justify-content: flex-end; gap: 8px; margin-top: 12px;' },
    h('button', { onclick: () => bg.remove() }, 'Отмена'),
    h('button', { class: 'primary', onclick: async () => {
      const payload = {
        id: idIn.value.trim(), title: titleIn.value.trim(),
        description: descIn.value.trim() || null,
        game_id: gameIn.value.trim() || null, vibe: vibeIn.value.trim() || null,
        is_premium: premCb.checked, price_stars: Number(priceIn.value) || 0,
      };
      if (isEdit) {
        delete payload.id;
        await api('/api/admin/packs/' + encodeURIComponent(p.id), { method: 'PATCH', body: payload });
      } else {
        if (!payload.id || !payload.title) return toast('id и title обязательны', 'err');
        await api('/api/admin/packs', { method: 'POST', body: payload });
      }
      toast('Сохранено', 'ok'); bg.remove(); (refresh || window._packsRefresh)?.();
    }}, 'Сохранить'),
  ));
  bg.appendChild(modal); document.body.appendChild(bg);
}

/* ─── Users ────────────────────────────────────────────────────────────── */
const usersState = { q: '', sort: 'playtime', limit: 50, offset: 0 };
async function viewUsers(root) {
  const f = h('div', { class: 'filters' });
  const q = h('input', { placeholder: 'Поиск по нику / имени / tg_id…', value: usersState.q, style: 'flex:1; min-width:200px' });
  q.oninput = (e) => usersState.q = e.target.value;
  q.onkeydown = (e) => { if (e.key === 'Enter') { usersState.offset = 0; refresh(); } };
  f.appendChild(q);
  const sortSel = h('select', { onchange: (e) => { usersState.sort = e.target.value; usersState.offset = 0; refresh(); } });
  [
    ['playtime', '⏱ по игровому времени'],
    ['games', '🎮 по числу игр'],
    ['recent', '👁 по last_seen'],
    ['created', '✨ по дате регистрации'],
  ].forEach(([v, l]) => sortSel.appendChild(h('option', { value: v, selected: v === usersState.sort ? 'selected' : null }, l)));
  f.appendChild(sortSel);
  f.appendChild(h('button', { onclick: () => { usersState.offset = 0; refresh(); } }, 'Найти'));
  root.appendChild(f);
  const wrap = h('div'); root.appendChild(wrap);
  const pager = h('div', { class: 'pager' }); root.appendChild(pager);
  async function refresh() {
    wrap.innerHTML = '<div class="muted">Загружаем…</div>';
    try {
      const qs = new URLSearchParams();
      if (usersState.q) qs.set('q', usersState.q);
      qs.set('sort', usersState.sort);
      qs.set('limit', usersState.limit); qs.set('offset', usersState.offset);
      const d = await api('/api/admin/users?' + qs.toString());
      wrap.innerHTML = '';
      if (!d.rows.length) { wrap.appendChild(h('div', { class: 'empty' }, 'Нет юзеров')); pager.innerHTML = ''; return; }
      wrap.appendChild(h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'tg_id'), h('th', {}, ''), h('th', {}, 'имя'), h('th', {}, 'username'),
          h('th', {}, 'игр'), h('th', {}, '⏱ время'),
          h('th', {}, '★ вайб'), h('th', {}, '★ игра'),
          h('th', {}, 'premium'), h('th', {}, 'seen'), h('th', {}, ''),
        )),
        h('tbody', {}, d.rows.map(u => h('tr', {},
          h('td', { class: 'id' }, String(u.tg_id)),
          h('td', {}, u.photo_url ? h('img', { src: u.photo_url, style: 'width:28px;height:28px;border-radius:50%;', referrerpolicy: 'no-referrer' }) : (u.emoji || '·')),
          h('td', {}, u.display_name || ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || h('span', { class: 'muted' }, '—')),
          h('td', {}, u.username ? '@' + u.username : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'intensity intensity-2' }, String(u.session_count || u.total_games || 0)),
          h('td', { class: 'intensity intensity-3' }, u.total_active_ms ? fmtDuration(Math.round(u.total_active_ms/1000)) : h('span', { class: 'muted' }, '—')),
          h('td', {}, u.favorite_vibe
            ? h('span', { class: 'chip' + (u.favorite_vibe==='adult'||u.favorite_vibe==='ultra_adult' ? ' adult' : '') }, u.favorite_vibe)
            : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'type' }, u.favorite_game || h('span', { class: 'muted' }, '—')),
          h('td', {}, u.premium_until && u.premium_until > Date.now() ? h('span', { class: 'chip ok' }, 'до ' + fmtTs(u.premium_until)) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'id' }, fmtTs(u.last_seen_at)),
          h('td', { class: 'acts' }, h('button', { onclick: () => openUserModal(u, refresh) }, '✎')),
        ))),
      ));
      pager.innerHTML = '';
      pager.appendChild(h('button', { onclick: () => { if (usersState.offset > 0) { usersState.offset = Math.max(0, usersState.offset - usersState.limit); refresh(); } }, disabled: usersState.offset === 0 ? '' : null }, '← Назад'));
      pager.appendChild(h('div', { class: 'info' }, (usersState.offset+1) + '–' + Math.min(usersState.offset + d.rows.length, d.total) + ' / ' + d.total));
      pager.appendChild(h('button', { onclick: () => { if (usersState.offset + usersState.limit < d.total) { usersState.offset += usersState.limit; refresh(); } }, disabled: usersState.offset + d.rows.length >= d.total ? '' : null }, 'Вперёд →'));
    } catch (e) { wrap.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>'; }
  }
  refresh();
}
function openUserModal(u, refresh) {
  const data = { display_name: u.display_name || '', emoji: u.emoji || '', default_vibe: u.default_vibe || '', premium_until: u.premium_until || 0 };
  const dnIn = h('input', { value: data.display_name });
  const emIn = h('input', { value: data.emoji, maxlength: 4, style: 'width:60px' });
  const vbIn = h('input', { value: data.default_vibe });
  const puIn = h('input', { type: 'datetime-local', value: data.premium_until ? new Date(data.premium_until).toISOString().slice(0,16) : '' });
  const grantBtn = h('button', { onclick: () => {
    const d = new Date(); d.setMonth(d.getMonth() + 1);
    puIn.value = d.toISOString().slice(0,16);
  }}, '+1 месяц');
  const revokeBtn = h('button', { class: 'danger', onclick: () => puIn.value = '' }, 'Снять');
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
  const modal = h('div', { class: 'modal' });
  modal.appendChild(h('h3', {}, '@' + (u.username || u.tg_id) + ' · tg_id=' + u.tg_id));
  [['display_name', dnIn], ['emoji', emIn], ['default_vibe', vbIn],
   ['premium до', h('div', { class: 'row' }, puIn, grantBtn, revokeBtn)],
  ].forEach(([l, el]) => modal.appendChild(h('div', { class: 'form-row' }, h('label', {}, l), el)));
  modal.appendChild(h('div', { class: 'row', style: 'justify-content: flex-end; gap: 8px; margin-top: 12px;' },
    h('button', { onclick: () => bg.remove() }, 'Отмена'),
    h('button', { class: 'primary', onclick: async () => {
      const body = {
        display_name: dnIn.value.trim() || null,
        emoji: emIn.value.trim() || null,
        default_vibe: vbIn.value.trim() || null,
        premium_until: puIn.value ? new Date(puIn.value).getTime() : null,
      };
      await api('/api/admin/users/' + u.tg_id, { method: 'PATCH', body });
      toast('Сохранено', 'ok'); bg.remove(); refresh();
    }}, 'Сохранить'),
  ));
  bg.appendChild(modal); document.body.appendChild(bg);
}

/* ─── Sessions ─────────────────────────────────────────────────────────── */
async function viewSessions(root) {
  const f = h('div', { class: 'filters' });
  const gameSel = h('select', {});
  gameSel.appendChild(h('option', { value: '' }, '— любая игра —'));
  GAMES_LIST.forEach(g => gameSel.appendChild(h('option', { value: g }, g)));
  f.appendChild(gameSel);
  const limSel = h('select', {}, ...[50,100,200,500].map(n => h('option', { value: n }, n + ' посл.')));
  f.appendChild(limSel);
  f.appendChild(h('button', { onclick: refresh }, 'Обновить'));
  root.appendChild(f);
  const wrap = h('div'); root.appendChild(wrap);
  async function refresh() {
    wrap.innerHTML = '<div class="muted">Загружаем…</div>';
    try {
      const qs = new URLSearchParams(); if (gameSel.value) qs.set('game_id', gameSel.value); qs.set('limit', limSel.value || 100);
      const d = await api('/api/admin/sessions?' + qs.toString());
      wrap.innerHTML = '';
      if (!d.rows.length) { wrap.appendChild(h('div', { class: 'empty' }, 'Нет сессий')); return; }
      wrap.appendChild(h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'старт'), h('th', {}, 'юзер'), h('th', {}, 'игра'),
          h('th', {}, 'вайб'), h('th', {}, 'режим'), h('th', {}, 'игр.'),
          h('th', {}, 'r/total'), h('th', {}, 'длит.'), h('th', {}, '✓'),
        )),
        h('tbody', {}, d.rows.map(r => h('tr', {},
          h('td', { class: 'id' }, fmtTs(r.started_at)),
          h('td', {}, r.display_name || (r.username ? '@' + r.username : (r.user_id ? String(r.user_id) : h('span', { class: 'muted' }, 'anon')))),
          h('td', { class: 'type' }, r.game_id || ''),
          h('td', {}, r.vibe || ''),
          h('td', {}, r.mode || ''),
          h('td', {}, String(r.players_count || 0)),
          h('td', {}, (r.rounds_played || 0) + '/' + (r.rounds_total || 0)),
          h('td', { class: 'id' }, r.duration_sec ? r.duration_sec + ' c' : ''),
          h('td', {}, r.finished ? h('span', { class: 'chip ok' }, '✓') : h('span', { class: 'chip warn' }, 'open')),
        ))),
      ));
    } catch (e) { wrap.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>'; }
  }
  refresh();
}

/* ─── Events ───────────────────────────────────────────────────────────── */
async function viewEvents(root) {
  const f = h('div', { class: 'filters' });
  const typeIn = h('input', { placeholder: 'type (точное совпадение)', style: 'min-width:200px' });
  const limSel = h('select', {}, ...[100,200,500].map(n => h('option', { value: n }, n + ' посл.')));
  f.appendChild(typeIn); f.appendChild(limSel);
  f.appendChild(h('button', { onclick: refresh }, 'Обновить'));
  root.appendChild(f);
  const wrap = h('div'); root.appendChild(wrap);
  async function refresh() {
    wrap.innerHTML = '<div class="muted">Загружаем…</div>';
    try {
      const qs = new URLSearchParams(); if (typeIn.value.trim()) qs.set('type', typeIn.value.trim()); qs.set('limit', limSel.value || 200);
      const d = await api('/api/admin/events?' + qs.toString());
      wrap.innerHTML = '';
      if (!d.rows.length) { wrap.appendChild(h('div', { class: 'empty' }, 'Нет событий')); return; }
      wrap.appendChild(h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'когда'), h('th', {}, 'type'), h('th', {}, 'user/anon'),
          h('th', {}, 'game'), h('th', {}, 'vibe'), h('th', {}, 'props'),
        )),
        h('tbody', {}, d.rows.map(r => h('tr', {},
          h('td', { class: 'id' }, fmtTs(r.ts)),
          h('td', { class: 'type' }, r.type),
          h('td', { class: 'id' }, r.user_id || r.anon_id || '—'),
          h('td', {}, r.game_id || ''),
          h('td', {}, r.vibe || ''),
          h('td', { class: 'json' }, r.props ? JSON.stringify(r.props) : ''),
        ))),
      ));
    } catch (e) { wrap.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>'; }
  }
  refresh();
}

/* ─── Rooms ────────────────────────────────────────────────────────────── */
async function viewRooms(root) {
  const f = h('div', { class: 'filters' });
  const stSel = h('select', {},
    h('option', { value: '' }, '— любой стейт —'),
    h('option', { value: 'lobby' }, 'lobby'),
    h('option', { value: 'playing' }, 'playing'),
    h('option', { value: 'ended' }, 'ended'),
  );
  f.appendChild(stSel);
  f.appendChild(h('button', { onclick: refresh }, 'Обновить'));
  f.appendChild(h('span', { class: 'muted' }, 'D1-зеркало. «Force-end» помечает в D1 — DO не дёргается.'));
  root.appendChild(f);
  const wrap = h('div'); root.appendChild(wrap);
  async function refresh() {
    wrap.innerHTML = '<div class="muted">Загружаем…</div>';
    try {
      const qs = new URLSearchParams(); if (stSel.value) qs.set('state', stSel.value); qs.set('limit', 200);
      const d = await api('/api/admin/rooms?' + qs.toString());
      wrap.innerHTML = '';
      if (!d.rows.length) { wrap.appendChild(h('div', { class: 'empty' }, 'Пусто')); return; }
      wrap.appendChild(h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'id'), h('th', {}, 'host'), h('th', {}, 'игра'),
          h('th', {}, 'вайб'), h('th', {}, 'state'), h('th', {}, 'round'),
          h('th', {}, 'игр.'), h('th', {}, 'обновлена'), h('th', {}, ''),
        )),
        h('tbody', {}, d.rows.map(r => h('tr', {},
          h('td', { class: 'id' }, r.id),
          h('td', { class: 'id' }, String(r.host_user_id || '—')),
          h('td', { class: 'type' }, r.game_id || ''),
          h('td', {}, r.vibe || ''),
          h('td', {}, r.state === 'ended' ? h('span', { class: 'chip ok' }, r.state) : h('span', { class: 'chip warn' }, r.state)),
          h('td', {}, String(r.round_index || 0)),
          h('td', {}, String(r.players_count || 0)),
          h('td', { class: 'id' }, fmtTs(r.updated_at)),
          h('td', { class: 'acts' }, r.state !== 'ended' ? h('button', { class: 'danger', onclick: async () => {
            if (!confirm('Force-end комнату ' + r.id + '? Только в D1, DO останется жить до next request.')) return;
            await api('/api/admin/rooms/' + r.id + '/force-end', { method: 'POST', body: {} });
            toast('Закрыто (в D1)', 'ok'); refresh();
          }}, '⛔ end') : null),
        ))),
      ));
    } catch (e) { wrap.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>'; }
  }
  refresh();
}

/* ─── boot ─────────────────────────────────────────────────────────────── */
(async function boot() {
  renderTabs();
  // прелодим список игр для фильтров
  try {
    const s = await api('/api/admin/stats');
    GAMES_LIST.length = 0;
    [...new Set((s.byGameVibe || []).map(r => r.game_id))].sort().forEach(g => GAMES_LIST.push(g));
    $('#conn').textContent = '✓ connected';
  } catch (e) {
    $('#conn').textContent = '✗ ' + e.message;
  }
  render();
})();
window.addEventListener('hashchange', () => {
  const t = location.hash.replace('#', '');
  if (TABS.find(x => x.id === t)) { activeTab = t; renderTabs(); render(); }
});
</script>
</body></html>`;

async function handleVaultPage(request, env) {
  if (!env.DB) return new Response('no DB', { status: 500 });

  const guard = await requireAdmin(request, env);
  if (!guard.ok) {
    const link = `https://t.me/${botUsername(env)}/${appShortName(env)}?startapp=admin_vault`;
    const html = `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PartyUp · Доступ закрыт</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; font: 15px/1.6 -apple-system, system-ui, sans-serif;
  background: #0c0b15; color: #e8e5f2;
  display: grid; place-items: center; min-height: 100vh; padding: 20px; }
.card { max-width: 420px; padding: 32px 24px; background: #1c1929; border: 1px solid #2a2640;
  border-radius: 18px; text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
h1 { font-size: 22px; margin: 0 0 8px; }
p { color: #8a85a3; margin: 0 0 18px; font-size: 14px; }
.tg { display: inline-flex; align-items: center; gap: 8px;
  padding: 12px 22px; border-radius: 12px; text-decoration: none;
  background: linear-gradient(135deg, #2aabee 0%, #229ed9 100%);
  color: #fff; font-weight: 700; font-size: 15px; }
.tg:hover { filter: brightness(1.05); }
.muted { font-size: 12px; color: #6b6889; margin-top: 18px; }
.muted code { background: #2a2640; padding: 2px 6px; border-radius: 5px; color: #a78bfa; font-size: 11px; }
</style></head><body>
<div class="card">
  <div style="font-size:48px;margin-bottom:12px">🔒</div>
  <h1>Доступ ограничен</h1>
  <p>Эта страница доступна только администратору PartyUp.<br>Войди через Telegram, чтобы продолжить.</p>
  <a class="tg" href="${link}">🎮 Открыть в Telegram</a>
  <p class="muted">Если ты администратор — открой Mini App, авторизуйся, потом вернись сюда.<br>
  Или открой ссылку <code>/api/admin/vault</code> внутри уже залогиненной сессии браузера.</p>
</div></body></html>`;
    return new Response(html, {
      status: 403,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      },
    });
  }

  return new Response(ADMIN_SPA_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

// Legacy data endpoint — оставлен для совместимости со старыми ссылками.
async function handleVaultData(request, env) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;
  return handleCardsRead(request, env);
}

/* ─── Admin: статистика для дашборда ─────────────────────────────────────── */
async function handleAdminStats(request, env) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;
  const ts = now();
  const dayAgo = ts - 86400000;
  const weekAgo = ts - 7 * 86400000;
  // Авто-очистка «зависших» комнат: всё, что не обновлялось > 30 минут
  // и не помечено как ended — закрываем в D1-зеркале (DO не дёргаем).
  // Идемпотентно, безопасно при любых race-condition.
  const staleMs = 30 * 60 * 1000;
  try {
    await env.DB.prepare(
      `UPDATE rooms SET state = 'ended', ended_at = COALESCE(ended_at, ?), updated_at = ?
       WHERE state <> 'ended' AND updated_at < ?`
    ).bind(ts, ts, ts - staleMs).run();
    // Сессии без finished_at и старше часа — закрываем как abandoned.
    // duration_sec ограничиваем 1 часом для abandoned (реалистичный максимум
    // партии — никто не сидит 8 часов; иначе среднее время улетает в космос).
    await env.DB.prepare(
      `UPDATE sessions SET finished = 1, finished_at = ?,
         duration_sec = MIN(3600, COALESCE(duration_sec, (? - started_at) / 1000))
       WHERE finished = 0 AND started_at < ?`
    ).bind(ts, ts, ts - 3600 * 1000).run();
    // Одноразовая нормализация уже существующих «раздутых» finished-сессий:
    // если duration > 4 часов — почти наверняка abandoned, который sweep
    // пометил полной разницей. Ограничиваем 1 часом, чтобы avg был адекватный.
    await env.DB.prepare(
      `UPDATE sessions SET duration_sec = 3600
       WHERE duration_sec > 14400 AND finished = 1`
    ).run();
  } catch {}

  const [
    users, premium, sessTotal, sessDay, sessWeek, cardsTotal, cardsApproved, rooms, eventsTotal,
    topGames, topVibes, byGameVibe, daily, recentSessions,
    dauByDay, sessTimeByDay, eventTypes, cardTypes,
    avgSessionAll, avgSessionWeek, retention, funnel,
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE premium_until > ?`).bind(ts).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?`).bind(dayAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?`).bind(weekAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM cards WHERE approved = 1`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM rooms WHERE state <> 'ended'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM events`).first(),
    env.DB.prepare(
      `SELECT game_id, COUNT(*) AS n FROM sessions WHERE started_at >= ?
       GROUP BY game_id ORDER BY n DESC LIMIT 12`
    ).bind(weekAgo).all(),
    env.DB.prepare(
      `SELECT vibe, COUNT(*) AS n FROM sessions
       WHERE started_at >= ? AND vibe IS NOT NULL AND vibe <> ''
       GROUP BY vibe ORDER BY n DESC`
    ).bind(weekAgo).all(),
    env.DB.prepare(
      `SELECT game_id, COALESCE(vibes,'') AS vibes, COUNT(*) AS n FROM cards
       GROUP BY game_id, vibes ORDER BY game_id, vibes`
    ).all(),
    env.DB.prepare(
      `SELECT day, metric, game_id, value FROM daily_stats
       ORDER BY day DESC LIMIT 200`
    ).all(),
    env.DB.prepare(
      `SELECT id, game_id, vibe, mode, players_count, started_at, finished_at, finished
       FROM sessions ORDER BY started_at DESC LIMIT 10`
    ).all(),
    // DAU/день: уникальные user_id (исключая анонимов без аккаунта).
    // Группируем по дню UTC: strftime('%Y-%m-%d', started_at/1000, 'unixepoch')
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
              COUNT(DISTINCT COALESCE(user_id, anon_id)) AS dau
       FROM sessions WHERE started_at >= ?
       GROUP BY day ORDER BY day`
    ).bind(ts - 30 * 86400000).all(),
    // Сумма игрового времени по дням.
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
              SUM(COALESCE(duration_sec, 0)) AS sec,
              COUNT(*) AS sessions
       FROM sessions WHERE started_at >= ?
       GROUP BY day ORDER BY day`
    ).bind(ts - 30 * 86400000).all(),
    // Типы событий, для дашборда и для подсказок при фильтрации.
    env.DB.prepare(
      `SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC LIMIT 40`
    ).all(),
    // Уникальные cards.type для дропдауна на вкладке «Карточки».
    env.DB.prepare(
      `SELECT game_id, type, COUNT(*) AS n FROM cards WHERE type IS NOT NULL AND type <> ''
       GROUP BY game_id, type ORDER BY game_id, n DESC`
    ).all(),
    // Средняя длина finished-сессий (сек) — всё время и за неделю.
    env.DB.prepare(
      `SELECT AVG(duration_sec) AS avg, COUNT(*) AS n
       FROM sessions WHERE finished = 1 AND duration_sec > 0`
    ).first(),
    env.DB.prepare(
      `SELECT AVG(duration_sec) AS avg, COUNT(*) AS n
       FROM sessions WHERE finished = 1 AND duration_sec > 0 AND started_at >= ?`
    ).bind(weekAgo).first(),
    // Retention D1/D7/D30. Когорта — все юзеры (user_id или anon_id), у которых
    // первый день активности >= N+1 дней назад (иначе window ещё не закрыто).
    // Возвращаемся = есть сессия в день first+N.
    env.DB.prepare(
      `WITH first_day AS (
         SELECT COALESCE(CAST(user_id AS TEXT), anon_id) AS uid,
                date(MIN(started_at)/1000, 'unixepoch') AS d0
         FROM sessions
         WHERE user_id IS NOT NULL OR anon_id IS NOT NULL
         GROUP BY uid
       )
       SELECT
         SUM(CASE WHEN julianday('now','utc') - julianday(d0) >= 1 THEN 1 ELSE 0 END) AS cohort_d1,
         SUM(CASE WHEN julianday('now','utc') - julianday(d0) >= 7 THEN 1 ELSE 0 END) AS cohort_d7,
         SUM(CASE WHEN julianday('now','utc') - julianday(d0) >= 30 THEN 1 ELSE 0 END) AS cohort_d30,
         SUM(CASE WHEN julianday('now','utc') - julianday(d0) >= 1 AND EXISTS (
           SELECT 1 FROM sessions s WHERE COALESCE(CAST(s.user_id AS TEXT), s.anon_id) = fd.uid
             AND date(s.started_at/1000,'unixepoch') = date(fd.d0, '+1 day')
         ) THEN 1 ELSE 0 END) AS ret_d1,
         SUM(CASE WHEN julianday('now','utc') - julianday(d0) >= 7 AND EXISTS (
           SELECT 1 FROM sessions s WHERE COALESCE(CAST(s.user_id AS TEXT), s.anon_id) = fd.uid
             AND date(s.started_at/1000,'unixepoch') = date(fd.d0, '+7 day')
         ) THEN 1 ELSE 0 END) AS ret_d7,
         SUM(CASE WHEN julianday('now','utc') - julianday(d0) >= 30 AND EXISTS (
           SELECT 1 FROM sessions s WHERE COALESCE(CAST(s.user_id AS TEXT), s.anon_id) = fd.uid
             AND date(s.started_at/1000,'unixepoch') = date(fd.d0, '+30 day')
         ) THEN 1 ELSE 0 END) AS ret_d30
       FROM first_day fd`
    ).first(),
    // Воронка: уникальные участники события за 7 дней по каждому шагу.
    env.DB.prepare(
      `SELECT type, COUNT(DISTINCT COALESCE(CAST(user_id AS TEXT), anon_id)) AS users
       FROM events
       WHERE ts >= ? AND type IN ('open','game_select','game_start','game_finish')
       GROUP BY type`
    ).bind(weekAgo).all(),
  ]);
  return adminJson({
    ok: true,
    counters: {
      users: users?.n || 0,
      premium: premium?.n || 0,
      sessionsTotal: sessTotal?.n || 0,
      sessionsDay: sessDay?.n || 0,
      sessionsWeek: sessWeek?.n || 0,
      cardsTotal: cardsTotal?.n || 0,
      cardsApproved: cardsApproved?.n || 0,
      activeRooms: rooms?.n || 0,
      eventsTotal: eventsTotal?.n || 0,
    },
    topGames: topGames.results || [],
    topVibes: topVibes.results || [],
    byGameVibe: byGameVibe.results || [],
    daily: daily.results || [],
    recentSessions: recentSessions.results || [],
    dauByDay: dauByDay.results || [],
    sessTimeByDay: sessTimeByDay.results || [],
    eventTypes: eventTypes.results || [],
    cardTypes: cardTypes.results || [],
    avgSession: {
      all: { avg: avgSessionAll?.avg || 0, n: avgSessionAll?.n || 0 },
      week: { avg: avgSessionWeek?.avg || 0, n: avgSessionWeek?.n || 0 },
    },
    retention: retention || { cohort_d1: 0, cohort_d7: 0, cohort_d30: 0, ret_d1: 0, ret_d7: 0, ret_d30: 0 },
    funnel: funnel.results || [],
  });
}

/* ─── Admin: cards CRUD ──────────────────────────────────────────────────── */
function _vibesToCsv(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const arr = v.map(x => String(x).trim()).filter(Boolean);
    return arr.length ? arr.join(',') : null;
  }
  const s = String(v).trim();
  return s || null;
}

async function handleAdminCards(request, env, method, idStr) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);

  if (method === 'GET' && !idStr) {
    const where = []; const args = [];
    const game_id = url.searchParams.get('game_id');
    if (game_id) { where.push('game_id = ?'); args.push(game_id); }
    const vibe = url.searchParams.get('vibe');
    if (vibe) {
      if (vibe === '__none__') where.push("(vibes IS NULL OR vibes = '')");
      else { where.push("(',' || COALESCE(vibes,'') || ',') LIKE ?"); args.push(`%,${vibe},%`); }
    }
    const type = url.searchParams.get('type');
    if (type) { where.push('type = ?'); args.push(type); }
    const intensity = url.searchParams.get('intensity');
    if (intensity) { where.push('intensity = ?'); args.push(Number(intensity)); }
    const approved = url.searchParams.get('approved');
    if (approved === '0' || approved === '1') { where.push('approved = ?'); args.push(Number(approved)); }
    const q = url.searchParams.get('q');
    if (q) { where.push('text LIKE ?'); args.push(`%${q.replace(/[%_]/g, m => '\\' + m)}%`); }
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const sort = url.searchParams.get('sort') === 'random' ? 'RANDOM()' : 'id DESC';
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rs, total] = await Promise.all([
      env.DB.prepare(
        `SELECT id, pack_id, game_id, type, text, vibes, intensity, meta, approved, source, author_user_id, created_at
         FROM cards ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`
      ).bind(...args, limit, offset).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM cards ${whereSql}`).bind(...args).first(),
    ]);
    return adminJson({
      ok: true,
      total: total?.n || 0,
      limit, offset,
      rows: (rs.results || []).map(r => ({
        ...r,
        vibes: r.vibes ? String(r.vibes).split(',').filter(Boolean) : [],
        meta: r.meta ? safeJson(r.meta) : null,
      })),
    });
  }

  if (method === 'POST' && !idStr) {
    const body = await request.json().catch(() => ({}));
    if (!body.game_id || !body.text) return adminJson({ error: 'missing_fields' }, 400);
    const r = await env.DB.prepare(
      `INSERT INTO cards (pack_id, game_id, type, text, vibes, intensity, meta, source, author_user_id, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      body.pack_id || null,
      String(body.game_id),
      body.type ? String(body.type) : null,
      String(body.text),
      _vibesToCsv(body.vibes),
      Number(body.intensity) || 2,
      body.meta ? JSON.stringify(body.meta) : null,
      body.source ? String(body.source) : 'admin',
      Number.isInteger(body.author_user_id) ? body.author_user_id : guard.userId,
      body.approved === false || body.approved === 0 ? 0 : 1,
      now(),
    ).run();
    return adminJson({ ok: true, id: r.meta?.last_row_id ?? null });
  }

  if (method === 'PATCH' && idStr) {
    const body = await request.json().catch(() => ({}));
    const sets = []; const args = [];
    const stringFields = ['game_id', 'type', 'text', 'pack_id', 'source'];
    for (const k of stringFields) {
      if (k in body) { sets.push(`${k} = ?`); args.push(body[k] == null ? null : String(body[k])); }
    }
    if ('intensity' in body) { sets.push('intensity = ?'); args.push(Number(body.intensity) || 2); }
    if ('approved' in body) { sets.push('approved = ?'); args.push(body.approved ? 1 : 0); }
    if ('vibes' in body) { sets.push('vibes = ?'); args.push(_vibesToCsv(body.vibes)); }
    if ('meta' in body) { sets.push('meta = ?'); args.push(body.meta ? JSON.stringify(body.meta) : null); }
    if (!sets.length) return adminJson({ error: 'no_fields' }, 400);
    args.push(Number(idStr));
    await env.DB.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
    return adminJson({ ok: true });
  }

  if (method === 'DELETE' && idStr) {
    await env.DB.prepare(`DELETE FROM cards WHERE id = ?`).bind(Number(idStr)).run();
    return adminJson({ ok: true });
  }

  return adminJson({ error: 'method_not_allowed' }, 405);
}

async function handleAdminCardsBulk(request, env) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;
  const body = await request.json().catch(() => ({}));
  const action = body.action;

  if (action === 'import') {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return adminJson({ error: 'no_items' }, 400);
    const ts = now();
    const stmts = [];
    for (const it of items) {
      if (!it || !it.game_id || !it.text) continue;
      stmts.push(env.DB.prepare(
        `INSERT INTO cards (pack_id, game_id, type, text, vibes, intensity, meta, source, author_user_id, approved, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        it.pack_id || null,
        String(it.game_id),
        it.type ? String(it.type) : null,
        String(it.text),
        _vibesToCsv(it.vibes),
        Number(it.intensity) || 2,
        it.meta ? JSON.stringify(it.meta) : null,
        it.source ? String(it.source) : 'admin_bulk',
        Number.isInteger(it.author_user_id) ? it.author_user_id : guard.userId,
        it.approved === false || it.approved === 0 ? 0 : 1,
        ts,
      ));
    }
    if (!stmts.length) return adminJson({ error: 'no_valid_items' }, 400);
    await env.DB.batch(stmts);
    return adminJson({ ok: true, inserted: stmts.length });
  }

  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return adminJson({ error: 'no_ids' }, 400);
  const placeholders = ids.map(() => '?').join(',');

  if (action === 'delete') {
    await env.DB.prepare(`DELETE FROM cards WHERE id IN (${placeholders})`).bind(...ids).run();
    return adminJson({ ok: true, deleted: ids.length });
  }
  if (action === 'approve' || action === 'unapprove') {
    await env.DB.prepare(`UPDATE cards SET approved = ? WHERE id IN (${placeholders})`)
      .bind(action === 'approve' ? 1 : 0, ...ids).run();
    return adminJson({ ok: true, updated: ids.length });
  }
  if (action === 'set_vibes') {
    const csv = _vibesToCsv(body.vibes);
    await env.DB.prepare(`UPDATE cards SET vibes = ? WHERE id IN (${placeholders})`)
      .bind(csv, ...ids).run();
    return adminJson({ ok: true, updated: ids.length });
  }
  if (action === 'set_intensity') {
    const intensity = Number(body.intensity) || 2;
    await env.DB.prepare(`UPDATE cards SET intensity = ? WHERE id IN (${placeholders})`)
      .bind(intensity, ...ids).run();
    return adminJson({ ok: true, updated: ids.length });
  }
  return adminJson({ error: 'unknown_action' }, 400);
}

/* ─── Admin: packs CRUD ──────────────────────────────────────────────────── */
async function handleAdminPacks(request, env, method, idStr) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;

  if (method === 'GET' && !idStr) {
    const rs = await env.DB.prepare(
      `SELECT p.id, p.title, p.description, p.game_id, p.vibe, p.is_premium, p.price_stars,
              p.created_at, (SELECT COUNT(*) FROM cards WHERE pack_id = p.id) AS cards_count
       FROM packs p ORDER BY p.created_at DESC`
    ).all();
    return adminJson({ ok: true, rows: rs.results || [] });
  }

  if (method === 'POST' && !idStr) {
    const body = await request.json().catch(() => ({}));
    if (!body.id || !body.title) return adminJson({ error: 'missing_fields' }, 400);
    await env.DB.prepare(
      `INSERT INTO packs (id, title, description, game_id, vibe, is_premium, price_stars, cards_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      String(body.id),
      String(body.title),
      body.description ? String(body.description) : null,
      body.game_id ? String(body.game_id) : null,
      body.vibe ? String(body.vibe) : null,
      body.is_premium ? 1 : 0,
      Number(body.price_stars) || 0,
      0,
      now(),
    ).run();
    return adminJson({ ok: true, id: body.id });
  }

  if (method === 'PATCH' && idStr) {
    const body = await request.json().catch(() => ({}));
    const sets = []; const args = [];
    const strFields = ['title', 'description', 'game_id', 'vibe'];
    for (const k of strFields) {
      if (k in body) { sets.push(`${k} = ?`); args.push(body[k] == null ? null : String(body[k])); }
    }
    if ('is_premium' in body) { sets.push('is_premium = ?'); args.push(body.is_premium ? 1 : 0); }
    if ('price_stars' in body) { sets.push('price_stars = ?'); args.push(Number(body.price_stars) || 0); }
    if (!sets.length) return adminJson({ error: 'no_fields' }, 400);
    args.push(String(idStr));
    await env.DB.prepare(`UPDATE packs SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
    return adminJson({ ok: true });
  }

  if (method === 'DELETE' && idStr) {
    // Удаляем pack + разлинковываем карточки (pack_id → NULL), не удаляя сами карточки.
    await env.DB.batch([
      env.DB.prepare(`UPDATE cards SET pack_id = NULL WHERE pack_id = ?`).bind(String(idStr)),
      env.DB.prepare(`DELETE FROM packs WHERE id = ?`).bind(String(idStr)),
    ]);
    return adminJson({ ok: true });
  }

  return adminJson({ error: 'method_not_allowed' }, 405);
}

/* ─── Admin: users (read + limited edit) ─────────────────────────────────── */
async function handleAdminUsers(request, env, method, idStr) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);

  if (method === 'GET' && !idStr) {
    const q = url.searchParams.get('q');
    const sort = url.searchParams.get('sort') || 'recent'; // recent | playtime | games | created
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const where = []; const args = [];
    if (q) {
      where.push('(username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR display_name LIKE ? OR CAST(tg_id AS TEXT) LIKE ?)');
      const pat = `%${q}%`;
      args.push(pat, pat, pat, pat, pat);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderBy = ({
      playtime: 'total_active_ms DESC, last_seen_at DESC',
      games: 'total_games DESC, last_seen_at DESC',
      created: 'created_at DESC',
      recent: 'last_seen_at DESC',
    })[sort] || 'last_seen_at DESC';
    // Subqueries аггрегируют per-user: total_active_ms, favorite_vibe, favorite_game.
    // Для текущего объёма (десятки юзеров) — OK; на тысячах нужно денормализовать в users.
    const [rs, total] = await Promise.all([
      env.DB.prepare(
        `SELECT u.tg_id, u.username, u.first_name, u.last_name, u.display_name, u.emoji, u.photo_url, u.is_premium,
                u.total_games, u.total_wins, u.total_score, u.default_vibe, u.premium_until, u.language_code,
                u.created_at, u.last_seen_at,
                COALESCE((SELECT SUM(COALESCE(sp.active_ms,0))
                          FROM session_players sp
                          JOIN sessions s ON s.id = sp.session_id
                          WHERE s.user_id = u.tg_id), 0) AS total_active_ms,
                (SELECT vibe FROM sessions
                  WHERE user_id = u.tg_id AND vibe IS NOT NULL AND vibe <> ''
                  GROUP BY vibe ORDER BY COUNT(*) DESC, vibe LIMIT 1) AS favorite_vibe,
                (SELECT game_id FROM sessions
                  WHERE user_id = u.tg_id AND game_id IS NOT NULL AND game_id <> ''
                  GROUP BY game_id ORDER BY COUNT(*) DESC, game_id LIMIT 1) AS favorite_game,
                (SELECT COUNT(*) FROM sessions WHERE user_id = u.tg_id) AS session_count
         FROM users u ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
      ).bind(...args, limit, offset).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`).bind(...args).first(),
    ]);
    return adminJson({ ok: true, total: total?.n || 0, limit, offset, sort, rows: rs.results || [] });
  }

  if (method === 'PATCH' && idStr) {
    const body = await request.json().catch(() => ({}));
    const sets = []; const args = [];
    if ('display_name' in body) { sets.push('display_name = ?'); args.push(body.display_name == null ? null : String(body.display_name)); }
    if ('emoji' in body) { sets.push('emoji = ?'); args.push(body.emoji == null ? null : String(body.emoji)); }
    if ('default_vibe' in body) { sets.push('default_vibe = ?'); args.push(body.default_vibe == null ? null : String(body.default_vibe)); }
    if ('premium_until' in body) {
      sets.push('premium_until = ?');
      args.push(body.premium_until == null ? null : Number(body.premium_until));
    }
    if (!sets.length) return adminJson({ error: 'no_fields' }, 400);
    args.push(Number(idStr));
    await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE tg_id = ?`).bind(...args).run();
    return adminJson({ ok: true });
  }

  return adminJson({ error: 'method_not_allowed' }, 405);
}

/* ─── Admin: sessions / events / rooms (read-only feeds) ─────────────────── */
async function handleAdminSessions(request, env) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
  const gameId = url.searchParams.get('game_id');
  const where = []; const args = [];
  if (gameId) { where.push('s.game_id = ?'); args.push(gameId); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rs = await env.DB.prepare(
    `SELECT s.id, s.user_id, u.display_name, u.username,
            s.game_id, s.vibe, s.mode, s.players_count, s.rounds_total, s.rounds_played,
            s.room_id, s.started_at, s.finished_at, s.duration_sec, s.finished
     FROM sessions s LEFT JOIN users u ON u.tg_id = s.user_id
     ${whereSql}
     ORDER BY s.started_at DESC LIMIT ?`
  ).bind(...args, limit).all();
  return adminJson({ ok: true, rows: rs.results || [] });
}

async function handleAdminEvents(request, env) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
  const type = url.searchParams.get('type');
  const where = []; const args = [];
  if (type) { where.push('type = ?'); args.push(type); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rs = await env.DB.prepare(
    `SELECT id, ts, user_id, anon_id, session_id, room_id, type, game_id, vibe, props
     FROM events ${whereSql} ORDER BY id DESC LIMIT ?`
  ).bind(...args, limit).all();
  return adminJson({
    ok: true,
    rows: (rs.results || []).map(r => ({ ...r, props: r.props ? safeJson(r.props) : null })),
  });
}

async function handleAdminRooms(request, env, method, idStr) {
  const guard = await requireAdmin(request, env);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);

  if (method === 'GET' && !idStr) {
    const state = url.searchParams.get('state');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const where = []; const args = [];
    if (state) { where.push('state = ?'); args.push(state); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rs = await env.DB.prepare(
      `SELECT id, host_user_id, game_id, vibe, state, round_index, players_count,
              created_at, updated_at, ended_at
       FROM rooms ${whereSql} ORDER BY updated_at DESC LIMIT ?`
    ).bind(...args, limit).all();
    return adminJson({ ok: true, rows: rs.results || [] });
  }

  if (method === 'POST' && idStr && url.pathname.endsWith('/force-end')) {
    // D1-only force-end: помечаем room.state='ended' в зеркале. DO не дёргаем (экономия).
    // Реальный DO продолжит жить до next request от клиента — но клиенты, увидев
    // ended в своём poll'е, перестанут опрашивать (RoundScreen ловит state==='ended').
    const ts = now();
    await env.DB.prepare(
      `UPDATE rooms SET state = 'ended', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?`
    ).bind(ts, ts, String(idStr)).run();
    return adminJson({ ok: true, mirrored_only: true });
  }

  return adminJson({ error: 'method_not_allowed' }, 405);
}

async function handleLeaderboard(request, env) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get('gameId') || null;
  const sinceDays = Number(url.searchParams.get('days') || 30);
  const since = now() - sinceDays * 86400 * 1000;
  const q = gameId
    ? env.DB.prepare(
        `SELECT s.user_id, u.display_name, u.emoji, SUM(sp.score) AS score, COUNT(*) AS plays
         FROM sessions s
         JOIN session_players sp ON sp.session_id = s.id
         LEFT JOIN users u ON u.tg_id = s.user_id
         WHERE s.user_id IS NOT NULL AND s.started_at >= ? AND s.game_id = ?
         GROUP BY s.user_id ORDER BY score DESC LIMIT 20`
      ).bind(since, gameId)
    : env.DB.prepare(
        `SELECT s.user_id, u.display_name, u.emoji, SUM(sp.score) AS score, COUNT(*) AS plays
         FROM sessions s
         JOIN session_players sp ON sp.session_id = s.id
         LEFT JOIN users u ON u.tg_id = s.user_id
         WHERE s.user_id IS NOT NULL AND s.started_at >= ?
         GROUP BY s.user_id ORDER BY score DESC LIMIT 20`
      ).bind(since);
  const rs = await q.all();
  return corsJson({ ok: true, rows: rs.results || [] });
}

async function handleStatsSummary(request, env) {
  const day = todayKey();
  const rows = await env.DB.prepare(
    `SELECT metric, game_id, value FROM daily_stats WHERE day = ?`
  ).bind(day).all();
  return corsJson({ ok: true, day, rows: rows.results || [] });
}

/* ─── Share via prepared inline message (Bot API 8.0+) ───────────────────── */
// Сервер генерирует prepared_message_id через savePreparedInlineMessage,
// а Mini App вызывает tg.shareMessage(id) → нативный share-пикер чатов.
async function handlePrepareShare(request, env) {
  const body = await request.json().catch(() => ({}));
  const { userId } = await resolveCaller(request, env);
  if (!userId) return corsJson({ error: 'auth_required' }, 401);

  const link = String(body.link || directLink(env, body.kind || 'share'));
  const text = String(body.text || 'Заходи в PartyUp 🎮');
  const id = (body.kind || 'share') + '_' + Math.random().toString(36).slice(2, 10);

  const result = {
    type: 'article',
    id,
    title: body.title || 'PartyUp',
    description: body.description || text.slice(0, 80),
    input_message_content: {
      message_text: `${text}\n\n${link}`,
      disable_web_page_preview: false,
    },
    reply_markup: {
      inline_keyboard: [[{ text: '🎮 Открыть PartyUp', url: link }]],
    },
  };

  const r = await tg(env, 'savePreparedInlineMessage', {
    user_id: userId,
    result,
    allow_user_chats: true,
    allow_bot_chats: false,
    allow_group_chats: true,
    allow_channel_chats: true,
  });
  if (!r?.ok) return corsJson({ error: 'prepare_failed', detail: r }, 500);
  return corsJson({ ok: true, preparedMessageId: r.result.id, expirationDate: r.result.expiration_date });
}

/* ─── Bot setup: webhook + commands + menu_button ────────────────────────── */
// GET /api/tg/setup?secret=<TELEGRAM_WEBHOOK_SECRET>
// Идемпотентно настраивает бота: переустанавливает webhook с allowed_updates
// (включая inline_query, chosen_inline_result, callback_query) и регистрирует
// команды + menu_button. Вызывается вручную при изменениях.
async function handleTgSetup(request, env) {
  const url = new URL(request.url);
  if (!env.TELEGRAM_BOT_TOKEN) return corsJson({ error: 'no_bot_token' }, 500);
  const secret = url.searchParams.get('secret');
  if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return corsJson({ error: 'forbidden' }, 403);
  }

  const webappUrl = env.WEBAPP_URL || WEBAPP_URL_DEFAULT;
  const webhookUrl = `${webappUrl.replace(/\/+$/, '')}/api/tg/webhook`;

  // Сбросим pending updates, чтобы не «прострелить» старыми сообщениями.
  await tg(env, 'deleteWebhook', { drop_pending_updates: true });

  const wh = await tg(env, 'setWebhook', {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    allowed_updates: [
      'message',
      'callback_query',
      'inline_query',
      'chosen_inline_result',
      'pre_checkout_query',
    ],
    drop_pending_updates: true,
  });

  const cmds = await tg(env, 'setMyCommands', {
    commands: [
      { command: 'start', description: '🎮 Открыть PartyUp' },
      { command: 'play',  description: '🎯 Запустить игру' },
      { command: 'help',  description: '❔ Команды и inline-фичи' },
    ],
  });

  const menu = await tg(env, 'setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: '🎮 Играть',
      web_app: { url: webappUrl },
    },
  });

  const info = await tg(env, 'getWebhookInfo', {});

  return corsJson({ ok: true, webhook: wh, commands: cmds, menu, info });
}

/* ─── Payments (Telegram Stars) — заготовка ──────────────────────────────── */
async function handleCreateInvoice(request, env) {
  const body = await request.json().catch(() => ({}));
  const { userId } = await resolveCaller(request, env);
  if (!userId) return corsJson({ error: 'auth_required' }, 401);
  if (!body.packId) return corsJson({ error: 'missing_pack' }, 400);
  const pack = await env.DB.prepare('SELECT * FROM packs WHERE id = ?').bind(body.packId).first();
  if (!pack) return corsJson({ error: 'pack_not_found' }, 404);
  if (!pack.is_premium || !pack.price_stars) return corsJson({ error: 'not_premium' }, 400);

  await env.DB.prepare(
    `INSERT INTO purchases (user_id, item_type, item_id, stars, status, created_at)
     VALUES (?, 'pack', ?, ?, 'pending', ?)`
  ).bind(userId, pack.id, pack.price_stars, now()).run();

  // создаём ссылку на счёт в TG Stars
  const inv = await tg(env, 'createInvoiceLink', {
    title: pack.title || 'PartyUp Pack',
    description: pack.description || 'Премиум-пак карточек',
    payload: `pack:${pack.id}:${userId}`,
    currency: 'XTR',
    prices: [{ label: pack.title || 'Pack', amount: pack.price_stars }],
  });
  if (!inv?.ok) return corsJson({ error: 'invoice_failed', detail: inv }, 500);
  return corsJson({ ok: true, invoiceUrl: inv.result });
}

/* ─── Main Worker ────────────────────────────────────────────────────────── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health
    if (url.pathname === '/api/health') {
      return corsJson({ ok: true, service: 'partyup', ts: now(), db: !!env.DB });
    }

    // Telegram bot webhook
    if (url.pathname === '/api/tg/webhook' && method === 'POST') {
      const secret = request.headers.get('x-telegram-bot-api-secret-token');
      if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try { await handleUpdate(await request.json(), env); }
      catch (e) { console.error('webhook error', e); }
      return new Response('ok');
    }

    // API routes
    if (url.pathname === '/api/auth' && method === 'POST') return handleAuth(request, env);
    if (url.pathname === '/api/auth/widget' && method === 'POST') return handleAuthWidget(request, env);
    if (url.pathname === '/api/auth/start' && method === 'POST') return handleAuthStart(request, env);
    if (url.pathname === '/api/auth/poll' && method === 'GET') return handleAuthPoll(request, env);
    if (url.pathname === '/api/me' && method === 'GET') return handleMe(request, env);
    if (url.pathname === '/api/whoami' && method === 'GET') return handleWhoAmI(request, env);
    if (url.pathname === '/api/me/update' && method === 'POST') return handleMeUpdate(request, env);
    if (url.pathname === '/api/track' && method === 'POST') return handleTrack(request, env);
    if (url.pathname === '/api/session/start' && method === 'POST') return handleSessionStart(request, env);
    if (url.pathname === '/api/session/finish' && method === 'POST') return handleSessionFinish(request, env);
    if (url.pathname === '/api/leaderboard' && method === 'GET') return handleLeaderboard(request, env);
    if (url.pathname === '/api/friends' && method === 'GET') return handleFriends(request, env);
    if (url.pathname === '/api/cards' && method === 'GET') return handleCardsRead(request, env);
    // Vault: поддерживаем GET и HEAD, со слэшем и без, плюс legacy редирект.
    if ((url.pathname === VAULT_PATH || url.pathname === VAULT_PATH + '/') &&
        (method === 'GET' || method === 'HEAD')) {
      return handleVaultPage(request, env);
    }
    if (url.pathname === VAULT_PATH + '/data' && method === 'GET') return handleVaultData(request, env);
    // Старый URL до миграции — редирект на новый.
    if (url.pathname === '/__cards-vault-x7k3p9q2' || url.pathname.startsWith('/__cards-vault-x7k3p9q2/')) {
      return new Response(null, { status: 301, headers: { Location: VAULT_PATH, 'Cache-Control': 'no-store' } });
    }
    // Admin API (D1-only)
    if (url.pathname === ADMIN_PATH + '/issue-token' && method === 'GET') return handleAdminIssueToken(request, env);
    if (url.pathname === ADMIN_PATH + '/stats' && method === 'GET') return handleAdminStats(request, env);
    if (url.pathname === ADMIN_PATH + '/cards' && (method === 'GET' || method === 'POST')) return handleAdminCards(request, env, method, null);
    if (url.pathname === ADMIN_PATH + '/cards/bulk' && method === 'POST') return handleAdminCardsBulk(request, env);
    {
      const m = url.pathname.match(/^\/api\/admin\/cards\/(\d+)$/);
      if (m && (method === 'PATCH' || method === 'DELETE')) return handleAdminCards(request, env, method, m[1]);
    }
    if (url.pathname === ADMIN_PATH + '/packs' && (method === 'GET' || method === 'POST')) return handleAdminPacks(request, env, method, null);
    {
      const m = url.pathname.match(/^\/api\/admin\/packs\/([^/]+)$/);
      if (m && (method === 'PATCH' || method === 'DELETE')) return handleAdminPacks(request, env, method, decodeURIComponent(m[1]));
    }
    if (url.pathname === ADMIN_PATH + '/users' && method === 'GET') return handleAdminUsers(request, env, method, null);
    {
      const m = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
      if (m && method === 'PATCH') return handleAdminUsers(request, env, method, m[1]);
    }
    if (url.pathname === ADMIN_PATH + '/sessions' && method === 'GET') return handleAdminSessions(request, env);
    if (url.pathname === ADMIN_PATH + '/events' && method === 'GET') return handleAdminEvents(request, env);
    if (url.pathname === ADMIN_PATH + '/rooms' && method === 'GET') return handleAdminRooms(request, env, method, null);
    {
      const m = url.pathname.match(/^\/api\/admin\/rooms\/([A-Za-z0-9_-]+)\/force-end$/);
      if (m && method === 'POST') return handleAdminRooms(request, env, method, m[1]);
    }
    if (url.pathname === '/api/stats/summary' && method === 'GET') return handleStatsSummary(request, env);
    if (url.pathname === '/api/share/prepare' && method === 'POST') return handlePrepareShare(request, env);
    if (url.pathname === '/api/tg/setup' && method === 'GET') return handleTgSetup(request, env);
    if (url.pathname === '/api/payments/invoice' && method === 'POST') return handleCreateInvoice(request, env);

    // Room API → Durable Object
    const roomMatch = url.pathname.match(/^\/api\/room\/([A-Z0-9]+)(\/.*)?$/);
    if (roomMatch) {
      const roomId = roomMatch[1];
      const subPath = roomMatch[2] || '';
      if (!env.GAME_ROOM) return corsJson({ error: 'durable_objects_not_configured' }, 503);
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = subPath || '/state';
      const doRequest = new Request(doUrl.toString(), {
        method,
        headers: request.headers,
        body: method !== 'GET' && method !== 'HEAD' ? request.body : undefined,
      });
      return stub.fetch(doRequest);
    }

    if (url.pathname.startsWith('/api/')) return corsJson({ error: 'not_implemented' }, 404);

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('PartyUp', { status: 200 });
  },
};
