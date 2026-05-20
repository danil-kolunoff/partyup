// Inline-режим бота @PartyUp_Gamebot.
// Пользователь набирает «@PartyUp_Gamebot <команда>» в любом чате,
// бот предлагает inline-результаты, юзер выбирает — сообщение уходит в чат.
//
// Поддержанные команды (RU/EN, регистр-независимо):
//   ""              → топ-игры
//   "помощь" | "help" | "?"      → справка по командам
//   "игры" | "games"            → каталог всех игр
//   "<id игры>" | "<название>"  → карточка игры с кнопкой «Открыть»
//   "вайб <X>" | "vibe <X>"     → подборка игр под вайб
//   "room ABCDEF" | "комната ABCDEF" → приглашение в комнату
//   "правда" | "truth"          → случайная карточка-вопрос «Правда»
//   "действие" | "dare"         → случайная карточка-задание «Действие»
//   "никогда" | "never"         → случайная «Я никогда не…»
//   "whoofus" | "кто из нас" → случайный «Кто из нас»
//   "карточка" | "random"       → 4 случайные карточки разных типов
//   "позвать" | "invite"        → красивая пригласительная карточка

export const INLINE_GAMES = [
  { id: 'truth',        title: 'Правда или действие',  emoji: '🎯', short: 'Узнаешь о друзьях такое, что не забудешь', players: '3–10', vibes: ['warmup','funny'] },
  { id: 'never',        title: 'Я никогда не…',         emoji: '🙅', short: 'Чья жизнь богаче? Сейчас разберёмся',     players: '3–12', vibes: ['warmup','funny','deep'] },
  { id: 'whoofus',      title: 'Кто из нас',            emoji: '👥', short: 'Голосование о том, кто в комнате…',       players: '4–12', vibes: ['funny'] },
  { id: 'would_rather', title: 'Что выберешь?',         emoji: '⚖️', short: 'Дилемма: А или Б, голосуй и спорь',      players: '2–12', vibes: ['warmup','funny','deep'] },
  { id: 'five',         title: '5 секунд',              emoji: '⏱️', short: 'Назови 3 ответа за 5 секунд',             players: '3–10', vibes: ['warmup','funny'] },
  { id: 'spy',          title: 'Шпион',                 emoji: '🕵️', short: 'Найди шпиона среди своих',                players: '4–10', vibes: ['funny','deep'] },
  { id: 'alias',        title: 'Элиас',                 emoji: '💬', short: 'Объясняй слова — командой против времени', players: '4–12', vibes: ['warmup','funny'] },
  { id: 'crocodile',    title: 'Крокодил',              emoji: '🧠', short: 'Показывай слово без слов',                players: '3–12', vibes: ['warmup','funny'] },
  { id: 'whoami',       title: 'Кто я?',                emoji: '🔎', short: 'Угадай, кем тебя загадали',               players: '3–8',  vibes: ['funny','new_people'] },
  { id: 'associations', title: 'Ассоциации',            emoji: '✨', short: 'Цепочка ассоциаций без повторов',         players: '3–10', vibes: ['warmup'] },
];

export const VIBE_LABELS = {
  warmup: '✨ Разогрев', funny: '😂 Смешной', spicy: '🌶️ Острый',
  chill: '🌙 Расслабленный', new_people: '🤝 Новые люди',
  deep: '❤️ Близкие друзья', adult: '🔞 18+',
};

