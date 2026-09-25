// 长期记忆：把超过保留期的原文压成 digest 与长期画像（BOT-017）。
//
// 顺序固定：写 digest → 更新画像与水位线 → 删除该区间原文。
// 任何一步失败都不删除，下一次运行会重取同一区间（digest 主键天然幂等）。
//
// 水位线语义（见 db/migrations/0005_memory.sql）：
//   summarized_until 表示「小于该时刻的原文都已经进过摘要」，
//   取区间用 `created_at >= summarized_until` 且 `created_at < 压缩期边界`，
//   删除用 `created_at < min(summarized_until, 保留期边界)`，
//   两条边界严格一致，不留缝隙；压缩期短于保留期时不会提前删掉原文。
//
// dry_run（默认开）只写入报告与日志，不删除原文；用户确认后再把
// MEMORY_DRY_RUN 置为 "false" 开启删除。

import {
  MEMORY_COMPACT_AFTER_MS,
  MEMORY_DIGEST_MAX_CHARS,
  MEMORY_DRY_RUN_DEFAULT,
  MEMORY_MAX_CHARS_PER_CHUNK,
  MEMORY_MAX_CHUNKS_PER_CONVERSATION,
  MEMORY_MAX_CONVERSATIONS_PER_RUN,
  MEMORY_MAX_MESSAGES_PER_CHUNK,
  MEMORY_MAX_TOKENS,
  MEMORY_PROFILE_MAX_CHARS,
  MEMORY_RETENTION_MS,
  MEMORY_TIMEOUT_MS,
} from "./config.js";

import { createLlmClient } from "./llm.js";
import {
  memorySystemPrompt,
  memoryUserPrompt,
  parseMemoryOutput,
} from "./prompts.js";
import { createStore } from "./store.js";

import { formatMessageTime, truncateStoredContent } from "./pure.js";

