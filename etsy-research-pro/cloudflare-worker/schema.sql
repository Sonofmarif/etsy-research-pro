-- Etsy Research Pro — Cloudflare D1 Schema
-- Free tier: 5GB storage, 5M reads/day, 100K writes/day

CREATE TABLE IF NOT EXISTS research_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword     TEXT NOT NULL,
  product_type TEXT DEFAULT 'any',
  win_score   INTEGER DEFAULT 0,
  total       INTEGER DEFAULT 0,
  wins        INTEGER DEFAULT 0,
  beatable    INTEGER DEFAULT 0,
  avg_price   REAL DEFAULT 0,
  ai_mode     TEXT DEFAULT 'math',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_keyword ON research_runs(keyword);
CREATE INDEX IF NOT EXISTS idx_runs_created ON research_runs(created_at);

CREATE TABLE IF NOT EXISTS seed_keywords (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  category  TEXT NOT NULL,
  keyword   TEXT NOT NULL,
  priority  INTEGER DEFAULT 0,
  active    INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seeds_category ON seed_keywords(category);

CREATE TABLE IF NOT EXISTS trending_niches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT NOT NULL UNIQUE,
  run_count    INTEGER DEFAULT 1,
  avg_score    REAL DEFAULT 0,
  last_score   INTEGER DEFAULT 0,
  trend        TEXT DEFAULT 'stable',  -- 'up', 'down', 'stable'
  first_seen   TEXT DEFAULT (datetime('now')),
  last_updated TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trending_keyword ON trending_niches(keyword);
CREATE INDEX IF NOT EXISTS idx_trending_score ON trending_niches(avg_score DESC);

-- Table for frontend error reporting
CREATE TABLE IF NOT EXISTS error_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  error_message TEXT NOT NULL,
  stack_trace   TEXT,
  url           TEXT,
  user_agent    TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_errors_created ON error_logs(created_at);

-- Table for community shared micro-niches
CREATE TABLE IF NOT EXISTS shared_niches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword           TEXT NOT NULL UNIQUE,
  category          TEXT,
  niche_score       INTEGER DEFAULT 0,
  demand_score      INTEGER DEFAULT 0,
  competition_score INTEGER DEFAULT 0,
  image_prompt      TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shared_niches_score ON shared_niches(niche_score DESC);
CREATE INDEX IF NOT EXISTS idx_shared_niches_keyword ON shared_niches(keyword);

-- Table for saving research snapshots
CREATE TABLE IF NOT EXISTS research_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword     TEXT NOT NULL,
  payload     TEXT NOT NULL, -- JSON object string capturing aggregate metrics (total listings, average reviews, beatable slots found)
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_keyword ON research_snapshots(keyword);
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON research_snapshots(created_at);