// Мини-пул карточек для inline (полный пул живёт во фронте).
export const INLINE_CARDS = {
  truth: [
    'Какое самое неловкое сообщение ты отправил не тому человеку?',
    'Что бы ты сделал, если бы никто никогда не узнал?',
    'Кому из присутствующих ты больше всего завидуешь?',
    'Что ты никогда не скажешь маме, но расскажешь нам?',
    'Какая твоя самая странная привычка, о которой мало кто знает?',
    'Какую ложь ты повторял так часто, что почти сам поверил?',
    'Чем ты занимался в интернете и потом удалял историю браузера?',
    'Если бы ты мог прочитать мысли одного человека в комнате — чьи?',
    'Опиши свой самый неловкий момент на публике.',
    'Что в тебе изменилось за последний год, что замечают другие?',
  ],
  dare: [
    'Спой первый куплет любой песни максимально серьёзно.',
    'Изобрази животное — остальные угадывают.',
    'Сделай комплимент каждому в комнате — за 30 секунд.',
    'Позвони кому-нибудь из контактов и скажи «Я тебя помню!»',
    'Изобрази, как другой игрок ходит. Пусть остальные угадают кто.',
    'Сделай лучший танцевальный ход, который ты знаешь.',
    'Расскажи анекдот. Если никто не засмеялся — расскажи ещё один.',
    'Покажи самое неловкое фото у себя в телефоне.',
    'Сделай «рекламный ролик» для любого предмета в комнате — 20 сек.',
    'Скажи каждому в комнате, на кого из известных людей он похож.',
  ],
  never: [
    'врал, что «уже еду», находясь дома',
    'гуглил себя',
    'притворялся, что не видел сообщение',
    'делал вид, что сплю, чтобы не вставать',
    'ел что-то прямо над раковиной',
    'удалял сообщение сразу после отправки',
    'разговаривал с домашним животным как с человеком',
    'засыпал в общественном транспорте и просыпался на чужой остановке',
    'отправлял письмо или сообщение не тому адресату',
    'делал вид, что занят телефоном, чтобы избежать общения',
  ],
  whoofus: [
    'разбогатеет первым из нас?',
    'забудет день рождения лучшего друга?',
    'станет звездой соцсетей?',
    'переедет в другую страну?',
    'будет спорить с таксистом?',
    'случайно поставит лайк бывшему в 2 ночи?',
    'влюбится с первого взгляда в случайного человека?',
    'останется работать на этой же работе через 10 лет?',
    'станет родителем первым из нас?',
    'дольше всех собирается утром?',
  ],
};

function uid() { return Math.random().toString(36).slice(2, 10); }
function pick(arr, n = 1) {
  const a = [...arr]; const out = [];
  for (let i = 0; i < n && a.length; i++) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]);
  return out;
}
function norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }

function gameResult(env, game, directLink) {
  const link = directLink(env, `g_${game.id}`);
  const text =
    `${game.emoji} <b>${game.title}</b>\n` +
    `${game.short}\n` +
    `👥 ${game.players}\n\n` +
    `Открыть в PartyUp: ${link}`;
  return {
    type: 'article',
    id: `game_${game.id}_${uid()}`,
    title: `${game.emoji} ${game.title}`,
    description: `${game.short} • ${game.players}`,
    input_message_content: { message_text: text, parse_mode: 'HTML' },
    reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть PartyUp', url: link }]] },
  };
}

function cardResult(env, kind, text, directLink) {
  const labels = { truth: '🎯 Правда', dare: '🔥 Действие', never: '🙅 Я никогда не…', whoofus: '👥 Кто из нас' };
  const games  = { truth: 'truth', dare: 'truth', never: 'never', whoofus: 'whoofus' };
  const link = directLink(env, `g_${games[kind] || 'truth'}`);
  const messageText =
    `<b>${labels[kind] || 'Карточка'}</b>\n\n` +
    `${kind === 'never' ? 'Я никогда не ' : ''}${text}\n\n` +
    `🎮 Сыграть полную игру: ${link}`;
  return {
    type: 'article',
    id: `card_${kind}_${uid()}`,
    title: `${labels[kind]} — ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`,
    description: kind === 'never' ? `«Я никогда не ${text.slice(0, 60)}…»` : text.slice(0, 80),
    input_message_content: { message_text: messageText, parse_mode: 'HTML' },
    reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть PartyUp', url: link }]] },
  };
}

