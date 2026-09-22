-- Initial schema for qq-ai-bot.
--
-- This migration is idempotent: every object is created with IF NOT EXISTS,
-- so it is safe to apply once to a database that was originally provisioned
-- by hand from the README, and it is also correct for a brand new database.
--
-- Wrangler records applied migrations in the d1_migrations table.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('c2c', 'group')),
  summary TEXT NOT NULL DEFAULT '',
  summary_updated_at INTEGER,
  last_autonomous_reply_at INTEGER,
  next_autonomous_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  event_id TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  sender_name TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversations(conversation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
ON messages (conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
