// Cloudflare Worker для PartyUp.
// - отдаёт собранный фронт из ./dist (binding ASSETS)
// - /api/health        — заглушка
// - /api/tg/webhook    — Telegram webhook (обработка /start и т.д.)

const WEBAPP_URL = 'https://partyup.danil-kolunoff.workers.dev';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function tg(env, method, payload) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return res.json();
}

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(/\s+/)[0].split('@')[0];

  const playButton = {
    inline_keyboard: [[
      { text: '🎮 Играть', web_app: { url: WEBAPP_URL } },
    ]],
  };

  if (cmd === '/start' || cmd === '/play') {
    const firstName = msg.from?.first_name || 'друг';
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `Привет, <b>${escapeHtml(firstName)}</b>! 🎉\n\n` +
        '<b>PartyUp</b> — коробка с играми для шумной компании. ' +
        'Ничего не надо устанавливать: открыл, выбрал игру — играешь.\n\n' +
        '🎴 <b>11 игр в одном приложении</b>\n' +
        '   Элиас, Крокодил, Шпион, Мем-батл, 5 секунд, «Кто я?» и ещё 5\n' +
        '👥 <b>От 2 до 20 человек</b>\n' +
        '   На одном телефоне, по очереди — или сидя в кружок\n' +
        '⚡ <b>Старт за 3 секунды</b>\n' +
        '   Без регистрации, аккаунтов и инструкций\n' +
        '🆓 <b>Бесплатно навсегда</b>\n' +
        '   Без рекламы и платных карточек\n\n' +
        '👇 Жми кнопку и зови друзей',
      reply_markup: playButton,
    });
    return;
  }

  if (cmd === '/help') {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        '<b>Как это работает</b>\n\n' +
        '1. Жми «🎮 Играть» — откроется коробка с играми\n' +
        '2. Выбирай игру под настроение компании\n' +
        '3. Передавайте телефон по кругу или играйте на одном экране\n\n' +
        'Если что-то не работает или есть идея — напиши прямо сюда, ' +
        'мы читаем все сообщения.',
      reply_markup: playButton,
    });
    return;
  }

  // дефолт: на любое сообщение всё равно показать кнопку
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Жми «🎮 Играть» 👇',
    reply_markup: playButton,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: 'partyup', ts: Date.now() });
    }

    if (url.pathname === '/api/tg/webhook' && request.method === 'POST') {
      // защита: Telegram присылает наш секрет в этом заголовке
      const secret = request.headers.get('x-telegram-bot-api-secret-token');
      if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        const update = await request.json();
        await handleUpdate(update, env);
      } catch (e) {
        console.error('webhook error', e);
      }
      return new Response('ok');
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'not_implemented' }, { status: 404 });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('PartyUp', { status: 200 });
  },
};