function inviteResult(env, directLink) {
  const link = directLink(env, 'from_inline');
  return {
    type: 'article',
    id: `invite_${uid()}`,
    title: '🎉 Позвать друзей в PartyUp',
    description: 'Лучшие игры для компаний — старт за 10 секунд',
    input_message_content: {
      message_text:
        `🎉 <b>Зову играть в PartyUp!</b>\n` +
        `Лучшие игры для компаний в одном приложении. Выбор вайба меняет весь контент и тон. Мультиплеер с друзьями в два клика.\n\n` +
        `Старт за 10 секунд, без регистраций:\n${link}`,
      parse_mode: 'HTML',
    },
    reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть PartyUp', url: link }]] },
  };
}

function roomResult(env, roomId, directLink) {
  const link = directLink(env, `room_${roomId}`);
  return {
    type: 'article',
    id: `room_${roomId}_${uid()}`,
    title: `🚪 Войти в комнату ${roomId}`,
    description: `Присоединись к игре в PartyUp`,
    input_message_content: {
      message_text:
        `🎮 <b>Зову в комнату ${roomId}</b>\n\n` +
        `Жми, чтобы войти:\n${link}`,
      parse_mode: 'HTML',
    },
    reply_markup: { inline_keyboard: [[{ text: `🚪 Войти в ${roomId}`, url: link }]] },
  };
}

function vibeResult(env, vibeId, directLink) {
  const games = INLINE_GAMES.filter(g => g.vibes.includes(vibeId)).slice(0, 5);
  if (!games.length) return null;
  const label = VIBE_LABELS[vibeId] || vibeId;
  const link = directLink(env, `vibe_${vibeId}`);
  const list = games.map(g => `• ${g.emoji} ${g.title} — ${g.short}`).join('\n');
  return {
    type: 'article',
    id: `vibe_${vibeId}_${uid()}`,
    title: `${label} — подборка игр`,
    description: games.map(g => g.title).join(' • '),
    input_message_content: {
      message_text: `<b>${label} — что сыграть</b>\n\n${list}\n\n🎮 Открыть: ${link}`,
      parse_mode: 'HTML',
    },
    reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть PartyUp', url: link }]] },
  };
}

// Интерактивные мини-игры в чате через callback_query.
// Inline result отправляет сообщение «нажми кнопку», обработчик callback_query
// в worker.js делает editMessageText с inline_message_id и обновляет результат.
function coinResult(env, directLink) {
  return {
    type: 'article',
    id: `coin_${uid()}`,
    title: '🪙 Подбросить монетку',
    description: 'Орёл или Решка — кнопка в чате',
    input_message_content: {
      message_text: '🪙 <b>Монетка</b>\n\nЖми кнопку, чтобы подбросить:',
      parse_mode: 'HTML',
    },
    reply_markup: {
      inline_keyboard: [[
        { text: '🪙 Подбросить', callback_data: 'coin' },
      ]],
    },
  };
}
function diceResult(env, sides, directLink) {
  return {
    type: 'article',
    id: `d${sides}_${uid()}`,
    title: `🎲 Бросить d${sides}`,
    description: `Случайное число от 1 до ${sides}`,
    input_message_content: {
      message_text: `🎲 <b>Кубик d${sides}</b>\n\nЖми кнопку, чтобы бросить:`,
      parse_mode: 'HTML',
    },
    reply_markup: {
      inline_keyboard: [[
        { text: `🎲 Бросить d${sides}`, callback_data: `dice_${sides}` },
      ]],
    },
  };
}
function pickPersonResult(env, directLink) {
  return {
    type: 'article',
    id: `who_${uid()}`,
    title: '🎯 Выбрать случайного',
    description: 'Соберёт желающих и выберет одного',
    input_message_content: {
      message_text:
        '🎯 <b>Кого выбираем?</b>\n\n' +
        'Все, кто хочет участвовать — жмите «Я в деле». ' +
        'Когда соберётесь, любой может нажать «Выбрать!».\n\n' +
        '<i>Участников пока нет</i>',
      parse_mode: 'HTML',
    },
    reply_markup: {
      inline_keyboard: [
        [{ text: '✋ Я в деле', callback_data: 'who_join' }],
        [{ text: '🎲 Выбрать!', callback_data: 'who_pick' }],
      ],
    },
  };
}

