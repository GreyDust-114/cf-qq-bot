-- 长期记忆：说话人身份、摘要水位线与按区间的 digest。
--
-- 与既有 migration 的约定一致：本文件只建结构与列，不写入数据；
-- 内容由 Worker 的每日摘要任务（scheduled）写入。
--
-- summarized_until 的语义是「小于该时刻的原文都已经进过摘要」：
-- 摘要任务按 `created_at >= summarized_until AND created_at < now - 压缩期`
-- 取区间，写完 digest 与画像后才推进水位线；删除另外受保留期约束
-- （`created_at < min(summarized_until, now - 保留期)`），且必须被某段 digest 覆盖。

ALTER TABLE messages ADD COLUMN member_openid TEXT;

ALTER TABLE conversations ADD COLUMN summarized_until INTEGER;

CREATE TABLE IF NOT EXISTS memory_digests (
  conversation_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'daily',
  content TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_memory_digests_conversation_end
ON memory_digests (conversation_id, period_end);
