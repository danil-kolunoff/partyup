// Лёгкий API-клиент для воркера PartyUp.
import { tgInitData, getAnonId } from './tg.js';
export { getAnonId };

const BASE = ''; // same-origin (worker отдаёт и фронт, и /api)

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  const init = tgInitData();
  if (init) h['X-Init-Data'] = init;
  const anon = getAnonId();
  if (anon) h['X-Anon-Id'] = anon;
  return h;
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: headers(),
    credentials: 'include', // нужно для cookie pu_sess от bot-login
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({}));
}
async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: headers(),
    credentials: 'include',
  });
  return res.json().catch(() => ({}));
}

export const api = {
  auth: () => post('/api/auth', { initData: tgInitData(), anonId: getAnonId() }),
  authStart: () => post('/api/auth/start', {}),
  authPoll: (token) => {
    const anon = getAnonId();
    const q = `token=${encodeURIComponent(token)}` + (anon ? `&anon=${encodeURIComponent(anon)}` : '');
    return get(`/api/auth/poll?${q}`);
  },
  me: () => get('/api/me'),
  updateMe: (payload) => post('/api/me/update', payload),
  track: (events) => post('/api/track', Array.isArray(events) ? { events } : events),
  startSession: (payload) => post('/api/session/start', payload),
  finishSession: (payload) => post('/api/session/finish', payload),
  leaderboard: (gameId) => get(`/api/leaderboard${gameId ? `?gameId=${gameId}` : ''}`),
  friends: () => get('/api/friends'),
  createInvoice: (packId) => post('/api/payments/invoice', { packId }),
  prepareShare: (payload) => post('/api/share/prepare', payload),
  roomInit: (id, body) => post(`/api/room/${id}/init`, body),
  roomJoin: (id, body) => post(`/api/room/${id}/join`, body),
  roomAction: (id, body) => post(`/api/room/${id}/action`, body),
  roomState: (id) => get(`/api/room/${id}/state`),
};