function helpResult(env, directLink) {
  return {
    type: 'article',
    id: `help_${uid()}`,
    title: '❔ Помощь — команды @PartyUp_Gamebot',
    description: 'правда • действие • room ABC • вайб смешной • <название игры>',
    input_message_content: {
      message_text:
        `<b>Что умеет @PartyUp_Gamebot inline</b>\n\n` +
        `• <code>@PartyUp_Gamebot</code> — топ-игры\n` +
        `• <code>@PartyUp_Gamebot правда</code> — случайная карточка «Правда»\n` +
        `• <code>@PartyUp_Gamebot действие</code> — случайное «Действие»\n` +
        `• <code>@PartyUp_Gamebot никогда</code> — «Я никогда не…»\n` +
        `• <code>@PartyUp_Gamebot скорее</code> — «Кто скорее всего…»\n` +
        `• <code>@PartyUp_Gamebot карточка</code> — 4 случайные карточки\n` +
        `• <code>@PartyUp_Gamebot вайб смешной</code> — подборка игр\n` +
        `• <code>@PartyUp_Gamebot шпион</code> — карточка конкретной игры\n` +
        `• <code>@PartyUp_Gamebot room ABCDEF</code> — пригласить в комнату\n` +
        `• <code>@PartyUp_Gamebot позвать</code> — приглашение друзьям\n\n` +
        `<b>Мини-игры прямо в чате:</b>\n` +
        `• <code>монетка</code> — подбросить монетку\n` +
        `• <code>d6</code> / <code>d20</code> / <code>d100</code> — кубики\n` +
        `• <code>выбрать</code> — случайно выбрать из участников\n\n` +
        `Открыть приложение: ${directLink(env, 'help')}`,
      parse_mode: 'HTML',
    },
  };
}

function findGame(query) {
  const q = norm(query);
  if (!q) return null;
  return INLINE_GAMES.find(g =>
    g.id === q ||
    norm(g.title) === q ||
    norm(g.title).startsWith(q) ||
    q.includes(g.id)
  );
}

const VIBE_ALIASES = {
  warmup: ['warmup','разогрев','лёгкий','лёгкое','лайт','легкий','легкое'],
  funny:  ['funny','смешной','смех','смешно','весёлый','веселый','юмор'],
  spicy:  ['spicy','острый','остро','перчик','горячий','флирт'],
  chill:  ['chill','расслаб','расслабленный','тихий','спокойный'],
  new_people: ['new','новые','знакомство','новые люди','новички'],
  deep:   ['deep','глубокий','близкие','глубже','серьёзный','серьезный'],
  adult:  ['18+','adult','взрослый'],
};

function findVibe(query) {
  const q = norm(query);
  for (const [id, aliases] of Object.entries(VIBE_ALIASES)) {
    if (aliases.some(a => q === a || q.includes(a))) return id;
  }
  return null;
}

