-- BOT-020 fingerprint labels and owner-pull review queue.
-- Image bytes are transiently fetched for hashing/upload and never persisted.
-- A short-lived source URL is AES-GCM encrypted at rest, cleared after ask,
-- and made unusable at expiry (physical cleanup occurs on the next owner pull).
CREATE TABLE IF NOT EXISTS sticker_semantics (
  fingerprint TEXT PRIMARY KEY CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  label TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'asked', 'confirmed', 'ignored')),
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source_url_ciphertext TEXT,
  source_url_expires_at INTEGER,
  asked_at INTEGER,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sticker_semantics_review_queue
ON sticker_semantics (status, first_seen_at);

CREATE TABLE IF NOT EXISTS sticker_review_quota (
  month_key TEXT PRIMARY KEY,
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  updated_at INTEGER NOT NULL
);
