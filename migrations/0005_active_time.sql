-- Учёт активного времени игрока (сумма ms на собственных ходах).
ALTER TABLE session_players ADD COLUMN active_ms INTEGER DEFAULT 0;
