// Единая точка для телеметрии: своя D1-телеметрия + Яндекс.Метрика.
// Сам счётчик ym инициализируется напрямую в index.html (см. сниппет),
// здесь только отправляем goals и параметры визитов через ym('reachGoal').
import { api } from './api.js';

const YM_ID = 109262837;

let buffer = [];
let timer = null;
let sessionId = null;
let currentRoomId = null;

const FLUSH_INTERVAL_MS = 4000;
const MAX_BUFFER = 20;

function sendYM(type, props) {
  if (typeof window === 'undefined' || !window.ym) return;
  try { window.ym(YM_ID, 'reachGoal', type, props || {}); } catch {}
}
function sendYMParams(params) {
  if (typeof window === 'undefined' || !window.ym || !params) return;
  try { window.ym(YM_ID, 'params', params); } catch {}
}
function sendYMUserParams(params) {
  if (typeof window === 'undefined' || !window.ym || !params) return;
  try { window.ym(YM_ID, 'userParams', params); } catch {}
}

async function flush() {
  if (!buffer.length) return;
  const batch = buffer.splice(0, buffer.length);
  try { await api.track(batch); } catch { /* swallow */ }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, FLUSH_INTERVAL_MS);
}

export function setSessionId(id) { sessionId = id || null; }
export function setRoomId(id) { currentRoomId = id || null; }

export function track(type, props = {}) {
  const evt = {
    type, ts: Date.now(),
    sessionId: props.sessionId || sessionId || null,
    roomId: props.roomId || currentRoomId || null,
    gameId: props.gameId || null,
    vibe: props.vibe || null,
    props: Object.keys(props).length ? props : null,
  };
  buffer.push(evt);
  sendYM(type, props);
  if (buffer.length >= MAX_BUFFER) flush();
  else schedule();
}

export function initAnalytics() {
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', () => flush());
    // Прокинем TG-сегменты как user params, чтобы видеть их в отчётах.
    try {
      const tg = window.Telegram?.WebApp;
      const u = tg?.initDataUnsafe?.user;
      if (u) sendYMUserParams({
        UserID: String(u.id),
        tg_premium: u.is_premium ? 1 : 0,
        tg_lang: u.language_code || 'ru',
      });
      if (tg?.platform) sendYMParams({ tg_platform: tg.platform, tg_version: tg.version });
    } catch {}
  }
}
export { sendYMParams, sendYMUserParams };

// Конкретные события — единый словарь, чтобы не плодить опечаток.
export const ev = {
  open:        (props = {}) => track('open', props),
  authOk:      (mode) => track('auth_ok', { mode }),
  vibeChange:  (vibe) => track('vibe_change', { vibe }),
  pickerUse:   (picker) => track('picker_use', picker),
  gameSelect:  (gameId) => track('game_select', { gameId }),
  gameStart:   (gameId, props = {}) => track('game_start', { gameId, ...props }),
  roundStart:  (gameId, roundIndex) => track('round_start', { gameId, roundIndex }),
  roundEnd:    (gameId, roundIndex) => track('round_end', { gameId, roundIndex }),
  gameFinish:  (gameId, props = {}) => track('game_finish', { gameId, ...props }),
  share:       (where, props = {}) => track('share', { where, ...props }),
  paywallView: (itemId) => track('paywall_view', { itemId }),
  purchase:    (itemId, stars) => track('purchase', { itemId, stars }),
  roomCreate:  (gameId) => track('room_create', { gameId }),
  roomJoin:    (roomId) => track('room_join', { roomId }),
  roomLeave:   (roomId) => track('room_leave', { roomId }),
};