function clamp(text, maxChars) {
  const value = String(text ?? "").trim();

  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

// 原文行格式与回复上下文一致：时间与发言人只用于定位，提示词要求不写进结果。
function renderTranscript(rows) {
  return rows
    .map((row) => {
      const who =
        row.role === "assistant"
          ? "机器人"
          : row.sender_name || "群成员";

      return `[${formatMessageTime(row.created_at)}] [${who}] ${row.content}`;
    })
    .join("\n");
}

export function createMemoryRunner(deps) {
  const store = createStore(deps);
  const llm = createLlmClient(deps);

  function isDryRun(options) {
    if (typeof options.dryRun === "boolean") {
      return options.dryRun;
    }

    const fromEnv = String(deps.env.MEMORY_DRY_RUN ?? "").trim();

    if (fromEnv === "false") {
      return false;
    }

    if (fromEnv === "true") {
      return true;
    }

    return MEMORY_DRY_RUN_DEFAULT;
  }

  function retentionMs(options) {
    const days = Number(deps.env.MEMORY_RETENTION_DAYS);

    if (Number.isFinite(days) && days >= 0) {
      return days * 24 * 60 * 60 * 1000;
    }

    return options.retentionMs ?? MEMORY_RETENTION_MS;
  }

  function compactAfterMs(options) {
    const days = Number(deps.env.MEMORY_COMPACT_AFTER_DAYS);

    if (Number.isFinite(days) && days >= 0) {
      return days * 24 * 60 * 60 * 1000;
    }

    return options.compactAfterMs ?? MEMORY_COMPACT_AFTER_MS;
  }

  // 压缩一个会话的一段区间；返回 null 表示没有需要处理的内容。
  async function compactChunk(conversation, context) {
    const { cutoff, deleteCutoff, dryRun, deadline } = context;
    const { conversationId, kind } = conversation;

    const state = await store.loadMemoryState(conversationId);
    const from = state.summarizedUntil;

    if (from >= cutoff) {
      return null;
    }

    const rows = await store.loadMemoryBacklog(conversationId, {
      from,
      to: cutoff,
      maxMessages: MEMORY_MAX_MESSAGES_PER_CHUNK,
      maxChars: MEMORY_MAX_CHARS_PER_CHUNK,
    });

    if (rows.length === 0) {
      return null;
    }

    const periodStart = rows[0].created_at;
    const periodEnd = rows[rows.length - 1].created_at;
    const transcript = renderTranscript(rows);

    const raw = await llm.callDeepSeekWithFallback(
      () => [
        {
          role: "system",
          content: memorySystemPrompt({
            profileChars: MEMORY_PROFILE_MAX_CHARS,
            digestChars: MEMORY_DIGEST_MAX_CHARS,
          }),
        },
        {
          role: "user",
          content: memoryUserPrompt({
            profile: state.profile,
            transcript,
            kind,
          }),
        },
      ],
      {
        maxTokens: MEMORY_MAX_TOKENS,
        label: "memory",
        timeoutMs: MEMORY_TIMEOUT_MS,
      },
      false,
      deadline,
    );

    const parsed = parseMemoryOutput(raw, state.profile);

    if (!parsed.ok) {
      return {
        conversationId,
        status: "parse-failed",
        reason: parsed.reason,
        messages: rows.length,
      };
    }

    const digest = clamp(
      truncateStoredContent(parsed.digest),
      MEMORY_DIGEST_MAX_CHARS,
    );
    const profile = clamp(
      truncateStoredContent(parsed.profile),
      MEMORY_PROFILE_MAX_CHARS,
    );

    if (!digest) {
      return {
        conversationId,
        status: "parse-failed",
        reason: "empty-digest",
        messages: rows.length,
      };
    }

    // 水位线只能落在「最后一条已压缩消息」之后；如果这一块已经把保留期
    // 边界内的消息全部覆盖，就直接推进到 cutoff，下一次从边界继续。
    const stepped = periodEnd + 1;
    const summarizedUntil = stepped >= cutoff ? cutoff : stepped;

    await store.saveMemoryDigest({
      conversationId,
      periodStart,
      periodEnd,
      kind: "daily",
      content: digest,
      messageCount: rows.length,
    });

    await store.commitMemoryProgress({
      conversationId,
      profile,
      summarizedUntil,
    });

    let deleted = 0;
    // 删除还要再等保留期：水质线可能在压缩期内（保留期更长时）。
    const deleteBefore = Math.min(summarizedUntil, deleteCutoff);

    if (!dryRun) {
      deleted = await store.deleteMessagesBefore(conversationId, deleteBefore);
    } else {
      deleted = await store.countMessagesBefore(conversationId, deleteBefore);
    }

    deps.logger.log(
      `stage=memory conversation=${conversationId} kind=${kind} ` +
        `messages=${rows.length} ` +
        `from=${new Date(periodStart).toISOString()} ` +
        `to=${new Date(periodEnd).toISOString()} ` +
        `until=${new Date(summarizedUntil).toISOString()} ` +
        `delete_before=${new Date(deleteBefore).toISOString()} ` +
        `digest=${digest.length} profile=${profile.length} ` +
        `deleted=${deleted} dry_run=${dryRun}` +
        (parsed.warning ? ` warning=${parsed.warning}` : ""),
    );

    return {
      conversationId,
      status: dryRun ? "dry-run" : "compacted",
      messages: rows.length,
      periodStart,
      periodEnd,
      summarizedUntil,
      digestChars: digest.length,
      profileChars: profile.length,
      deleted,
      warning: parsed.warning,
    };
  }

  async function compactConversation(conversation, context) {
    const chunks = [];

    for (
      let index = 0;
      index < MEMORY_MAX_CHUNKS_PER_CONVERSATION;
      index += 1
    ) {
      let result;

      try {
        result = await compactChunk(conversation, context);
      } catch (error) {
        deps.logger.error(
          `stage=memory failed conversation=${conversation.conversationId}:`,
          error,
        );

        chunks.push({
          conversationId: conversation.conversationId,
          status: "error",
          reason: String(error?.message ?? error),
        });
        break;
      }

      if (!result || result.status === "parse-failed") {
        if (result) {
          chunks.push(result);
        }

        break;
      }

      chunks.push(result);

      if (result.summarizedUntil >= context.cutoff) {
        break;
      }
    }

    return chunks;
  }

  async function runOnce(options = {}) {
    const dryRun = isDryRun(options);
    const cutoff = deps.now() - compactAfterMs(options);
    const deleteCutoff = deps.now() - retentionMs(options);
    const startedAt = deps.now();
    const deadline = startedAt + (options.budgetMs ?? 60 * 1000);

    const conversations = await store.listConversationsWithBacklog({
      before: cutoff,
      limit: MEMORY_MAX_CONVERSATIONS_PER_RUN,
    });

    const results = [];
    let failures = 0;

    for (const conversation of conversations) {
      const chunks = await compactConversation(
        {
          conversationId: conversation.conversation_id,
          kind: conversation.kind,
        },
        { cutoff, deleteCutoff, dryRun, deadline },
      );

      failures += chunks.filter((chunk) => chunk.status === "error").length;

      results.push({
        conversationId: conversation.conversation_id,
        kind: conversation.kind,
        pending: Number(conversation.pending_count ?? 0),
        chunks,
      });
    }

    const summary = {
      dryRun,
      cutoff,
      deleteCutoff,
      conversations: results.length,
      chunks: results.reduce((sum, item) => sum + item.chunks.length, 0),
      messages: results.reduce(
        (sum, item) =>
          sum +
          item.chunks.reduce(
            (inner, chunk) => inner + Number(chunk.messages ?? 0),
            0,
          ),
        0,
      ),
      deleted: results.reduce(
        (sum, item) =>
          sum +
          item.chunks.reduce(
            (inner, chunk) => inner + Number(chunk.deleted ?? 0),
            0,
          ),
        0,
      ),
      failures,
      elapsedMs: deps.now() - startedAt,
    };

    deps.logger.log(
      `stage=memory done conversations=${summary.conversations} ` +
        `chunks=${summary.chunks} messages=${summary.messages} ` +
        `deleted=${summary.deleted} failures=${failures} dry_run=${dryRun} ` +
        `elapsed=${summary.elapsedMs}ms`,
    );

    // 单个会话失败不影响其他会话（已写入的仍保留），但整轮仍要报失败，
    // 这样 cron 记录为失败、可被告警看到。
    if (failures > 0) {
      throw new Error(`stage=memory ${failures} chunk(s) failed`);
    }

    return { ...summary, results };
  }

  return { runOnce, compactConversation };
}
