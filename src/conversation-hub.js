// ConversationHub: the Durable Object wrapper around one conversation.
//
// Wrangler creates one instance per conversationId. The instance owns the
// serialized coordinator state machine in its storage and runs batch
// processing through the shared processor. D1 stays the fact log; this object
// only stores coordination state (pending arrivals, revision, batch, retries).

import { createCoordinator } from "./coordinator.js";
import { createProcessor } from "./processor.js";

export const HUB_ENQUEUE_PATH = "/enqueue";

export class ConversationHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    const processor = createProcessor(env);

    this.processor = processor;
    this.coordinator = createCoordinator({
      storage: ctx.storage,
      scheduler: {
        setAlarm: (timestamp) => ctx.storage.setAlarm(timestamp),
        clearAlarm: () => ctx.storage.deleteAlarm(),
      },
      now: () => Date.now(),
      random: () => Math.random(),
      logger: console,
      recordIncoming: processor.recordIncoming,
      processBatch: processor.processBatch,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (
      url.pathname !== HUB_ENQUEUE_PATH ||
      request.method !== "POST"
    ) {
      return new Response("Not Found", { status: 404 });
    }

    let incoming;

    try {
      incoming = await request.json();
    } catch {
      return Response.json(
        { error: "invalid json" },
        { status: 400 },
      );
    }

    const result = await this.coordinator.enqueue(incoming);

    return Response.json(result);
  }

  async alarm() {
    return this.coordinator.alarm();
  }
}
