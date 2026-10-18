// Batch processor: everything that turns one coordinator batch into a real
// reply. It is intentionally independent from the webhook handler so the
// Durable Object and the offline tests can run the exact same code.
//
// Facts still live in D1: recordIncoming writes the user message as soon as
// the coordinator accepts it, and assistant messages are written after a
// successful send. Stale output (a newer revision or a lost lease) is dropped
// before the first bubble and re-checked between bubbles.

import {
  ACTIVE_WINDOW_MS,
  INVOCATION_BUDGET_MS,
  MAX_IMAGES_PER_BATCH,
  MIN_STAGE_BUDGET_MS,
  PART_GAP_MAX_MS,
  SEND_BUDGET_RESERVE_MS,
  STICKER_SOURCE_URL_TTL_MS,
  WEB_FETCH_TIMEOUT_MS,
  WEB_SEARCH_TIMEOUT_MS,
  stickerCooldownMs,
  stickerReviewMonthlyLimit,
} from "./config.js";
import { createDependencies } from "./dependencies.js";
import { createLlmClient } from "./llm.js";
import {
  FALLBACK_ERROR_REPLY,
  FALLBACK_MENTION_REPLY,
  FALLBACK_UNSAFE_REPLY,
  STICKER_VISION_SYSTEM_PROMPT,
} from "./prompts.js";
import { createReplySender } from "./sender.js";
import { createStickerMediaUrl } from "./sticker-media.js";
import {
  STICKER_ASSET_MIME_TYPES,
  decryptStickerSourceUrl,
  encryptStickerSourceUrl,
  fetchStickerImage,
  fingerprintStickerBytes,
  normalizeStickerNote,
  parseOwnerStickerCommand,
  parseStickerVisionSuggestion,
  stickerAssetName,
  stickerBytesToBase64,
  stickerReviewId,
} from "./stickers.js";
import { createStore } from "./store.js";
import { createTokenManager } from "./token.js";
import {
  classifyWebError,
  createWebTools,
  detectSearchIntent,
  extractUrls,
  formatSearchContext,
  formatWebContext,
  webLogLine,
} from "./web.js";

import {
  buildGroupMessages,
  buildPrivateMessages,
  parseReplyOutput,
  parseStickerMarker,
  replyPartGapMs,
  stripTimePrefix,
} from "./pure.js";

function currentBatchImageCount(trigger) {
  const entries = Array.isArray(trigger.currentBatchImages)
    ? trigger.currentBatchImages
    : [{ imageUrls: trigger.imageUrls }];

  return entries.reduce((total, entry) => {
    const imageUrls = Array.isArray(entry?.imageUrls) ? entry.imageUrls : [];
    return total + new Set(imageUrls).size;
  }, 0);
}

function selectCurrentBatchImages(messages, targetEventId) {
  const entries = messages
    .map((message, index) => ({
      eventId: message.eventId,
      index,
      imageUrls: [...new Set(message.imageUrls ?? [])],
    }))
    .filter((entry) => entry.eventId && entry.imageUrls.length > 0);
  const prioritized = [...entries].sort((left, right) => {
    if (left.eventId === targetEventId) return -1;
    if (right.eventId === targetEventId) return 1;
    return right.index - left.index;
  });
  const selected = new Map();
  let remaining = MAX_IMAGES_PER_BATCH;

  for (const entry of prioritized) {
    const imageUrls = entry.imageUrls.slice(0, remaining);
    if (imageUrls.length > 0) selected.set(entry.eventId, imageUrls);
    remaining -= imageUrls.length;
    if (remaining === 0) break;
  }

  return entries
    .filter((entry) => selected.has(entry.eventId))
    .map((entry) => ({
      eventId: entry.eventId,
      imageUrls: selected.get(entry.eventId),
    }));
}

