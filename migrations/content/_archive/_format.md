# Формат контента карточек

Каждая строка — `INSERT INTO cards (game_id, type, text, vibes, intensity, source, approved, created_at) VALUES (...)`.

Поля:
- `game_id` — id игры (truth, never, whoofus, most, hot_seat, fact, alias, taboo, crocodile, five, associations, whoami, memes, spy, mafia, bunker).
- `type` — короткий лейбл («Правда», «Действие», «Я никогда не…», «Кто из нас», «Вопрос», «Слово», и т.п.). Берёт его UI для подсказки.
- `text` — собственно карточка. Без HTML-тегов, без кавычек-`backtick`. Одинарные кавычки экранируем двойным символом: `'' `.
- `vibes` — csv тегов вайба, к которым подходит карточка (`warmup,funny` / `adult` / `ultra_adult` / NULL для нейтральных).
- `intensity` — 1..5 (1 — лёгкая, 5 — острая/жёсткая).
- `source` — `'admin'`.
- `approved` — `1`.
- `created_at` — `strftime('%s','now')*1000`.

Для taboo:
```sql
INSERT INTO cards (game_id, type, text, vibes, intensity, meta, source, approved, created_at)
VALUES ('taboo', 'Слово', 'Котлета', 'warmup,funny', 2,
        json_object('forbidden', json_array('мясо','еда','круглая','фарш','жарить')),
        'admin', 1, strftime('%s','now')*1000);
```

Для bunker character cards meta:
```sql
INSERT INTO cards (game_id, type, text, vibes, intensity, meta, source, approved, created_at)
VALUES ('bunker', 'Профессия', 'Хирург', NULL, 3, json_object('slot','profession'), 'admin', 1, strftime('%s','now')*1000);
```

slot ∈ {profession, age, health, skill, phobia, baggage, fact, catastrophe}.

Для mafia ролей:
```sql
INSERT INTO cards (game_id, type, text, vibes, intensity, meta, source, approved, created_at)
VALUES ('mafia', 'Роль', 'Мафия — ночью убивает мирного', NULL, 3,
        json_object('role','Мафия','side','мафия'), 'admin', 1, strftime('%s','now')*1000);
```

Для spy: text = название локации.

## Гайдлайны вайбов

- **warmup** (intensity 1-2): лёгкое, для прогрева, никаких острых тем.
- **funny** (intensity 2-3): забавно, бытовые мемные ситуации.
- **spicy** (intensity 3-4): провокационно, флирт, лёгкие признания.
- **chill** (intensity 1-3): спокойно, разговоры по душам, без давления.
- **new_people** (intensity 1-2): для знакомств, безопасные темы.
- **deep** (intensity 2-4): глубже, эмоции, прошлое, отношения.
- **adult** (intensity 4-5): откровенный 18+ контент, темы секса/отношений.
- **ultra_adult** (intensity 5): для пар и близких 24+. Жёсткие интимные подробности, кринжовые сексуальные ситуации, фантазии, провалы в постели.
