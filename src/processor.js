// Batch processor: everything that turns one coordinator batch into a real
// reply. It is intentionally independent from the webhook handler so the
// Durable Object and the offline tests can run the exact same code.
//
// Facts still live in D1: recordIncoming writes the user message as soon as
// the coordinator accepts it, and assistant messages are written after a
// successful send. Stale output (a newer revision or a lost lease) is dropped
// before the first bubble and re-checked between bubbles.

import { ACTIVE_WINDOW_MS, INVOCATION_BUDGET_MS } from "./config.js";
import { createDependencies } from "./dependencies.js";
import { createLlmClient } from "./llm.js";
import { createReplySender } from "./sender.js";
import { createStore } from "./store.js";
import { createTokenManager } from "./token.js";

import {
  buildGroupMessages,
  buildPrivateMessages,
  parseReplyOutput,
} from "./pure.js";

const ERROR_REPLY = "AI 服务暂时无法响应，请稍后再试。";
const MENTION_FALLBACK_REPLY = "刚刚走神了一下，你再说一次？";

export function createProcessor(env, overrides = {}) {
  const deps = createDependencies(env, overrides);

  const store = createStore(deps);
  const tokenManager = createTokenManager(deps);
  const llm = createLlmClient(deps);
  const sender = createReplySender(deps, tokenManager);

  // D1 is the fact log: a message is recorded once, when the coordinator
  // accepts the event. `messages.event_id` keeps the write idempotent.
  async function recordIncoming(incoming) {
    await store.ensureConversation(
      incoming.conversationId,
      incoming.scope,
    );

    return store.storeIncomingMessage(incoming);
  }

  function prefetchToken() {
    return tokenManager.fetchAccessToken().catch((error) => {
      deps.logger.error("stage=token prefetch failed:", error);
      return null;
    });
  }

  async function sendAndStore(
    trigger,
    messages,
    deadline,
    tokenPromise,
    isCurrent,
  ) {
    const gate = await isCurrent();

    if (!gate?.current) {
      deps.logger.log(
        `Coordinator: dropping stale reply (${gate?.reason ?? "unknown"})`,
      );
      return { status: "stale", reason: gate?.reason ?? "unknown" };
    }

    const sendResult = await sender.sendReplyParts(
      trigger,
      messages,
      deadline,
      tokenPromise,
      isCurrent,
    );

    if (sendResult.sentTexts.length === 0) {
      deps.logger.error(
        "Reply not stored; send failed:",
        sendResult.reason,
      );
      return {
        status:
          sendResult.reason === "superseded" ? "stale" : "send-failed",
        reason: sendResult.reason,
      };
    }

    if (sendResult.reason === "superseded") {
      deps.logger.log(
        "Coordinator: partial reply stopped by newer messages",
      );
    }

    await store.storeAssistantMessage(
      trigger.conversationId,
      sendResult.sentTexts.join(" "),
    );

    return {
      status: "replied",
      parts: sendResult.sentTexts.length,
      stoppedByNewerMessages: sendResult.reason === "superseded",
    };
  }

  // Any successful group reply opens (or refreshes) the active window: the
  // person whose message carried the reply gets the forced reply path for
  // their follow-ups, so the interjection decision and its cooldown never
  // swallow the ongoing conversation.
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

  // Turns the model's raw output into validated bubbles. Invalid or empty
  // structured output falls back to a safe single bubble instead of sending
  // half-parsed JSON; the fallback and any merge are always logged.
  function resolveReplyMessages(raw, route, fallback) {
    const parsed = parseReplyOutput(raw);

    if (parsed.warning) {
      deps.logger.log(`Reply parse warning: ${parsed.warning}`, {
        route,
      });
    }

    if (parsed.kind === "messages") {
      return parsed.messages;
    }

    deps.logger.error(
      `stage=reply ${parsed.kind} (${route}), using safe fallback`,
    );
    return [fallback];
  }

  async function replyToPrivateMessage(
    trigger,
    context,
    deadline,
    tokenPromise,
    isCurrent,
  ) {
    const hasImages = trigger.imageUrls.length > 0;
    let raw;

    try {
      raw = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildPrivateMessages(context, trigger, {
            includeImages,
            now: deps.now(),
          }),
        { maxTokens: 2000 },
        hasImages,
        deadline,
      );
    } catch (error) {
      deps.logger.error("stage=llm private failed:", error);
      return sendAndStore(
        trigger,
        [ERROR_REPLY],
        deadline,
        tokenPromise,
        isCurrent,
      );
    }

    return sendAndStore(
      trigger,
      resolveReplyMessages(raw, "private", ERROR_REPLY),
      deadline,
      tokenPromise,
      isCurrent,
    );
  }

  async function replyToAddressedGroupMessage(
    trigger,
    context,
    deadline,
    tokenPromise,
    isCurrent,
    continuation = false,
  ) {
    const hasImages = trigger.imageUrls.length > 0;
    const route = continuation ? "active" : "mention";
    let raw;

    try {
      raw = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildGroupMessages(context, trigger, {
            decision: false,
            continuation,
            includeImages,
            now: deps.now(),
          }),
        { maxTokens: 2000 },
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
      const outcome = await sendAndStore(
        trigger,
        [MENTION_FALLBACK_REPLY],
        deadline,
        tokenPromise,
        isCurrent,
      );
      return finishGroupReply(trigger, outcome, route);
    }

    const outcome = await sendAndStore(
      trigger,
      resolveReplyMessages(raw, route, MENTION_FALLBACK_REPLY),
      deadline,
      tokenPromise,
      isCurrent,
    );

    return finishGroupReply(trigger, outcome, route);
  }

  async function decideGroupAutonomous(
    trigger,
    context,
    deadline,
    tokenPromise,
    isCurrent,
  ) {
    const hasImages = trigger.imageUrls.length > 0;
    let raw;

    try {
      raw = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildGroupMessages(context, trigger, {
            decision: true,
            includeImages,
            now: deps.now(),
          }),
        { maxTokens: 1500 },
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

    deps.logger.log(
      `Decision: reply (${parsed.messages.length} bubbles, ` +
        `${parsed.messages.join("").length} chars)`,
    );

    const nextAt = await store.getNextAutonomousAt(
      trigger.conversationId,
    );

    if (deps.now() < nextAt) {
      deps.logger.log("Autonomous reply skipped: cooldown active");
      return { status: "cooldown" };
    }

    const outcome = await sendAndStore(
      trigger,
      parsed.messages,
      deadline,
      tokenPromise,
      isCurrent,
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

    deps.logger.log(
      `Context loaded: ${session.messages.length} messages ` +
        `in ${deps.now() - startedAt}ms`,
    );

    const mentioned = messages.some(
      (message) => message.wasMentioned === true,
    );
    const lastMessage = messages[messages.length - 1];
    // If any message in the batch addressed the bot, the whole batch is
    // treated as addressed and the newest message carries the reply.
    const trigger = { ...lastMessage, wasMentioned: mentioned };

    // Active chat: a group the bot just replied in stays warm for a while.
    // The person the bot was talking to gets the reply path directly; other
    // members still go through the model decision.
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
      activeUntil: activeWindow.until,
      activeSpeaker: activeWindow.speaker,
    });

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

    const tokenPromise = prefetchToken();

    if (trigger.scope === "c2c") {
      return replyToPrivateMessage(
        trigger,
        session,
        deadline,
        tokenPromise,
        context.isCurrent,
      );
    }

    if (mentioned) {
      return replyToAddressedGroupMessage(
        trigger,
        session,
        deadline,
        tokenPromise,
        context.isCurrent,
      );
    }

    if (speakerContinues) {
      return replyToAddressedGroupMessage(
        trigger,
        session,
        deadline,
        tokenPromise,
        context.isCurrent,
        true,
      );
    }

    return decideGroupAutonomous(
      trigger,
      session,
      deadline,
      tokenPromise,
      context.isCurrent,
    );
  }

  return {
    deps,
    store,
    recordIncoming,
    processBatch,
  };
}
