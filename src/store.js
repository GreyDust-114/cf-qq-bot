import {
  AUTONOMOUS_COOLDOWN_MAX_MS,
  AUTONOMOUS_COOLDOWN_MIN_MS,
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_MESSAGES,
  CONTEXT_WINDOW_MS,
  MEMORY_DIGESTS_INJECTED,
} from "./config.js";

import { randomBetween, truncateStoredContent } from "./pure.js";

export function createStore(deps) {
  const db = () => deps.env.DB;

  async function ensureConversation(conversationId, kind) {
    const now = deps.now();

    await db()
      .prepare(
        `INSERT INTO conversations
           (conversation_id, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id)
         DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .bind(conversationId, kind, now, now)
      .run();
  }

  async function storeIncomingMessage(incoming) {
    const result = await db()
      .prepare(
        `INSERT OR IGNORE INTO messages
           (conversation_id, event_id, role, sender_name, member_openid,
            content, created_at)
         VALUES (?, ?, 'user', ?, ?, ?, ?)`,
      )
      .bind(
        incoming.conversationId,
        incoming.eventId,
        incoming.senderName ?? null,
        incoming.memberOpenid ?? null,
        truncateStoredContent(incoming.content),
        deps.now(),
      )
      .run();

    const changes = result.meta?.changes ?? 0;

    return {
      isNew: changes > 0,
      rowId: Number(result.meta?.last_row_id ?? 0),
    };
  }

  async function loadConversationContext(conversationId) {
    const summaryRow = await db()
      .prepare(
        `SELECT summary
         FROM conversations
         WHERE conversation_id = ?`,
      )
      .bind(conversationId)
      .first();

    const since = deps.now() - CONTEXT_WINDOW_MS;

    const { results } = await db()
      .prepare(
        `SELECT role, sender_name, content, created_at, event_id
         FROM messages
         WHERE conversation_id = ? AND created_at >= ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .bind(conversationId, since, CONTEXT_MAX_MESSAGES)
      .all();

    const rows = (results ?? []).slice().reverse();

    let totalChars = 0;
    const kept = [];

    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const nextTotal = totalChars + row.content.length;

      if (nextTotal > CONTEXT_MAX_CHARS && kept.length > 0) {
        break;
      }

      totalChars = nextTotal;
      kept.push(row);
    }

    kept.reverse();

    return {
      summary: summaryRow?.summary ?? "",
      digests: await loadRecentDigests(
        conversationId,
        MEMORY_DIGESTS_INJECTED,
      ),
      messages: kept,
    };
  }

  // 近期 digest：失败（例如迁移未应用）时按无记忆运行，不阻断回复。
  async function loadRecentDigests(conversationId, limit) {
    try {
      const { results } = await db()
        .prepare(
          `SELECT period_start, period_end, content
           FROM memory_digests
           WHERE conversation_id = ?
           ORDER BY period_end DESC, period_start DESC
           LIMIT ?`,
        )
        .bind(conversationId, limit)
        .all();

      return (results ?? []).slice().reverse();
    } catch (error) {
      deps.logger.error("memory digests read failed:", error);
      return [];
    }
  }

  // Character lore: written by the local corpus sync script and read on every
  // batch. A missing table (migration not applied) must not break replies.
  async function loadLore() {
    try {
      const { results } = await db()
        .prepare(
          `SELECT title, content
           FROM lore
           ORDER BY sort_order, id`,
        )
        .all();

      return results ?? [];
    } catch (error) {
      deps.logger.error("lore read failed:", error);
      return [];
    }
  }

  async function storeAssistantMessage(conversationId, content) {
    const result = await db()
      .prepare(
        `INSERT INTO messages
           (conversation_id, event_id, role, sender_name, content, created_at)
         VALUES (?, NULL, 'assistant', NULL, ?, ?)`,
      )
      .bind(conversationId, content, deps.now())
      .run();

    return Number(result.meta?.last_row_id ?? 0);
  }

  // Outbox: one row per generated bubble. Rows are created as pending before
  // the network call, then updated in place so every state change survives a
  // crash. Writes are intentionally not swallowed: a failed write must surface
  // as a batch error so the coordinator can retry with the same msg_seq.
  async function ensureOutboxParts(entries) {
    const now = deps.now();

    for (const entry of entries) {
      await db()
        .prepare(
          `INSERT OR IGNORE INTO outbox
             (conversation_id, batch_id, revision, route, part_index,
              msg_seq, content, status, attempts, trigger_event_id,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .bind(
          entry.conversationId,
          entry.batchId,
          entry.revision,
          entry.route,
          entry.partIndex,
          entry.msgSeq,
          entry.content,
          entry.triggerEventId ?? null,
          now,
          now,
        )
        .run();
    }
  }

  async function getOutboxPart(batchId, partIndex) {
    const row = await db()
      .prepare(
        `SELECT id, content, status, assistant_message_id
         FROM outbox
         WHERE batch_id = ? AND part_index = ?`,
      )
      .bind(batchId, partIndex)
      .first();

    return row ?? null;
  }

  async function markOutboxSent(
    batchId,
    partIndex,
    options = {},
  ) {
    await db()
      .prepare(
        `UPDATE outbox
         SET status = 'sent', attempts = attempts + ?,
             qq_message_id = ?, assistant_message_id = ?,
             error = NULL, updated_at = ?
         WHERE batch_id = ? AND part_index = ?`,
      )
      .bind(
        options.attempts ?? 1,
        options.qqMessageId ?? null,
        options.assistantMessageId ?? null,
        deps.now(),
        batchId,
        partIndex,
      )
      .run();
  }

  async function markOutboxAssistant(
    batchId,
    partIndex,
    assistantMessageId,
  ) {
    await db()
      .prepare(
        `UPDATE outbox
         SET assistant_message_id = ?, updated_at = ?
         WHERE batch_id = ? AND part_index = ?`,
      )
      .bind(
        assistantMessageId,
        deps.now(),
        batchId,
        partIndex,
      )
      .run();
  }

  async function markOutboxFailure(batchId, partIndex, options) {
    await db()
      .prepare(
        `UPDATE outbox
         SET status = ?, attempts = attempts + ?, error = ?,
             updated_at = ?
         WHERE batch_id = ? AND part_index = ?`,
      )
      .bind(
        options.status,
        options.attempts ?? 1,
        String(options.error ?? "").slice(0, 300),
        deps.now(),
        batchId,
        partIndex,
      )
      .run();
  }

  async function getNextAutonomousAt(conversationId) {
    try {
      const row = await db()
        .prepare(
          `SELECT next_autonomous_at
           FROM conversations
           WHERE conversation_id = ?`,
        )
        .bind(conversationId)
        .first();

      return Number(row?.next_autonomous_at ?? 0);
    } catch (error) {
      deps.logger.error("next_autonomous_at read failed:", error);
      return 0;
    }
  }

  async function markAutonomousReply(conversationId) {
    const now = deps.now();
    const nextAt = Math.round(
      now +
        randomBetween(
          AUTONOMOUS_COOLDOWN_MIN_MS,
          AUTONOMOUS_COOLDOWN_MAX_MS,
          deps.random,
        ),
    );

    try {
      await db()
        .prepare(
          `UPDATE conversations
           SET next_autonomous_at = ?, updated_at = ?
           WHERE conversation_id = ?`,
        )
        .bind(nextAt, now, conversationId)
        .run();
    } catch (error) {
      deps.logger.error("next_autonomous_at write failed:", error);
    }
  }

  // Active chat window: the bot just replied in this group. `speaker` is the
  // member whose message carried the reply; their follow-ups can continue the
  // conversation without another @ or a model decision.
  async function markActiveWindow(conversationId, speaker, until) {
    try {
      await db()
        .prepare(
          `UPDATE conversations
           SET active_until = ?, active_speaker_member_openid = ?,
               updated_at = ?
           WHERE conversation_id = ?`,
        )
        .bind(until, speaker ?? null, deps.now(), conversationId)
        .run();
    } catch (error) {
      deps.logger.error("active window write failed:", error);
    }
  }

  async function getActiveWindow(conversationId) {
    try {
      const row = await db()
        .prepare(
          `SELECT active_until, active_speaker_member_openid
           FROM conversations
           WHERE conversation_id = ?`,
        )
        .bind(conversationId)
        .first();

      return {
        until: Number(row?.active_until ?? 0),
        speaker: row?.active_speaker_member_openid ?? null,
      };
    } catch (error) {
      deps.logger.error("active window read failed:", error);
      return { until: 0, speaker: null };
    }
  }

  // ── 长期记忆（BOT-017）─────────────────────────────────
  //
  // 摘要任务只通过下面这组函数读写：选会话、取待压缩区间、写字据与画像、
  // 推进水位线、删除已压缩的原文。删除永远发生在写入成功之后（由
  // src/memory.js 保证顺序），这里的删除函数本身不做额外判断。
  async function listConversationsWithBacklog({ before, limit }) {
    const { results } = await db()
      .prepare(
        `SELECT c.conversation_id, c.kind,
                COALESCE(c.summarized_until, 0) AS summarized_until,
                MIN(m.created_at) AS oldest_pending,
                COUNT(*) AS pending_count
         FROM conversations c
         JOIN messages m
           ON m.conversation_id = c.conversation_id
          AND m.created_at >= COALESCE(c.summarized_until, 0)
          AND m.created_at < ?
         GROUP BY c.conversation_id, c.kind, c.summarized_until
         ORDER BY oldest_pending
         LIMIT ?`,
      )
      .bind(before, limit)
      .all();

    return results ?? [];
  }

  async function loadMemoryState(conversationId) {
    const row = await db()
      .prepare(
        `SELECT summary, summarized_until
         FROM conversations
         WHERE conversation_id = ?`,
      )
      .bind(conversationId)
      .first();

    return {
      profile: row?.summary ?? "",
      summarizedUntil: Number(row?.summarized_until ?? 0),
    };
  }

  // 取最早的一段待压缩原文（升序前缀），字符上限在 JS 侧按条累加，
  // 保证截断点一定落在「已取条目的最后一条」之后，水位线不会跳过内容。
  async function loadMemoryBacklog(
    conversationId,
    { from, to, maxMessages, maxChars },
  ) {
    const { results } = await db()
      .prepare(
        `SELECT id, role, sender_name, member_openid, content, created_at
         FROM messages
         WHERE conversation_id = ? AND created_at >= ? AND created_at < ?
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .bind(conversationId, from, to, maxMessages)
      .all();

    const rows = results ?? [];
    const kept = [];
    let totalChars = 0;

    for (const row of rows) {
      const nextTotal = totalChars + row.content.length;

      if (nextTotal > maxChars && kept.length > 0) {
        break;
      }

      totalChars = nextTotal;
      kept.push(row);
    }

    return kept;
  }

  async function saveMemoryDigest(entry) {
    await db()
      .prepare(
        `INSERT INTO memory_digests
           (conversation_id, period_start, period_end, kind, content,
            message_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, period_start)
         DO UPDATE SET period_end = excluded.period_end,
                       content = excluded.content,
                       message_count = excluded.message_count`,
      )
      .bind(
        entry.conversationId,
        entry.periodStart,
        entry.periodEnd,
        entry.kind ?? "daily",
        entry.content,
        entry.messageCount ?? 0,
        deps.now(),
      )
      .run();
  }

  async function commitMemoryProgress({
    conversationId,
    profile,
    summarizedUntil,
  }) {
    const now = deps.now();

    await db()
      .prepare(
        `UPDATE conversations
         SET summary = ?, summary_updated_at = ?, summarized_until = ?,
             updated_at = ?
         WHERE conversation_id = ?`,
      )
      .bind(profile, now, summarizedUntil, now, conversationId)
      .run();
  }

  async function countMessagesBefore(conversationId, until) {
    const row = await db()
      .prepare(
        `SELECT COUNT(*) AS n
         FROM messages
         WHERE conversation_id = ? AND created_at < ?`,
      )
      .bind(conversationId, until)
      .first();

    return Number(row?.n ?? 0);
  }

  // 删除已压缩的原文。除了水位线，这里再要求「落在某段 digest 区间内」，
  // 作为第二道保险：即使水位线被误推进，也不会删掉没有摘要覆盖的消息。
  async function deleteMessagesBefore(conversationId, until) {
    const result = await db()
      .prepare(
        `DELETE FROM messages
         WHERE conversation_id = ? AND created_at < ?
           AND EXISTS (
             SELECT 1 FROM memory_digests d
              WHERE d.conversation_id = messages.conversation_id
                AND d.period_start <= messages.created_at
                AND messages.created_at <= d.period_end
           )`,
      )
      .bind(conversationId, until)
      .run();

    return Number(result.meta?.changes ?? 0);
  }

  return {
    ensureConversation,
    storeIncomingMessage,
    loadConversationContext,
    loadRecentDigests,
    loadLore,
    storeAssistantMessage,
    getNextAutonomousAt,
    markAutonomousReply,
    markActiveWindow,
    getActiveWindow,
    ensureOutboxParts,
    getOutboxPart,
    markOutboxSent,
    markOutboxAssistant,
    markOutboxFailure,
    listConversationsWithBacklog,
    loadMemoryState,
    loadMemoryBacklog,
    saveMemoryDigest,
    commitMemoryProgress,
    countMessagesBefore,
    deleteMessagesBefore,
  };
}
