-- Per-bubble send outbox.
--
-- Every generated bubble gets a row before the QQ API call and is updated in
-- place afterwards, so partial failures, timeouts or crashes never silently
-- lose (or duplicate) what actually happened. (batch_id, part_index) is
-- unique and msg_seq = part_index on every retry, so a resend of the same
-- part stays idempotent on the QQ side.

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  route TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  msg_seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'sent', 'failed', 'uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,
  trigger_event_id TEXT,
  qq_message_id TEXT,
  assistant_message_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (batch_id, part_index)
);

CREATE INDEX IF NOT EXISTS idx_outbox_conversation_time
ON outbox (conversation_id, updated_at);
