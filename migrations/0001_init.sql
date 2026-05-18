-- PartyUp D1 schema — v1
-- Сущности: users, anon_users, sessions, session_players, rooms, room_players,
-- events, daily_stats, packs, cards, user_packs, purchases.

CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_premium INTEGER DEFAULT 0,
  photo_url TEXT,
  emoji TEXT DEFAULT '😎',
  display_name TEXT,
  total_games INTEGER DEFAULT 0,
  total_wins INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  default_vibe TEXT DEFAULT 'warmup',
  premium_until INTEGER,
  ref_user_id INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS anon_users (
  anon_id TEXT PRIMARY KEY,
  emoji TEXT,
  name TEXT,
  total_games INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  anon_id TEXT,
  game_id TEXT NOT NULL,
  vibe TEXT,
  mode TEXT,
  players_count INTEGER,
  rounds_total INTEGER,
  rounds_played INTEGER DEFAULT 0,
  room_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_sec INTEGER,
  finished INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_game ON sessions(game_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS session_players (
  session_id TEXT NOT NULL,
  player_local_id TEXT NOT NULL,
  user_id INTEGER,
  name TEXT,
  emoji TEXT,
  score INTEGER DEFAULT 0,
  reactions_received INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, player_local_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  host_user_id INTEGER,
  host_anon_id TEXT,
  game_id TEXT,
  vibe TEXT,
  rounds INTEGER DEFAULT 6,
  state TEXT DEFAULT 'lobby',
  round_index INTEGER DEFAULT 0,
  players_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rooms_host ON rooms(host_user_id);
CREATE INDEX IF NOT EXISTS idx_rooms_state ON rooms(state);

CREATE TABLE IF NOT EXISTS room_players (
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  user_id INTEGER,
  anon_id TEXT,
  name TEXT,
  emoji TEXT,
  is_host INTEGER DEFAULT 0,
  ready INTEGER DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, player_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  anon_id TEXT,
  session_id TEXT,
  room_id TEXT,
  type TEXT NOT NULL,
  game_id TEXT,
  vibe TEXT,
  props TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);

CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  game_id TEXT NOT NULL DEFAULT '',
  value INTEGER DEFAULT 0,
  PRIMARY KEY (day, metric, game_id)
);

CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  game_id TEXT,
  vibe TEXT,
  is_premium INTEGER DEFAULT 0,
  price_stars INTEGER DEFAULT 0,
  cards_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id TEXT,
  game_id TEXT NOT NULL,
  type TEXT,
  text TEXT NOT NULL,
  vibes TEXT,
  source TEXT DEFAULT 'admin',
  author_user_id INTEGER,
  approved INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_game ON cards(game_id);
CREATE INDEX IF NOT EXISTS idx_cards_pack ON cards(pack_id);

CREATE TABLE IF NOT EXISTS user_packs (
  user_id INTEGER NOT NULL,
  pack_id TEXT NOT NULL,
  source TEXT,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pack_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  item_type TEXT,
  item_id TEXT,
  stars INTEGER,
  status TEXT DEFAULT 'pending',
  tg_payment_charge_id TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
