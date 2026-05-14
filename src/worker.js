// Cloudflare Worker для PartyUp.
// Пока отдаёт статику (build) и заглушку API. Позже сюда добавим
// комнаты на Durable Objects + WebSocket для онлайн-игры.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: 'partyup', ts: Date.now() });
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'not_implemented' }, { status: 404 });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('PartyUp', { status: 200 });
  },
};
