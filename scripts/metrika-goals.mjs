#!/usr/bin/env node
/**
 * Создаёт/обновляет JS-цели в Яндекс.Метрике для счётчика PartyUp.
 *
 * Использование:
 *   YA_OAUTH_TOKEN=AQAAAA... node scripts/metrika-goals.mjs
 *
 * Получить токен: https://oauth.yandex.ru/authorize?response_type=token&client_id=<client_id>
 * — нужен скоуп `metrika-api`. Самый простой путь:
 *   1. https://oauth.yandex.com/client/new — создать своё приложение,
 *      скоупы: «Просмотр статистики, чтение параметров своих и доверенных счётчиков»
 *              + «Изменение настроек своих и доверенных счётчиков».
 *   2. Скопировать ClientID, открыть https://oauth.yandex.ru/authorize?response_type=token&client_id=<ClientID>
 *   3. Подтвердить → токен прилетит в URL (#access_token=...).
 *
 * Альтернатива: уже существующий personal токен с доступом к Метрике.
 *
 * Документация: https://yandex.ru/dev/metrika/ru/management/openapi/goal/createGoal
 */

const COUNTER_ID = 109262837;
const TOKEN = process.env.YA_OAUTH_TOKEN;

if (!TOKEN) {
  console.error('❌ Установи переменную окружения YA_OAUTH_TOKEN');
  console.error('   YA_OAUTH_TOKEN=AQAAAA... node scripts/metrika-goals.mjs');
  process.exit(1);
}

// type: 'action' — JS-цель (срабатывает по reachGoal); name — внутреннее имя
// в Метрике (видно в отчётах); flag для условия конверсии не задаём (1 хит = 1 конверсия).
const GOALS = [
  // навигация / онбординг
  { name: 'open',         desc: 'Открытие Mini App' },
  { name: 'auth_ok',      desc: 'Успешная авторизация TG/анон' },
  { name: 'vibe_change',  desc: 'Смена вайба' },
  { name: 'picker_use',   desc: 'Открыт подборщик игр' },

  // выбор и игра
  { name: 'game_select',  desc: 'Карточка игры открыта' },
  { name: 'game_start',   desc: 'Запущена сессия' },
  { name: 'round_start',  desc: 'Раунд начался' },
  { name: 'round_end',    desc: 'Раунд закончился' },
  { name: 'game_finish',  desc: 'Игра завершена' },

  // вирусность
  { name: 'share',        desc: 'Юзер поделился (главная/лобби/итоги)' },
  { name: 'room_create',  desc: 'Создана онлайн-комната' },
  { name: 'room_join',    desc: 'Юзер зашёл в комнату по ссылке' },
  { name: 'room_leave',   desc: 'Юзер вышел из комнаты' },

  // монетизация
  { name: 'paywall_view', desc: 'Показан пейволл' },
  { name: 'purchase',     desc: 'Покупка совершена (Stars)' },
];

const API = `https://api-metrika.yandex.net/management/v1/counter/${COUNTER_ID}/goals`;

async function request(method, path = '', body = null) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `OAuth ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function listGoals() {
  const r = await request('GET', '');
  if (!r.ok) {
    console.error('❌ Не удалось получить список целей:', r.status, r.data);
    process.exit(1);
  }
  return r.data.goals || [];
}

async function createGoal(g) {
  const body = {
    goal: {
      name: g.desc || g.name,
      type: 'action',
      conditions: [{ type: 'exact', url: g.name }],
      is_retargeting: 0,
    },
  };
  return request('POST', '', body);
}

(async () => {
  console.log(`→ Получаю текущие цели счётчика ${COUNTER_ID}…`);
  const existing = await listGoals();
  const existingNames = new Set(
    existing.flatMap(g => (g.conditions || []).map(c => c.url))
  );
  console.log(`  Уже создано: ${existing.length} целей`);

  let created = 0, skipped = 0, failed = 0;
  for (const g of GOALS) {
    if (existingNames.has(g.name)) {
      console.log(`⏭  skip   ${g.name}`);
      skipped++;
      continue;
    }
    const r = await createGoal(g);
    if (r.ok) {
      console.log(`✅ create ${g.name} — «${g.desc}»`);
      created++;
    } else {
      console.error(`❌ fail   ${g.name}:`, r.status, r.data);
      failed++;
    }
  }

  console.log(`\nИтого: создано ${created}, пропущено ${skipped}, ошибок ${failed}.`);
  console.log('Открой: https://metrika.yandex.ru/settings/goals?id=' + COUNTER_ID);
})().catch(e => { console.error(e); process.exit(1); });
