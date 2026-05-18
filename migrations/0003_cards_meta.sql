-- Расширение таблицы cards: intensity (1-5) и meta (JSON для специфичных полей).
-- meta используется как: spy.locations → {"role": "spy_location"},
-- taboo → {"taboo": ["слово1","слово2","слово3","слово4","слово5"]},
-- bunker → {"slot": "catastrophe|profession|trait|fact|item"},
-- mafia → {"role": "Мафия|Доктор|Шериф|…"}, и т.д.
ALTER TABLE cards ADD COLUMN intensity INTEGER DEFAULT 2;
ALTER TABLE cards ADD COLUMN meta TEXT;
CREATE INDEX IF NOT EXISTS idx_cards_game_vibes ON cards(game_id);
