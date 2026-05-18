-- Состояние "ждём support-сообщение от юзера" — после /start support бот
-- ставит флаг, и следующее сообщение пересылается админу.
CREATE TABLE IF NOT EXISTS support_pending (
  tg_id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL
);
