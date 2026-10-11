-- Curated image stickers stored as base64 in D1 for the initial MVP.
-- Keep the payload limit conservative: QQ's upload endpoint pulls it through a
-- short-lived, signed Worker URL rather than accepting file_data directly.
CREATE TABLE IF NOT EXISTS sticker_assets (
  name TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
  data_base64 TEXT NOT NULL CHECK (length(data_base64) BETWEEN 4 AND 2097152),
  tags_json TEXT NOT NULL DEFAULT '[]',
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sticker_assets_enabled_usage
ON sticker_assets (enabled, usage_count, name);