// Главный обработчик inline_query → массив результатов для answerInlineQuery.
export function buildInlineResults(env, query, directLink) {
  const raw = String(query || '').trim();
  const q = norm(raw);

  // 1. ПУСТО → invite + интерактив + топ-игры + помощь
  if (!q) {
    return [
      inviteResult(env, directLink),
      coinResult(env, directLink),
      diceResult(env, 20, directLink),
      ...INLINE_GAMES.slice(0, 4).map(g => gameResult(env, g, directLink)),
      helpResult(env, directLink),
    ];
  }

  // 2. ПОМОЩЬ
  if (/^(help|помощь|\?|команды|cmd)/i.test(q)) {
    return [helpResult(env, directLink)];
  }

  // 3. ПРИГЛАШЕНИЕ
  if (/^(invite|позвать|пригласить|join|друз)/i.test(q)) {
    return [inviteResult(env, directLink)];
  }

  // 4. КОМНАТА: "room ABCDEF" / "комната ABCDEF" / отдельно код
  const roomMatch = raw.match(/(?:room|комната)\s+([A-Za-z0-9]{4,12})/i)
                 || raw.match(/^([A-Z0-9]{6})$/);
  if (roomMatch) {
    return [roomResult(env, roomMatch[1].toUpperCase(), directLink)];
  }

  // 4.5 ИНТЕРАКТИВНЫЕ МИНИ-ИГРЫ
  if (/^(coin|монет|орёл|орел|решка)/i.test(q)) {
    return [coinResult(env, directLink)];
  }
  if (/^(d20|кубик 20|двадцат)/i.test(q)) {
    return [diceResult(env, 20, directLink)];
  }
  if (/^(d6|кубик|dice|зар)/i.test(q)) {
    return [diceResult(env, 6, directLink), diceResult(env, 20, directLink)];
  }
  if (/^(d100|сот)/i.test(q)) {
    return [diceResult(env, 100, directLink)];
  }
  if (/^(выбра|случайн человек|pick|кто|random person|жереб)/i.test(q)) {
    return [pickPersonResult(env, directLink)];
  }
  if (/^(дуэль|duel|быстрее)/i.test(q)) {
    // duel — это просто d2 (по сути «кто первый» — без сложной механики)
    return [diceResult(env, 2, directLink)];
  }

  // 5. КАРТОЧКИ
  if (/^(truth|правда)/i.test(q)) {
    return pick(INLINE_CARDS.truth, 4).map(t => cardResult(env, 'truth', t, directLink));
  }
  if (/^(dare|действ)/i.test(q)) {
    return pick(INLINE_CARDS.dare, 4).map(t => cardResult(env, 'dare', t, directLink));
  }
  if (/^(never|никогда)/i.test(q)) {
    return pick(INLINE_CARDS.never, 4).map(t => cardResult(env, 'never', t, directLink));
  }
  if (/^(whoofus|кто из|кто из нас)/i.test(q)) {
    return pick(INLINE_CARDS.whoofus, 4).map(t => cardResult(env, 'whoofus', t, directLink));
  }
  if (/^(card|карточка|random|случай)/i.test(q)) {
    return [
      cardResult(env, 'truth', pick(INLINE_CARDS.truth, 1)[0], directLink),
      cardResult(env, 'dare', pick(INLINE_CARDS.dare, 1)[0], directLink),
      cardResult(env, 'never', pick(INLINE_CARDS.never, 1)[0], directLink),
      cardResult(env, 'whoofus', pick(INLINE_CARDS.whoofus, 1)[0], directLink),
    ];
  }

  // 6. ВАЙБ: "vibe X" / "вайб X" / просто алиас
  let vibeId = null;
  const vMatch = raw.match(/^(?:vibe|вайб|настроение)\s+(.+)$/i);
  if (vMatch) vibeId = findVibe(vMatch[1]);
  if (!vibeId) vibeId = findVibe(q);
  if (vibeId) {
    const games = INLINE_GAMES.filter(g => g.vibes.includes(vibeId)).slice(0, 5);
    const vr = vibeResult(env, vibeId, directLink);
    return [vr, ...games.map(g => gameResult(env, g, directLink))].filter(Boolean);
  }

  // 7. КАТАЛОГ
  if (/^(games|игры|каталог|all|все)/i.test(q)) {
    return INLINE_GAMES.slice(0, 12).map(g => gameResult(env, g, directLink));
  }

  // 8. КОНКРЕТНАЯ ИГРА
  const game = findGame(raw);
  if (game) {
    const related = INLINE_GAMES.filter(g => g.id !== game.id && g.vibes.some(v => game.vibes.includes(v))).slice(0, 3);
    return [gameResult(env, game, directLink), ...related.map(g => gameResult(env, g, directLink))];
  }

  // 9. FUZZY — частичное совпадение по названиям
  const fuzzy = INLINE_GAMES.filter(g => norm(g.title).includes(q) || g.id.includes(q));
  if (fuzzy.length) return fuzzy.slice(0, 6).map(g => gameResult(env, g, directLink));

  // 10. Ничего не нашли → помощь + invite
  return [helpResult(env, directLink), inviteResult(env, directLink)];
}
