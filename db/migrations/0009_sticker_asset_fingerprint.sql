-- Link curated outbound assets to the inbound semantic fingerprint library.
-- Multiple NULLs are allowed for assets not yet verified against an inbound sticker.
ALTER TABLE sticker_assets ADD COLUMN fingerprint TEXT;
ALTER TABLE sticker_assets ADD COLUMN note TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_assets_fingerprint
ON sticker_assets (fingerprint);
