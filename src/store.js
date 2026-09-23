import {
  AUTONOMOUS_COOLDOWN_MAX_MS,
  AUTONOMOUS_COOLDOWN_MIN_MS,
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_MESSAGES,
  CONTEXT_WINDOW_MS,
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
           (conversation_id, event_id, role, sender_name, content, created_at)
         VALUES (?, ?, 'user', ?, ?, ?)`,
      )
      .bind(
        incoming.conversationId,
        incoming.eventId,
        incoming.senderName ?? null,
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
      messages: kept,
    };
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

  return {
    ensureConversation,
    storeIncomingMessage,
    loadConversationContext,
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
  };
}
