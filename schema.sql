-- Pursuit — D1 schema (run once in Cloudflare D1 console)

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  pin_hash        TEXT NOT NULL,
  salt            TEXT NOT NULL,
  cv_raw          TEXT,
  cv_json         TEXT,
  prefs           TEXT,
  intake          TEXT,
  failed_attempts INTEGER DEFAULT 0,
  locked_until    INTEGER DEFAULT 0,
  req_date        TEXT,
  req_count       INTEGER DEFAULT 0,
  created_at      INTEGER
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT,
  company     TEXT,
  location    TEXT,
  type        TEXT,
  url         TEXT,
  source      TEXT,
  summary     TEXT,
  jd          TEXT,
  score       INTEGER,
  reason      TEXT,
  tags        TEXT,
  stage       TEXT DEFAULT 'discovered',
  tailored_cv TEXT,
  draft_email TEXT,
  cover_letter   TEXT,
  interview_prep TEXT,
  notes       TEXT,
  fingerprint TEXT,
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id);

-- ------------------------------------------------------------------
-- ALREADY created the database on v1.0? Run ONLY this block instead:
-- ALTER TABLE jobs ADD COLUMN cover_letter TEXT;
-- ALTER TABLE jobs ADD COLUMN interview_prep TEXT;
-- CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER);
-- CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id);
-- ------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_fp   ON jobs(user_id, fingerprint);