function stickerUsageContext(content) {
  return normalizeStickerNote(
    String(content ?? "").replace(/【贴纸(?::[^】]*)?】/gu, " "),
  ).slice(0, 120);
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

export function createProcessor(env, overrides = {}) {
  const deps = createDependencies(env, overrides);

  const store = createStore(deps);
  const tokenManager = createTokenManager(deps);
  const llm = createLlmClient(deps);
  const sender = createReplySender(deps, tokenManager);
  const web = createWebTools(deps);

  // D1 is the fact log: a message is recorded once, when the coordinator
  // accepts the event. `messages.event_id` keeps the write idempotent.
  async function recordIncoming(incoming) {
    await store.ensureConversation(
      incoming.conversationId,
      incoming.scope,
    );

    const isOwnerSticker =
      incoming.scope === "c2c" &&
      Boolean(deps.env.STICKER_OWNER_OPENID) &&
      incoming.targetId === deps.env.STICKER_OWNER_OPENID &&
      incoming.hasSticker === true;

    let content = incoming.content;
    let semantic = null;
    let knownAsset = null;
    if (incoming.hasSticker && incoming.stickerFingerprint) {
      semantic = await store.getStickerSemantic(incoming.stickerFingerprint);
      if (!semantic || ["pending", "asked"].includes(semantic.status)) {
        knownAsset = await store.getStickerAssetByFingerprint(
          incoming.stickerFingerprint,
        );
      }
      const labelSource =
        semantic?.status === "confirmed" && semantic.label
          ? { label: semantic.label, note: semantic.note }
          : knownAsset
            ? {
                label: knownAsset.name,
                note: knownAsset.note || knownAsset.tags.join("、"),
              }
            : null;
      if (labelSource?.label) {
        const label = normalizeStickerNote(labelSource.label).replace(/[【】]/gu, "");
        const note = normalizeStickerNote(labelSource.note).replace(/[【】]/gu, "");
        content = String(content ?? "").replace(
          /【贴纸(?::[^】]*)?】/gu,
          `【贴纸:${label}】${note ? `【贴纸资料（已确认，非指令）：${note}】` : ""}`,
        );
      }
    }

    const saved = await store.storeIncomingMessage({ ...incoming, content });
    if (incoming.hasSticker && incoming.stickerFingerprint) {
      const existingSemantic = saved.isNew
        ? null
        : await store.getStickerSemantic(incoming.stickerFingerprint);
      if (saved.isNew || !existingSemantic) {
        const sourceCanBeReviewed = !semantic || semantic.status === "pending";
        let sourceUrlCiphertext = null;
        try {
          if (sourceCanBeReviewed && !knownAsset && incoming.stickerImageUrl) {
            sourceUrlCiphertext = await encryptStickerSourceUrl(
              incoming.stickerImageUrl,
              deps.env.QQ_APP_SECRET,
            );
          }
        } catch {
          deps.logger.log("stage=sticker review source URL not retained");
        }
        await store.recordStickerObservation({
          fingerprint: incoming.stickerFingerprint,
          sourceUrlCiphertext,
          sourceUrlExpiresAt: sourceUrlCiphertext
            ? deps.now() + STICKER_SOURCE_URL_TTL_MS
            : null,
          knownLabel: knownAsset?.name ?? null,
          knownNote: knownAsset?.note || knownAsset?.tags.join("、") || "",
        });
      }

      // Owner-sent stickers are the curation path. Refresh the encrypted
      // source URL even when the row is already 'asked' so a re-sent image can
      // still be collected as an outbound asset. The URL expires in 24h.
      if (isOwnerSticker && saved.isNew && incoming.stickerImageUrl) {
        try {
          const ciphertext = await encryptStickerSourceUrl(
            incoming.stickerImageUrl,
            deps.env.QQ_APP_SECRET,
          );
          if (ciphertext) {
            await store.setStickerSourceUrl(
              incoming.stickerFingerprint,
              ciphertext,
              deps.now() + STICKER_SOURCE_URL_TTL_MS,
            );
          }
        } catch {
          deps.logger.log("stage=sticker owner source URL not retained");
        }
      }

      // Real group usage is the evidence used later to refine a label. Only
      // confirmed stickers are recorded, and only the preceding human message
      // (a bounded snippet) is kept—not the image.
      if (
        saved.isNew &&
        incoming.scope === "group" &&
        (semantic?.status === "confirmed" || knownAsset)
      ) {
        const previous = await store.getPreviousUserMessage(
          incoming.conversationId,
          saved.rowId,
        );
        await store.recordStickerUsage({
          fingerprint: incoming.stickerFingerprint,
          kind: "inbound",
          conversationId: incoming.conversationId,
          context: normalizeStickerNote(previous ?? "").slice(0, 120),
        });
      }
    }
    return saved;
  }

  function prefetchToken() {
    return tokenManager.fetchAccessToken().catch((error) => {
      deps.logger.error("stage=token prefetch failed:", error);
      return null;
    });
  }

  // BOT-025-01/02: path A. The Worker decides from explicit URLs or search
  // intent in the current batch, runs at most one external tool before the
  // single reply call, and appends the result as untrusted reference material.
  // A URL takes precedence; a failed tool only removes the block and never
  // blocks the normal reply.
  async function loadWebContext(trigger, batchMessages, deadline) {
    if (
      String(deps.env.WEB_TOOLS_ENABLED ?? "").trim().toLowerCase() ===
      "false"
    ) {
      deps.logger.log(
        webLogLine({ tool: "web", status: "skipped", reason: "disabled" }),
      );
      return null;
    }

    // Private batches are one-to-one; group batches only use the target's own
    // messages. A link another member posted for someone else must not be
    // fetched just because the target @-mentioned the bot in the same batch.
    const sameSender = (message) => {
      if (trigger.scope === "c2c") return true;
      if (trigger.memberOpenid != null) {
        return message.memberOpenid === trigger.memberOpenid;
      }
      return message.senderName === trigger.senderName;
    };
    const source = [
      trigger.content,
      ...batchMessages
        .filter(
          (message) =>
            message.eventId !== trigger.eventId && sameSender(message),
        )
        .map((message) => message.content),
    ]
      .filter((text) => typeof text === "string" && text)
      .join("\n");
    const urls = extractUrls(source);
    const toolBudget = () =>
      deadline - deps.now() - SEND_BUDGET_RESERVE_MS - MIN_STAGE_BUDGET_MS;

    if (urls.length > 0) {
      const timeoutMs = Math.min(WEB_FETCH_TIMEOUT_MS, toolBudget());

      if (timeoutMs < MIN_STAGE_BUDGET_MS) {
        deps.logger.log(
          webLogLine({ tool: "fetch", status: "skipped", reason: "budget" }),
        );
        return null;
      }

      const pages = [];

      for (const url of urls) {
        try {
          const page = await web.fetchPage(url, { timeoutMs });
          pages.push(page);
          deps.logger.log(
            webLogLine({
              tool: "fetch",
              status: "ok",
              host: safeHost(url),
              http: page.httpStatus,
              ms: page.elapsedMs,
              resultCount: 1,
              chars: page.content.length,
            }),
          );
        } catch (error) {
          deps.logger.log(
            webLogLine({
              tool: "fetch",
              ...classifyWebError(error),
              host: safeHost(url),
            }),
          );
        }
      }

      return formatWebContext(pages, { now: deps.now() });
    }

    const intent = detectSearchIntent(source);

    if (!intent) {
      deps.logger.log(
        webLogLine({
          tool: "web",
          status: "skipped",
          reason: "no-trigger",
        }),
      );
      return null;
    }

    const timeoutMs = Math.min(WEB_SEARCH_TIMEOUT_MS, toolBudget());

    if (timeoutMs < MIN_STAGE_BUDGET_MS) {
      deps.logger.log(
        webLogLine({ tool: "search", status: "skipped", reason: "budget" }),
      );
      return null;
    }

    try {
      const { results, elapsedMs, httpStatus } = await web.search(
        intent.query,
        { timeoutMs },
      );
      const chars = results.reduce(
        (total, result) => total + result.summary.length,
        0,
      );

      if (results.length === 0) {
        deps.logger.log(
          webLogLine({
            tool: "search",
            status: "empty",
            trigger: intent.trigger,
            http: httpStatus,
            ms: elapsedMs,
            resultCount: 0,
            chars: 0,
          }),
        );
        return null;
      }

      deps.logger.log(
        webLogLine({
          tool: "search",
          status: "ok",
          trigger: intent.trigger,
          http: httpStatus,
          ms: elapsedMs,
          resultCount: results.length,
          chars,
        }),
      );

      return formatSearchContext(results, { now: deps.now() });
    } catch (error) {
      deps.logger.log(
        webLogLine({ tool: "search", ...classifyWebError(error) }),
      );
      return null;
    }
  }

  // Sends the validated bubbles one by one and records every state change in
  // the outbox: a pending row exists before each network call, and a sent row
  // plus its own assistant message are written immediately afterwards. A
  // batch re-run skips bubbles that are already sent (stable msg_seq keeps a
  // resend idempotent on the QQ side) and never retries uncertain sends.
  function stickerHistoryContent(content) {
    const name = parseStickerMarker(content);
    if (name) return `【已发送贴纸:${name}】`;
    const review = String(content).match(/^\[sticker-review:([a-f0-9]{8})\]$/u);
    return review ? `【待确认贴纸:${review[1]}】` : content;
  }

  function normalizeDeliveryParts(messages) {
    return (Array.isArray(messages) ? messages : [])
      .map((part) => {
        if (typeof part === "string" && part.trim()) {
          const content = stripTimePrefix(part.trim());
          return content ? { kind: "text", content } : null;
        }
        if (
          part?.kind === "sticker-review" &&
          typeof part.fingerprint === "string" &&
          typeof part.sourceUrl === "string"
        ) {
          return {
            kind: "sticker-review",
            fingerprint: part.fingerprint,
            sourceUrl: part.sourceUrl,
            content: `[sticker-review:${stickerReviewId(part.fingerprint)}]`,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  async function sendStickerReview(trigger, part, deadline, msgSeq, tokenPromise) {
    const uploaded = await sender.uploadImage(
      trigger,
      part.sourceUrl,
      deadline,
      tokenPromise,
    );
    if (!uploaded.ok) {
      deps.logger.log(
        `stage=sticker-review id=${stickerReviewId(part.fingerprint)} result=failed reason=${uploaded.reason}`,
      );
      return uploaded;
    }
    const result = await sender.sendMediaMessage(
      trigger,
      uploaded.fileInfo,
      deadline,
      msgSeq,
      tokenPromise,
    );
    deps.logger.log(
      `stage=sticker-review id=${stickerReviewId(part.fingerprint)} ` +
        `upload_ms=${uploaded.elapsedMs} result=${result.ok ? "sent" : result.uncertain ? "uncertain" : "failed"}`,
    );
    return result;
  }

  async function sendSticker(trigger, name, deadline, msgSeq, tokenPromise) {
    const startedAt = deps.now();
    const asset = await store.getStickerAsset(name);
    if (!asset) {
      deps.logger.log(
        `stage=sticker name=${name} upload_ms=0 result=failed reason=unavailable`,
      );
      return { ok: false, reason: "sticker-unavailable", attempts: 0 };
    }

    const previous = await store.getLastSentSticker(trigger.conversationId);
    if (previous) {
      if (previous.name === name) {
        deps.logger.log(
          `stage=sticker name=${name} upload_ms=0 result=suppressed reason=consecutive`,
        );
        return { ok: false, reason: "sticker-consecutive", attempts: 0 };
      }
      const cooldownMs = stickerCooldownMs(deps.env);
      if (deps.now() - previous.usedAt < cooldownMs) {
        deps.logger.log(
          `stage=sticker name=${name} upload_ms=0 result=suppressed reason=cooldown`,
        );
        return { ok: false, reason: "sticker-cooldown", attempts: 0 };
      }
    }

    let mediaUrl;
    try {
      mediaUrl = await createStickerMediaUrl({
        name,
        baseUrl: deps.env.STICKER_MEDIA_BASE_URL,
        secret: deps.env.QQ_APP_SECRET,
        now: deps.now(),
      });
    } catch (error) {
      deps.logger.error(
        `stage=sticker name=${name} media URL unavailable:`,
        error,
      );
      deps.logger.log(
        `stage=sticker name=${name} upload_ms=0 result=failed reason=media-url`,
      );
      return { ok: false, reason: "sticker-media-url", attempts: 0 };
    }

    const uploaded = await sender.uploadImage(
      trigger,
      mediaUrl,
      deadline,
      tokenPromise,
    );
    if (!uploaded.ok) {
      deps.logger.log(
        `stage=sticker name=${name} ` +
          `upload_ms=${uploaded.elapsedMs ?? deps.now() - startedAt} ` +
          `result=failed reason=${uploaded.reason}`,
      );
      return uploaded;
    }

    const result = await sender.sendMediaMessage(
      trigger,
      uploaded.fileInfo,
      deadline,
      msgSeq,
      tokenPromise,
    );
    deps.logger.log(
      `stage=sticker name=${name} upload_ms=${uploaded.elapsedMs} ` +
        `result=${result.ok ? "sent" : result.uncertain ? "uncertain" : "failed"}` +
        `${result.reason ? ` reason=${result.reason}` : ""}`,
    );
    if (result.ok) {
      await store.markStickerUsed(name);
      await store.recordStickerUsage({
        fingerprint: asset.fingerprint,
        kind: "outbound",
        conversationId: trigger.conversationId,
        context: stickerUsageContext(trigger.content),
      });
    }
    return result;
  }

  async function sendAndStore(
    trigger,
    messages,
    deadline,
    tokenPromise,
    isCurrent,
    batchMeta,
  ) {
    const parts = normalizeDeliveryParts(messages);

    if (parts.length === 0) {
      return { status: "empty", sentTexts: [], stopped: "empty" };
    }

    const base = {
      conversationId: trigger.conversationId,
      batchId: batchMeta.batchId,
      revision: batchMeta.revision,
      route: batchMeta.route,
      triggerEventId: trigger.eventId ?? null,
    };

    await store.ensureOutboxParts(
      parts.map((part, index) => ({
        ...base,
        partIndex: index + 1,
        msgSeq: index + 1,
        content: part.content,
      })),
    );

    const sentTexts = [];
    let stopped = null;

    for (let index = 0; index < parts.length; index += 1) {
      const partIndex = index + 1;
      const existing = await store.getOutboxPart(
        base.batchId,
        partIndex,
      );

      if (existing?.status === "sent") {
        // Already delivered before a crash/retry: repair the assistant link
        // if needed, but never send the bubble again.
        if (!existing.assistant_message_id) {
          const assistantId = await store.storeAssistantMessage(
            trigger.conversationId,
            stickerHistoryContent(existing.content),
          );

          await store.markOutboxAssistant(
            base.batchId,
            partIndex,
            assistantId,
          );
        }

        sentTexts.push(existing.content);
        continue;
      }

      if (
        existing?.status === "failed" ||
        existing?.status === "uncertain"
      ) {
        deps.logger.error(
          `stage=outbox ${existing.status} not retried ` +
            `part=${partIndex} conversation=${base.conversationId} ` +
            `batch=${base.batchId}`,
        );
        stopped =
          existing.status === "uncertain" ? "timeout" : "send-failed";
        break;
      }

      const gate = await isCurrent();

      if (!gate?.current) {
        stopped = "superseded";

        if (sentTexts.length === 0) {
          deps.logger.log(
            `Coordinator: dropping stale reply ` +
              `(${gate?.reason ?? "unknown"})`,
          );
        } else {
          deps.logger.log(
            "Reply parts: newer messages arrived, stopping",
            { reason: gate?.reason ?? "unknown" },
          );
        }

        break;
      }

      if (index > 0) {
        const remaining = deadline - deps.now();

        if (remaining < MIN_STAGE_BUDGET_MS + PART_GAP_MAX_MS) {
          deps.logger.log(
            "Reply parts: budget low, skipping remaining parts",
          );
          stopped = "budget";
          break;
        }

        await deps.sleep(
          replyPartGapMs(parts[index - 1].content, deps.random),
        );
      }

      const part = parts[index];
      const stickerName = parseStickerMarker(part.content);
      const result = stickerName
        ? await sendSticker(
            trigger,
            stickerName,
            deadline,
            partIndex,
            tokenPromise,
          )
        : part.kind === "sticker-review"
          ? await sendStickerReview(
              trigger,
              part,
              deadline,
              partIndex,
              tokenPromise,
            )
          : await sender.sendMessage(
              trigger,
              part.content,
              deadline,
              partIndex,
              tokenPromise,
            );

      if (result.ok) {
        const assistantId = await store.storeAssistantMessage(
          trigger.conversationId,
          stickerHistoryContent(part.content),
        );

        await store.markOutboxSent(base.batchId, partIndex, {
          qqMessageId: result.qqMessageId ?? null,
          assistantMessageId: assistantId,
          attempts: result.attempts,
        });

        sentTexts.push(part.content);
        deps.logger.log(
          `stage=outbox sent part=${partIndex} ` +
            `conversation=${base.conversationId} ` +
            `batch=${base.batchId} revision=${base.revision} ` +
            `msgSeq=${partIndex}`,
        );
        continue;
      }

      const status = result.uncertain ? "uncertain" : "failed";

      await store.markOutboxFailure(base.batchId, partIndex, {
        status,
        error: result.reason ?? "send-failed",
        attempts: result.attempts,
      });

      deps.logger.error(
        `stage=outbox ${status} part=${partIndex} ` +
          `conversation=${base.conversationId} ` +
          `batch=${base.batchId} revision=${base.revision} ` +
          `reason=${result.reason ?? "unknown"}`,
      );

      stopped = result.reason ?? "send-failed";
      if ((stickerName || part.kind === "sticker-review") && !result.uncertain) {
        // A rejected or suppressed sticker is an omitted optional bubble;
        // adjacent text remains independently sendable.
        continue;
      }
      break;
    }

    if (stopped === "superseded" && sentTexts.length > 0) {
      deps.logger.log(
        "Coordinator: partial reply stopped by newer messages",
      );
    }

    if (sentTexts.length === 0) {
      return {
        status: stopped === "superseded" ? "stale" : "send-failed",
        sentTexts,
        stopped,
      };
    }

    return { status: "replied", sentTexts, stopped };
  }

  // Any successful group reply opens (or refreshes) the active window. It
  // provides a continuation decision path for that speaker, not permission to
  // answer every follow-up; explicit mentions of the bot still use mention.
  function stickerReviewMonthKey(now) {
    const date = new Date(now);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  async function stickerSourceUrlFor(semantic) {
    if (!semantic?.source_url_ciphertext) return null;
    if (Number(semantic.source_url_expires_at) <= deps.now()) return null;
    return decryptStickerSourceUrl(
      semantic.source_url_ciphertext,
      deps.env.QQ_APP_SECRET,
    );
  }

  // One-off vision pass used only for owner-submitted stickers. The result is a
  // stored, unconfirmed suggestion; the chat model never sees sticker images.
  async function suggestStickerMeaning(fingerprint, sourceUrl, deadline) {
    if (!sourceUrl) return null;
    const budget = deadline - deps.now() - SEND_BUDGET_RESERVE_MS;
    if (budget < MIN_STAGE_BUDGET_MS) return null;

    try {
      const raw = await llm.callDeepSeek(
        [
          { role: "system", content: STICKER_VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "识别这张贴纸，给出初判。" },
              { type: "image_url", image_url: { url: sourceUrl } },
            ],
          },
        ],
        {
          thinking: false,
          maxTokens: 400,
          timeoutMs: Math.min(12_000, budget),
          label: "sticker-vision",
          imageCount: 1,
        },
      );
      const parsed = parseStickerVisionSuggestion(raw);
      deps.logger.log(
        `stage=sticker-vision id=${stickerReviewId(fingerprint)} ` +
          `label=${parsed.label ? "yes" : "no"} ` +
          `note=${parsed.note ? "yes" : "no"}`,
      );
      return parsed;
    } catch (error) {
      deps.logger.error("stage=sticker-vision failed:", error);
      return null;
    }
  }

  async function collectStickerAsset(trigger, semantic, command, deadline, isCurrent, reviewMeta) {
    const label =
      command.label ?? normalizeStickerNote(semantic.label ?? "");
    if (!label) {
      return sendAndStore(
        trigger,
        [`请给出标签：收录贴纸 ${command.id} 标签 [用途]`],
        deadline,
        prefetchToken(),
        isCurrent,
        reviewMeta,
      );
    }

    const sourceUrl = await stickerSourceUrlFor(semantic);
    if (!sourceUrl) {
      await store.clearStickerSourceUrl(semantic.fingerprint);
      return sendAndStore(
        trigger,
        ["这张贴纸的临时图片链接已过期，请重新私聊发送这张贴纸再收录。"],
        deadline,
        prefetchToken(),
        isCurrent,
        reviewMeta,
      );
    }

    const image = await fetchStickerImage(sourceUrl, deps.fetch);
    const failure =
      image.ok === false
        ? {
            "too-large": "这张贴纸超过 1.5 MB，暂时不能收录。",
            mime: "这张图的格式不能收录。",
            http: "图片下载失败，稍后再试或重新发送。",
            "fetch-failed": "图片下载失败，稍后再试或重新发送。",
            empty: "图片内容是空的，请重新发送。",
            "invalid-url": "图片链接无效，请重新发送。",
          }[image.reason] ?? "图片读取失败，请重新发送。"
        : null;
    if (failure) {
      return sendAndStore(
        trigger,
        [failure],
        deadline,
        prefetchToken(),
        isCurrent,
        reviewMeta,
      );
    }

    if (!STICKER_ASSET_MIME_TYPES.includes(image.mimeType)) {
      return sendAndStore(
        trigger,
        ["目前只支持 PNG、JPEG、GIF、WebP 贴纸。"],
        deadline,
        prefetchToken(),
        isCurrent,
        reviewMeta,
      );
    }

    const actualFingerprint = await fingerprintStickerBytes(image.bytes);
    if (actualFingerprint !== semantic.fingerprint) {
      await store.clearStickerSourceUrl(semantic.fingerprint);
      return sendAndStore(
        trigger,
        ["图片内容已经变了，请重新发送再收录。"],
        deadline,
        prefetchToken(),
        isCurrent,
        reviewMeta,
      );
    }

    const existing = await store.getStickerAssetByFingerprint(
      semantic.fingerprint,
    );
    const name = existing?.name ?? stickerAssetName(semantic.fingerprint);
    const note = command.note || semantic.note || "";

    await store.upsertStickerAsset({
      name,
      mimeType: image.mimeType,
      dataBase64: stickerBytesToBase64(image.bytes),
      fingerprint: semantic.fingerprint,
      note,
    });
    const applied = await store.applyStickerReview({
      fingerprint: semantic.fingerprint,
      status: "confirmed",
      label,
      note,
    });
    await store.clearStickerSourceUrl(semantic.fingerprint);

    return sendAndStore(
      trigger,
      [
        applied
          ? `已收录“${label}”，编号 ${command.id}，出站素材名 ${name}。以后按这个标签使用；要改可发“纠正贴纸 ${command.id} 新标签 用途”。`
          : "这张贴纸的语义状态刚变化了，请再发一次贴纸。",
      ],
      deadline,
      prefetchToken(),
      isCurrent,
      reviewMeta,
    );
  }

  async function handleOwnerStickerCommand(
    trigger,
    command,
    deadline,
    isCurrent,
    batchMeta,
  ) {
    const reviewMeta = { ...batchMeta, route: "sticker-review" };
    const tokenPromise = prefetchToken();

    if (command.kind === "list-pending") {
      const pending = await store.loadNextStickerReview(deps.now());
      if (!pending) {
        return sendAndStore(
          trigger,
          ["目前没有可查看的待确认贴纸。"],
          deadline,
          tokenPromise,
          isCurrent,
          reviewMeta,
        );
      }

      const sourceUrl = await decryptStickerSourceUrl(
        pending.source_url_ciphertext,
        deps.env.QQ_APP_SECRET,
      );
      if (!sourceUrl || Number(pending.source_url_expires_at) <= deps.now()) {
        await store.clearStickerSourceUrl(pending.fingerprint);
        return sendAndStore(
          trigger,
          ["这张贴纸的临时图片链接过期了，请让它在群里再出现一次。"],
          deadline,
          tokenPromise,
          isCurrent,
          reviewMeta,
        );
      }

      const monthKey = stickerReviewMonthKey(deps.now());
      const reserved = await store.reserveStickerReviewSlot(
        monthKey,
        stickerReviewMonthlyLimit(deps.env),
      );
      if (!reserved) {
        return sendAndStore(
          trigger,
          ["本月贴纸确认次数已用完，之后再看吧。"],
          deadline,
          tokenPromise,
          isCurrent,
          reviewMeta,
        );
      }

      const id = stickerReviewId(pending.fingerprint);
      const reviewPart = {
        kind: "sticker-review",
        fingerprint: pending.fingerprint,
        sourceUrl,
      };
      const outcome = await sendAndStore(
        trigger,
        [
          `待确认贴纸 ${id}：回复“确认贴纸 ${id} 标签”“纠正贴纸 ${id} 标签 用途”或“忽略贴纸 ${id}”。`,
          reviewPart,
        ],
        deadline,
        tokenPromise,
        isCurrent,
        reviewMeta,
      );
      const reviewOutbox = await store.getOutboxPart(batchMeta.batchId, 2);
      if (reviewOutbox?.status === "sent" || reviewOutbox?.status === "uncertain") {
        await store.markStickerAsked(pending.fingerprint);
      } else {
        await store.releaseStickerReviewSlot(monthKey);
      }
      return outcome;
    }

    const matches = await store.findStickerByReviewId(command.id);
    if (matches.length !== 1) {
      return sendAndStore(
        trigger,
        [matches.length > 1 ? "编号不唯一，请用更长编号。" : "没有找到这个待确认编号。"],
        deadline,
        tokenPromise,
        isCurrent,
        reviewMeta,
      );
    }

    const semantic = matches[0];

    if (command.kind === "detail") {
      const asset = await store.getStickerAssetByFingerprint(
        semantic.fingerprint,
      );
      const usage = await store.loadStickerUsage(semantic.fingerprint, 3);
      const lines = [
        `贴纸 ${command.id}：${semantic.label ? `“${semantic.label}”` : "未命名"}（${semantic.status}）`,
        semantic.note ? `用途：${semantic.note}` : null,
        `出现过 ${semantic.seen_count} 次`,
        asset ? `已收录出站素材：${asset.name}` : "未收录出站素材",
        ...usage.map(
          (row) =>
            `- ${row.kind === "inbound" ? "群里出现时" : "机器人使用时"}：${normalizeStickerNote(row.context).slice(0, 80)}`,
        ),
      ].filter(Boolean);
      return sendAndStore(
        trigger,
        [lines.join("\n")],
        deadline,
        tokenPromise,
        isCurrent,
        reviewMeta,
      );
    }

    if (command.kind === "collect") {
      return collectStickerAsset(
        trigger,
        semantic,
        command,
        deadline,
        isCurrent,
        reviewMeta,
      );
    }

    const label =
      command.kind === "ignore"
        ? null
        : command.label ?? normalizeStickerNote(semantic.label ?? "");
    if (command.kind !== "ignore" && !label) {
      return sendAndStore(
        trigger,
        [`请给出标签：${command.kind === "correct" ? "纠正" : "确认"}贴纸 ${command.id} 标签 [用途]`],
        deadline,
        tokenPromise,
        isCurrent,
        reviewMeta,
      );
    }

    const applied = await store.applyStickerReview({
      fingerprint: semantic.fingerprint,
      status: command.kind === "ignore" ? "ignored" : "confirmed",
      label,
      note: command.kind === "ignore" ? "" : command.note || semantic.note || "",
    });
    const response = !applied
      ? "这条贴纸状态已经变化了，再查一次吧。"
      : command.kind === "ignore"
        ? `已忽略贴纸 ${command.id}。`
        : `记下了：${label}`;
    return sendAndStore(
      trigger,
      [response],
      deadline,
      tokenPromise,
      isCurrent,
      reviewMeta,
    );
  }

  async function handleOwnerStickerImage(
    trigger,
    fingerprint,
    deadline,
    isCurrent,
    batchMeta,
  ) {
    const reviewMeta = { ...batchMeta, route: "sticker-review" };
    const id = stickerReviewId(fingerprint);
    const semantic = await store.getStickerSemantic(fingerprint);
    const asset = await store.getStickerAssetByFingerprint(fingerprint);
    let response;

    if (semantic?.status === "confirmed" && semantic.label) {
      response = asset
        ? `这张贴纸已记为“${normalizeStickerNote(semantic.label)}”，也已收录为出站素材。要改可发“纠正贴纸 ${id} 新标签 用途”。`
        : `这张贴纸已记为“${normalizeStickerNote(semantic.label)}”。要收录为出站素材，直接发“收录贴纸 ${id} [标签] [用途]”（用这次发送的图，链接只保留 24 小时）。`;
    } else if (semantic?.status === "ignored") {
      response = `这张贴纸之前被忽略了；要重新收录可发“收录贴纸 ${id} 标签 [用途]”，或“确认贴纸 ${id} 标签”只记含义。`;
    } else {
      const sourceUrl = await stickerSourceUrlFor(semantic);
      let suggestion;
      if (semantic?.label) {
        suggestion = {
          label: normalizeStickerNote(semantic.label),
          note: normalizeStickerNote(semantic.note ?? ""),
        };
      } else {
        suggestion = await suggestStickerMeaning(
          fingerprint,
          sourceUrl,
          deadline,
        );
        await store.saveStickerSuggestion(
          fingerprint,
          suggestion?.label ?? "",
          suggestion?.note ?? "",
        );
      }

      const head = suggestion?.label
        ? `识图初判：${suggestion.label}${suggestion.note ? `（${suggestion.note}）` : ""}。`
        : "识图没给出可靠判断。";
      response =
        `收到这张贴纸，编号 ${id}。${head}\n` +
        `回复“收录贴纸 ${id} [标签] [用途]”加入出站素材（不写标签就用初判）；` +
        `“确认贴纸 ${id} [标签]”只记含义；“忽略贴纸 ${id}”丢弃。`;
      if (!sourceUrl) {
        response += "\n临时图片链接已过期，要收录请重新私聊发送这张贴纸。";
      }
    }

    return sendAndStore(
      trigger,
      [response],
      deadline,
      prefetchToken(),
      isCurrent,
      reviewMeta,
    );
  }

  async function finishGroupReply(trigger, outcome, route) {
    if (outcome.status !== "replied" || trigger.scope !== "group") {
      return outcome;
    }

    const until = deps.now() + ACTIVE_WINDOW_MS;

    await store.markActiveWindow(
      trigger.conversationId,
      trigger.memberOpenid ?? null,
      until,
    );

    deps.logger.log("Active window opened:", {
      conversationId: trigger.conversationId,
      speaker: trigger.memberOpenid ?? null,
      until,
      route,
    });

    return outcome;
  }

  function parsedReplyParts(parsed) {
    const parts = [...(parsed.messages ?? [])];
    if (parsed.stickerName) {
      const position = Math.max(
        0,
        Math.min(parsed.stickerPosition ?? parts.length, parts.length),
      );
      parts.splice(position, 0, `[sticker:${parsed.stickerName}]`);
    }
    return parts;
  }

  // Turns the model's raw output into validated bubbles. Invalid or empty
  // structured output falls back to a safe single bubble instead of sending
  // half-parsed JSON; the fallback and any merge are always logged.
  function resolveReplyMessages(raw, route, fallback) {
    const parsed = parseReplyOutput(raw);

    if (parsed.warning) {
      deps.logger.log(`Reply parse warning: ${parsed.warning}`, {
        route,
        ...(parsed.safetyRule ? { rule: parsed.safetyRule } : {}),
      });
    }

    if (parsed.kind === "messages") {
      return parsedReplyParts(parsed);
    }

    if (parsed.kind === "unsafe") {
      deps.logger.log("Reply rejected by safety guard; using safe fallback", {
        route,
        rule: parsed.safetyRule,
      });
      return [FALLBACK_UNSAFE_REPLY];
    }

    deps.logger.error(
      `stage=reply ${parsed.kind} (${route}), using safe fallback`,
      {
        rawLength: String(raw ?? "").length,
        rawPreview: JSON.stringify(String(raw ?? "").slice(0, 120)),
      },
    );
    return [fallback];
  }

  async function replyToPrivateMessage(
    trigger,
    context,
    deadline,
    tokenPromise,
    isCurrent,
    batchMeta,
    webContext = null,
  ) {
    const imageCount = currentBatchImageCount(trigger);
    const hasImages = imageCount > 0;
    let raw;

    try {
      raw = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildPrivateMessages(context, trigger, {
            includeImages,
            currentBatchEventIds: trigger.currentBatchEventIds,
            currentBatchImages: trigger.currentBatchImages,
            webContext,
            now: deps.now(),
          }),
        {
          maxTokens: 2000,
          label: "private",
          imageCount,
          stickerCount: trigger.hasSticker ? 1 : 0,
        },
        hasImages,
        deadline,
      );
    } catch (error) {
      deps.logger.error("stage=llm private failed:", error);
      return sendAndStore(
        trigger,
        [FALLBACK_ERROR_REPLY],
        deadline,
        tokenPromise,
        isCurrent,
        batchMeta,
      );
    }

    return sendAndStore(
      trigger,
      resolveReplyMessages(raw, "private", FALLBACK_ERROR_REPLY),
      deadline,
      tokenPromise,
      isCurrent,
      batchMeta,
    );
  }

  async function replyToAddressedGroupMessage(
    trigger,
    context,
    deadline,
    tokenPromise,
    isCurrent,
    batchMeta,
    continuation = false,
    webContext = null,
  ) {
    const imageCount = currentBatchImageCount(trigger);
    const hasImages = imageCount > 0;
    const route = continuation ? "active" : "mention";
    let raw;

    try {
      raw = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildGroupMessages(context, trigger, {
            decision: false,
            continuation,
            includeImages,
            currentBatchEventIds: trigger.currentBatchEventIds,
            currentBatchImages: trigger.currentBatchImages,
            webContext,
            now: deps.now(),
          }),
        {
          maxTokens: 2000,
          label: continuation ? "active" : "mention",
          imageCount,
          stickerCount: trigger.hasSticker ? 1 : 0,
        },
        hasImages,
        deadline,
      );
    } catch (error) {
      deps.logger.error(
        continuation
          ? "stage=llm continuation failed:"
          : "stage=llm mention failed:",
        error,
      );
      if (continuation) {
        // Active-window context is an invitation, not an obligation. If the
        // decision call fails, do not manufacture a reply to an unclear target.
        return { status: "llm-failed" };
      }
      const outcome = await sendAndStore(
        trigger,
        [FALLBACK_MENTION_REPLY],
        deadline,
        tokenPromise,
        isCurrent,
        batchMeta,
      );
      return finishGroupReply(trigger, outcome, route);
    }

    if (continuation && parseReplyOutput(raw).kind === "silent") {
      deps.logger.log("Decision: no reply (active continuation)");
      return { status: "silent" };
    }

    const outcome = await sendAndStore(
      trigger,
      resolveReplyMessages(raw, route, FALLBACK_MENTION_REPLY),
      deadline,
      tokenPromise,
      isCurrent,
      batchMeta,
    );

    return finishGroupReply(trigger, outcome, route);
  }

  async function decideGroupAutonomous(
    trigger,
    context,
    deadline,
    tokenPromise,
    isCurrent,
    batchMeta,
  ) {
    const imageCount = currentBatchImageCount(trigger);
    const hasImages = imageCount > 0;
    let raw;

    try {
      raw = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildGroupMessages(context, trigger, {
            decision: true,
            includeImages,
            currentBatchEventIds: trigger.currentBatchEventIds,
            currentBatchImages: trigger.currentBatchImages,
            now: deps.now(),
          }),
        {
          maxTokens: 1500,
          label: "autonomous",
          imageCount,
          stickerCount: trigger.hasSticker ? 1 : 0,
        },
        hasImages,
        deadline,
      );
    } catch (error) {
      deps.logger.error("stage=llm decision failed:", error);
      return { status: "llm-failed" };
    }

    const parsed = parseReplyOutput(raw);

    if (parsed.warning) {
      deps.logger.log(`Reply parse warning: ${parsed.warning}`, {
        route: "autonomous",
        ...(parsed.safetyRule ? { rule: parsed.safetyRule } : {}),
      });
    }

    if (parsed.kind === "silent") {
      deps.logger.log("Decision: no reply");
      return { status: "silent" };
    }

    if (parsed.kind !== "messages") {
      deps.logger.log(
        `Decision: ${parsed.kind} output (treated as no reply)`,
      );
      return { status: "silent" };
    }

    const replyParts = parsedReplyParts(parsed);
    deps.logger.log(
      `Decision: reply (${replyParts.length} bubbles, ` +
        `${parsed.messages.join("").length} chars)`,
    );

    // The coordinator processes one conversation at a time (one alarm per
    // instance), so this read-check-send sequence already behaves like an
    // atomic claim at conversation level: no second batch can interject in
    // between. The outbox adds the per-bubble facts on top.
    const nextAt = await store.getNextAutonomousAt(
      trigger.conversationId,
    );

    if (deps.now() < nextAt) {
      deps.logger.log("Autonomous reply skipped: cooldown active");
      return { status: "cooldown" };
    }

    const outcome = await sendAndStore(
      trigger,
      replyParts,
      deadline,
      tokenPromise,
      isCurrent,
      batchMeta,
    );

    if (outcome.status === "replied") {
      await store.markAutonomousReply(trigger.conversationId);
      await finishGroupReply(trigger, outcome, "autonomous");
    }

    return outcome;
  }

  async function processBatch(batch, context) {
    const startedAt = deps.now();
    const deadline = startedAt + INVOCATION_BUDGET_MS;
    const messages = batch.messages;
    const conversationId = messages[0].conversationId;

    // The messages were recorded when the coordinator accepted them; the
    // batch itself stays in Durable Object storage, so this only reads facts.
    const session = await store.loadConversationContext(conversationId);
    // Character lore is optional: an empty lore table simply means the
    // prompt runs without the knowledge block.
    const lore = await store.loadLore();
    const stickerCatalog = await store.loadStickerCatalog();
    const promptContext = { ...session, lore, stickerCatalog };

    deps.logger.log(
      `Context loaded: ${session.messages.length} messages, ` +
        `${lore.length} lore entries in ${deps.now() - startedAt}ms`,
    );

    const mentioned = messages.some(
      (message) => message.wasMentioned === true,
    );
    const lastMessage = messages[messages.length - 1];
    // When a batch contains an explicit bot address, keep that event as the
    // reply target instead of borrowing the final message's author/content.
    const targetMessage = mentioned
      ? [...messages].reverse().find((message) => message.wasMentioned === true)
      : lastMessage;
    const trigger = {
      ...targetMessage,
      currentBatchEventIds: messages
        .map((message) => message.eventId)
        .filter((eventId) => typeof eventId === "string"),
      currentBatchImages: selectCurrentBatchImages(
        messages,
        targetMessage.eventId,
      ),
      addressedOthers: targetMessage.addressedOthers === true,
      quotedOther: targetMessage.quotedOther === true,
      quotedOtherOnly: targetMessage.quotedOtherOnly === true,
    };
    const addressedOthers = trigger.addressedOthers;
    const quotedOther = trigger.quotedOther;

    // Active chat: a group the bot just replied in stays warm for a while.
    // The last speaker gets an active-continuation decision (which may be
    // silent); other members still go through the normal model decision.
    const activeWindow =
      trigger.scope === "group"
        ? await store.getActiveWindow(conversationId)
        : { until: 0, speaker: null };

    const now = deps.now();
    const windowOpen = activeWindow.until > now;
    const speakerContinues =
      windowOpen &&
      activeWindow.speaker !== null &&
      trigger.memberOpenid === activeWindow.speaker;

    const route =
      trigger.scope === "c2c"
        ? "private"
        : mentioned
          ? "mention"
          : speakerContinues
            ? "active"
            : "autonomous";

    deps.logger.log(`Route: ${route}`, {
      conversationId,
      batchId: batch.id,
      mentioned,
      addressedOthers,
      quotedOther,
      speakerContinues,
      activeUntil: activeWindow.until,
      activeSpeaker: activeWindow.speaker,
    });

    const batchMeta = {
      batchId: batch.id,
      revision: batch.revision,
      route,
    };

    if (
      trigger.scope === "c2c" &&
      deps.env.STICKER_OWNER_OPENID &&
      trigger.targetId === deps.env.STICKER_OWNER_OPENID
    ) {
      if (trigger.hasSticker === true && trigger.stickerFingerprint) {
        return handleOwnerStickerImage(
          trigger,
          trigger.stickerFingerprint,
          deadline,
          context.isCurrent,
          batchMeta,
        );
      }
      const ownerCommand = parseOwnerStickerCommand(trigger.content);
      if (ownerCommand) {
        return handleOwnerStickerCommand(
          trigger,
          ownerCommand,
          deadline,
          context.isCurrent,
          batchMeta,
        );
      }
    }

    deps.logger.log("Batch trigger:", {
      conversationId,
      batchId: batch.id,
      revision: batch.revision,
      messages: messages.length,
      mentioned,
      route,
      sender: trigger.senderName,
      contentLength: trigger.content.length,
    });

    if (!mentioned && speakerContinues && trigger.quotedOtherOnly) {
      deps.logger.log("Decision: no reply (quoted other member only)");
      return { status: "silent" };
    }

    // 贴纸单独成批时不打扰也不花钱（BOT-019）：群里单发一张贴纸又不是在
    // 跟机器人说话，默认保持沉默；被 @、被引用机器人（走 mention）或处于
    // 活跃续聊判断（走 active）时仍然正常参与。
    if (
      route === "autonomous" &&
      messages.every((message) => message.hasSticker === true)
    ) {
      deps.logger.log("Decision: no reply (sticker only)");
      return { status: "silent" };
    }

    const tokenPromise = prefetchToken();
    const webContext =
      route === "autonomous"
        ? null
        : await loadWebContext(trigger, messages, deadline);

    if (trigger.scope === "c2c") {
      return replyToPrivateMessage(
        trigger,
        promptContext,
        deadline,
        tokenPromise,
        context.isCurrent,
        batchMeta,
        webContext,
      );
    }

    if (mentioned) {
      return replyToAddressedGroupMessage(
        trigger,
        promptContext,
        deadline,
        tokenPromise,
        context.isCurrent,
        batchMeta,
        false,
        webContext,
      );
    }

    if (speakerContinues) {
      return replyToAddressedGroupMessage(
        trigger,
        promptContext,
        deadline,
        tokenPromise,
        context.isCurrent,
        batchMeta,
        true,
        webContext,
      );
    }

    return decideGroupAutonomous(
      trigger,
      promptContext,
      deadline,
      tokenPromise,
      context.isCurrent,
      batchMeta,
    );
  }

  return {
    deps,
    store,
    recordIncoming,
    processBatch,
  };
}
