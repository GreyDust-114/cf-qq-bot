import { Buffer } from "node:buffer";

import { signValidationResponse, verifyWebhookSignature } from "./crypto.js";
import { createDependencies } from "./dependencies.js";
import { createLlmClient } from "./llm.js";
import { createReplySender } from "./sender.js";
import { createStore } from "./store.js";
import { createTokenManager } from "./token.js";

import {
  DEBOUNCE_GROUP_MAX_MS,
  DEBOUNCE_GROUP_MIN_MS,
  DEBOUNCE_MENTION_MAX_MS,
  DEBOUNCE_MENTION_MIN_MS,
  INVOCATION_BUDGET_MS,
} from "./config.js";

import {
  buildGroupMessages,
  buildPrivateMessages,
  parseGroupDecision,
  parseIncomingMessage,
  randomBetween,
} from "./pure.js";

const MENTION_FALLBACK_REPLY = "刚刚走神了一下，你再说一次？";
const ERROR_REPLY = "AI 服务暂时无法响应，请稍后再试。";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function createRuntime(env, overrides = {}) {
  const deps = createDependencies(env, overrides);

  const store = createStore(deps);
  const tokenManager = createTokenManager(deps);
  const llm = createLlmClient(deps);
  const sender = createReplySender(deps, tokenManager);

  async function handlePrivateMessage(
    incoming,
    context,
    deadline,
    tokenPromise,
  ) {
    const hasImages = incoming.imageUrls.length > 0;
    let reply;

    try {
      reply = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildPrivateMessages(context, incoming, {
            includeImages,
            now: deps.now(),
          }),
        { maxTokens: 2000 },
        hasImages,
        deadline,
      );
    } catch (error) {
      deps.logger.error("stage=llm private failed:", error);
      reply = ERROR_REPLY;
    }

    const sendResult = await sender.sendReplyParts(
      incoming,
      reply,
      deadline,
      tokenPromise,
    );

    if (sendResult.sentTexts.length > 0) {
      await store.storeAssistantMessage(
        incoming.conversationId,
        sendResult.sentTexts.join(" "),
      );
      return;
    }

    deps.logger.error(
      "Reply not stored; send failed:",
      sendResult.reason,
    );
  }

  async function handleGroupMention(
    incoming,
    context,
    deadline,
    tokenPromise,
  ) {
    const hasImages = incoming.imageUrls.length > 0;
    let reply;

    try {
      reply = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildGroupMessages(context, incoming, {
            decision: false,
            includeImages,
            now: deps.now(),
          }),
        { maxTokens: 2000 },
        hasImages,
        deadline,
      );
    } catch (error) {
      deps.logger.error("stage=llm mention failed:", error);
      reply = MENTION_FALLBACK_REPLY;
    }

    const sendResult = await sender.sendReplyParts(
      incoming,
      reply,
      deadline,
      tokenPromise,
    );

    if (sendResult.sentTexts.length > 0) {
      await store.storeAssistantMessage(
        incoming.conversationId,
        sendResult.sentTexts.join(" "),
      );
      return;
    }

    deps.logger.error(
      "Reply not stored; send failed:",
      sendResult.reason,
    );
  }

  async function handleGroupAutonomous(
    incoming,
    context,
    deadline,
    tokenPromise,
  ) {
    const hasImages = incoming.imageUrls.length > 0;
    let raw;

    try {
      raw = await llm.callDeepSeekWithFallback(
        (includeImages) =>
          buildGroupMessages(context, incoming, {
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
      return;
    }

    const decision = parseGroupDecision(raw);

    if (decision.kind === "empty") {
      deps.logger.log("Decision: empty output (treated as no reply)");
      return;
    }

    if (decision.kind === "no_reply") {
      deps.logger.log("Decision: no reply");
      return;
    }

    deps.logger.log(`Decision: reply (${decision.content.length} chars)`);

    const nextAt = await store.getNextAutonomousAt(
      incoming.conversationId,
    );

    if (deps.now() < nextAt) {
      deps.logger.log("Autonomous reply skipped: cooldown active");
      return;
    }

    const sendResult = await sender.sendReplyParts(
      incoming,
      decision.content,
      deadline,
      tokenPromise,
    );

    if (sendResult.sentTexts.length === 0) {
      deps.logger.error(
        "Autonomous reply not stored; send failed:",
        sendResult.reason,
      );
      return;
    }

    await store.storeAssistantMessage(
      incoming.conversationId,
      sendResult.sentTexts.join(" "),
    );
    await store.markAutonomousReply(incoming.conversationId);
  }

  async function handleGroupMessage(
    incoming,
    context,
    deadline,
    tokenPromise,
  ) {
    if (incoming.wasMentioned) {
      await handleGroupMention(
        incoming,
        context,
        deadline,
        tokenPromise,
      );
      return;
    }

    await handleGroupAutonomous(
      incoming,
      context,
      deadline,
      tokenPromise,
    );
  }

  async function processIncomingMessage(payload) {
    const startedAt = deps.now();
    const deadline = startedAt + INVOCATION_BUDGET_MS;

    const incoming = parseIncomingMessage(payload, deps.env);

    if (!incoming) {
      return;
    }

    await store.ensureConversation(
      incoming.conversationId,
      incoming.scope,
    );

    const stored = await store.storeIncomingMessage(incoming);

    if (!stored.isNew) {
      deps.logger.log("Duplicate event ignored:", incoming.eventId);
      return;
    }

    deps.logger.log("Incoming message:", {
      eventType: payload.t,
      scope: incoming.scope,
      conversationId: incoming.conversationId,
      wasMentioned: incoming.wasMentioned,
      images: incoming.imageUrls.length,
      contentLength: incoming.content.length,
    });

    const debounceMs = incoming.wasMentioned
      ? randomBetween(
          DEBOUNCE_MENTION_MIN_MS,
          DEBOUNCE_MENTION_MAX_MS,
          deps.random,
        )
      : randomBetween(
          DEBOUNCE_GROUP_MIN_MS,
          DEBOUNCE_GROUP_MAX_MS,
          deps.random,
        );

    await deps.sleep(debounceMs);

    const superseded = await store.hasNewerUserMessage(
      incoming.conversationId,
      stored.rowId,
    );

    if (superseded) {
      deps.logger.log("Debounce: deferring to newer message");
      return;
    }

    deps.logger.log(
      `Debounce: waited ${Math.round(debounceMs)}ms, processing ` +
        `(elapsed ${deps.now() - startedAt}ms)`,
    );

    const context = await store.loadConversationContext(
      incoming.conversationId,
    );

    deps.logger.log(
      `Context loaded: ${context.messages.length} messages ` +
        `in ${deps.now() - startedAt}ms`,
    );

    const tokenPromise = tokenManager
      .fetchAccessToken()
      .catch((error) => {
        deps.logger.error("stage=token prefetch failed:", error);
        return null;
      });

    if (incoming.scope === "c2c") {
      await handlePrivateMessage(
        incoming,
        context,
        deadline,
        tokenPromise,
      );
      return;
    }

    await handleGroupMessage(
      incoming,
      context,
      deadline,
      tokenPromise,
    );
  }

  async function handleRequest(request, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("QQ AI Bot is running.");
    }

    if (url.pathname !== "/qq/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = Buffer.from(await request.arrayBuffer());

    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    if (payload.op === 13) {
      const plainToken = payload.d?.plain_token;
      const eventTs = payload.d?.event_ts;

      if (!plainToken || !eventTs) {
        return json({ error: "invalid validation payload" }, 400);
      }

      const signature = signValidationResponse(
        deps.env.QQ_APP_SECRET,
        eventTs,
        plainToken,
      );

      return json({ plain_token: plainToken, signature });
    }

    const timestamp =
      request.headers.get("x-signature-timestamp") ?? "";
    const signature =
      request.headers.get("x-signature-ed25519") ?? "";

    const valid = verifyWebhookSignature(
      deps.env.QQ_APP_SECRET,
      timestamp,
      signature,
      rawBody,
    );

    if (!valid) {
      return json({ error: "invalid signature" }, 401);
    }

    deps.logger.log("QQ event received:", payload.t, payload.id);

    if (payload.op === 0) {
      ctx.waitUntil(
        processIncomingMessage(payload).catch((error) => {
          deps.logger.error("Message processing failed:", error);
        }),
      );
    }

    return json({ op: 12, d: 0 });
  }

  return { deps, processIncomingMessage, handleRequest };
}
