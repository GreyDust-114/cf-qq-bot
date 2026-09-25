// Webhook edge: signature handling and per-conversation routing only.
//
// Every accepted message event is handed to the coordinator for its
// conversationId. In production that is a Durable Object named by the
// conversation, so different conversations run in parallel while one
// conversation stays serialized inside its own instance.

import { Buffer } from "node:buffer";

import { signValidationResponse, verifyWebhookSignature } from "./crypto.js";
import { createDependencies } from "./dependencies.js";
import { HUB_ENQUEUE_PATH } from "./conversation-hub.js";
import { createMemoryRunner } from "./memory.js";
import { parseIncomingMessage } from "./pure.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function createDurableObjectCoordinator(env) {
  return {
    async enqueue(incoming) {
      const namespace = env.CONVERSATION_HUB;

      if (!namespace) {
        throw new Error("CONVERSATION_HUB binding is missing");
      }

      const stub = namespace.get(
        namespace.idFromName(incoming.conversationId),
      );

      const response = await stub.fetch(
        `https://conversation-hub${HUB_ENQUEUE_PATH}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(incoming),
        },
      );

      if (!response.ok) {
        throw new Error(
          `conversation hub enqueue failed: HTTP ${response.status}`,
        );
      }

      return response.json();
    },
  };
}

export function createRuntime(env, overrides = {}) {
  const deps = createDependencies(env, overrides);
  const coordinator =
    overrides.coordinator ?? createDurableObjectCoordinator(env);

  async function processIncomingMessage(payload) {
    const incoming = parseIncomingMessage(payload, deps.env);

    if (!incoming) {
      return null;
    }

    deps.logger.log("Incoming message:", {
      eventType: payload.t,
      scope: incoming.scope,
      conversationId: incoming.conversationId,
      wasMentioned: incoming.wasMentioned,
      images: incoming.imageUrls.length,
      contentLength: incoming.content.length,
    });

    return coordinator.enqueue(incoming);
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
          deps.logger.error("Message delivery failed:", error);
        }),
      );
    }

    return json({ op: 12, d: 0 });
  }

  // Cron 入口（BOT-017）：把超过保留期的原文压成 digest 与画像。
  // 失败向上抛，让 Cloudflare 记录为失败；下一次触发会重取同一区间。
  async function handleScheduled(event = {}) {
    const runner = createMemoryRunner(deps);
    const startedAt = deps.now();

    deps.logger.log(
      `stage=memory start cron=${event.cron ?? "manual"} ` +
        `scheduled=${event.scheduledTime ?? startedAt}`,
    );

    try {
      const result = await runner.runOnce();

      return result;
    } catch (error) {
      deps.logger.error("stage=memory failed:", error);
      throw error;
    }
  }

  return {
    deps,
    coordinator,
    processIncomingMessage,
    handleRequest,
    handleScheduled,
  };
}
