-- BOT-020 sticker learning loop.
--
-- Sticker assets now accept the formats QQ users actually send. The previous
-- CHECK constraint only allowed PNG/JPEG, so the table has to be rebuilt;
-- migrations run in order, so the rebuild copies whatever the earlier schema
-- held (asset rows are curated and few).
CREATE TABLE IF NOT EXISTS sticker_assets_next (
  name TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL CHECK (
    mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
  ),
  data_base64 TEXT NOT NULL CHECK (length(data_base64) BETWEEN 4 AND 2097152),
  tags_json TEXT NOT NULL DEFAULT '[]',
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  fingerprint TEXT,
  note TEXT NOT NULL DEFAULT ''
);

INSERT OR REPLACE INTO sticker_assets_next
  (name, mime_type, data_base64, tags_json, usage_count, enabled,
   created_at, updated_at, fingerprint, note)
SELECT name, mime_type, data_base64, tags_json, usage_count, enabled,
       created_at, updated_at, fingerprint, note
FROM sticker_assets;

DROP TABLE sticker_assets;
ALTER TABLE sticker_assets_next RENAME TO sticker_assets;

CREATE INDEX IF NOT EXISTS idx_sticker_assets_enabled_usage
ON sticker_assets (enabled, usage_count, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_assets_fingerprint
ON sticker_assets (fingerprint);

-- Recent occurrences/sends are the evidence the owner uses to refine a
-- sticker's meaning. Rows are pruned per fingerprint when new ones are added.
CREATE TABLE IF NOT EXISTS sticker_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inbound', 'outbound')),
  conversation_id TEXT,
  context TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sticker_usage_fingerprint_time
ON sticker_usage (fingerprint, created_at DESC);
