-- Одноразовые токены логина через бота: сайт создаёт, бот подтверждает.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_created ON auth_tokens(created_at);
