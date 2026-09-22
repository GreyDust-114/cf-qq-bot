import { test } from "node:test";
import assert from "node:assert/strict";

import { createEmptyCoordinatorState } from "../src/coordinator-state.js";

import {
  COORDINATOR_STATE_KEY,
  createManualClock,
  createTestHub,
  createTestLogger,
  waitFor,
} from "./support/index.js";

function incomingMessage(conversationId, eventId, extra = {}) {
  return {
    scope: conversationId.startsWith("group:") ? "group" : "c2c",
    targetId: "target-1",
    conversationId,
    eventId,
    messageId: eventId,
    content: eventId,
    imageUrls: [],
    senderName: "用户",
    wasMentioned: true,
    ...extra,
  };
}

function createHarness(options = {}) {
  const clock = createManualClock();
  const logger = createTestLogger();
  const hub = createTestHub({
    clock,
    logger,
    random: options.random ?? (() => 0.5),
    recordIncoming:
      options.recordIncoming ?? (async () => ({ isNew: true })),
    processBatch:
      options.processBatch ?? (async () => ({ status: "replied" })),
    ...(options.hub ?? {}),
  });

  return { clock, logger, hub };
}

test("arrivals keep order, bump the revision, and merge into one batch", async () => {
  const processed = [];
  const { clock, hub } = createHarness({
    processBatch: async (batch) => {
      processed.push(batch);
      return { status: "replied" };
    },
  });

  const conversationId = "group:g1";

  await hub.enqueue(
    incomingMessage(conversationId, "m1", { wasMentioned: false }),
  );
  await hub.enqueue(
    incomingMessage(conversationId, "m2", { wasMentioned: false }),
  );
  await hub.enqueue(
    incomingMessage(conversationId, "m3", { wasMentioned: true }),
  );

  const state = hub.stateFor(conversationId);

  assert.equal(state.revision, 3);
  assert.deepEqual(
    state.pending.map((message) => message.eventId),
    ["m1", "m2", "m3"],
  );

  // Trailing silence window: exactly one alarm, reset by every arrival. The
  // mention in the batch selects the short window (3000 + 0.5 * 2000).
  assert.equal(hub.pendingAlarmCount(), 1);
  assert.equal(hub.nextAlarmAt(), clock.now() + 4000);

  await hub.runAllAlarms();

  assert.equal(processed.length, 1);
  assert.deepEqual(
    processed[0].messages.map((message) => message.eventId),
    ["m1", "m2", "m3"],
  );
  assert.equal(processed[0].revision, 3);
  assert.equal(processed[0].id, "batch-3-1");

  const finished = hub.stateFor(conversationId);

  assert.equal(finished.batch, null);
  assert.equal(finished.pending.length, 0);
  assert.equal(finished.last_outcome, "replied");
});

test("messages arriving during generation invalidate the old result", async () => {
  const conversationId = "c2c:u1";
  const gates = [];
  let entry;

  const { hub } = createHarness({
    processBatch: async (batch, context) => {
      if (batch.messages.some((message) => message.eventId === "m1")) {
        await entry.coordinator.enqueue(
          incomingMessage(conversationId, "m2"),
        );
      }

      const gate = await context.isCurrent();

      gates.push({
        revision: batch.revision,
        current: gate.current,
        reason: gate.reason ?? null,
      });

      return gate.current
        ? { status: "replied" }
        : { status: "stale", reason: gate.reason };
    },
  });

  entry = hub.ensureConversation(conversationId);

  await hub.enqueue(incomingMessage(conversationId, "m1"));

  const first = await hub.runNextAlarm();

  assert.equal(first.outcome, "stale");
  assert.deepEqual(gates[0], {
    revision: 1,
    current: false,
    reason: "newer-messages",
  });

  const waiting = hub.stateFor(conversationId);

  assert.equal(waiting.batch, null);
  assert.deepEqual(
    waiting.pending.map((message) => message.eventId),
    ["m2"],
  );
  assert.equal(hub.pendingAlarmCount(), 1);

  const second = await hub.runNextAlarm();

  assert.equal(second.outcome, "replied");
  assert.deepEqual(gates[1], {
    revision: 2,
    current: true,
    reason: null,
  });
  assert.equal(hub.stateFor(conversationId).last_outcome, "replied");
});

test("alarm failures retry with backoff and eventually recover", async () => {
  const conversationId = "c2c:u1";
  let attempts = 0;

  const { clock, logger, hub } = createHarness({
    processBatch: async () => {
      attempts += 1;

      if (attempts < 3) {
        throw new Error(`boom-${attempts}`);
      }

      return { status: "replied" };
    },
    hub: { retryDelayMs: 5000 },
  });

  await hub.enqueue(incomingMessage(conversationId, "m1"));
  await hub.runNextAlarm();

  assert.equal(attempts, 1);

  let state = hub.stateFor(conversationId);

  assert.equal(state.batch.status, "retry");
  assert.match(state.last_error, /boom-1/);
  assert.equal(state.scheduled_for, clock.now() + 5000);
  assert.ok(
    logger.has("stage=coordinator batch retry scheduled attempt=1"),
  );

  await hub.runAllAlarms();

  assert.equal(attempts, 3);

  state = hub.stateFor(conversationId);

  assert.equal(state.batch, null);
  assert.equal(state.last_error, null);
  assert.equal(state.last_outcome, "replied");
  assert.ok(
    logger.has("stage=coordinator batch retry scheduled attempt=2"),
  );
});

test("a batch that keeps failing is abandoned with recoverable state", async () => {
  const conversationId = "c2c:u1";

  const { logger, hub } = createHarness({
    processBatch: async () => {
      throw new Error("explode");
    },
    hub: { maxAttempts: 3 },
  });

  await hub.enqueue(incomingMessage(conversationId, "m1"));
  await hub.runAllAlarms();

  const state = hub.stateFor(conversationId);

  assert.equal(state.batch, null);
  assert.equal(state.last_outcome, "failed");
  assert.match(state.last_error, /explode/);
  assert.equal(state.failed_batch.messages, 1);
  assert.match(state.failed_batch.error, /explode/);
  assert.ok(logger.has("stage=coordinator batch abandoned"));
});

test("an evicted instance hands its batch over to the next alarm", async () => {
  const conversationId = "group:g1";
  const processed = [];

  const { clock, logger, hub } = createHarness({
    processBatch: async (batch) => {
      processed.push(batch.id);
      return { status: "replied" };
    },
  });

  const entry = hub.ensureConversation(conversationId);
  const oldMessage = incomingMessage(conversationId, "m1", {
    wasMentioned: false,
  });

  // Simulate a Durable Object that took a batch and then died: storage still
  // holds an aged "processing" batch and no instance is running.
  entry.storage.set(COORDINATOR_STATE_KEY, {
    ...createEmptyCoordinatorState(),
    revision: 1,
    last_lease: 1,
    batch: {
      id: "batch-1-1",
      revision: 1,
      lease: 1,
      status: "processing",
      taken_at: clock.now() - 60_000,
      messages: [oldMessage],
    },
  });

  await hub.enqueue(
    incomingMessage(conversationId, "m2", { wasMentioned: false }),
  );
  await hub.runAllAlarms();

  assert.deepEqual(processed, ["batch-1-1", "batch-2-3"]);
  assert.ok(
    logger.has("stage=coordinator recovering stale batch"),
  );

  const state = hub.stateFor(conversationId);

  assert.equal(state.batch, null);
  assert.equal(state.pending.length, 0);
  assert.equal(state.last_outcome, "replied");
});

test("duplicate events are ignored before and after they are queued", async () => {
  const conversationId = "c2c:u1";
  const stored = new Set();
  const recordings = [];

  const { logger, hub } = createHarness({
    recordIncoming: async (incoming) => {
      recordings.push(incoming.eventId);

      if (stored.has(incoming.eventId)) {
        return { isNew: false };
      }

      stored.add(incoming.eventId);
      return { isNew: true };
    },
  });

  await hub.enqueue(incomingMessage(conversationId, "m1"));
  await hub.enqueue(incomingMessage(conversationId, "m1"));

  // While queued, the duplicate never reaches D1 recording again.
  assert.deepEqual(recordings, ["m1"]);
  assert.equal(hub.pendingAlarmCount(), 1);

  await hub.runAllAlarms();
  await hub.enqueue(incomingMessage(conversationId, "m1"));

  assert.deepEqual(recordings, ["m1", "m1"]);
  assert.equal(hub.pendingAlarmCount(), 0);
  assert.ok(logger.has("Duplicate event ignored"));
});

test("different conversations run in separate coordinators and do not block each other", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const processed = [];

  const { hub } = createHarness({
    processBatch: async (batch) => {
      const conversationId = batch.messages[0].conversationId;

      if (conversationId === "group:a") {
        await firstGate;
      }

      processed.push(conversationId);
      return { status: "replied" };
    },
  });

  assert.notEqual(
    hub.ensureConversation("group:a").coordinator,
    hub.ensureConversation("group:b").coordinator,
  );

  await hub.enqueue(
    incomingMessage("group:a", "a1", { wasMentioned: false }),
  );
  const slowConversation = hub.startNextAlarm();

  await hub.enqueue(
    incomingMessage("group:b", "b1", { wasMentioned: false }),
  );

  // Drive only the other conversation's alarm. The watchdog for the slow
  // conversation deliberately stays untouched while its handler runs.
  await hub.runNextAlarm();

  assert.deepEqual(processed, ["group:b"]);

  releaseFirst();
  await slowConversation;

  assert.deepEqual(processed, ["group:b", "group:a"]);
  assert.equal(hub.pendingAlarmCount(), 0);
});

test("an alarm firing during processing defers instead of starting a second generation", async () => {
  const conversationId = "c2c:u1";
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const starts = [];

  const { hub } = createHarness({
    processBatch: async (batch) => {
      starts.push(batch.id);
      await firstGate;
      return { status: "replied" };
    },
  });

  await hub.enqueue(incomingMessage(conversationId, "m1"));

  const slowBatch = hub.startNextAlarm();

  await waitFor(
    () => hub.stateFor(conversationId)?.batch !== null,
    { label: "batch taken" },
  );

  await hub.enqueue(incomingMessage(conversationId, "m2"));

  const deferred = await hub.runNextAlarm();

  assert.equal(deferred.action, "deferred");
  assert.deepEqual(starts, ["batch-1-1"]);

  releaseFirst();
  await slowBatch;
  await hub.runAllAlarms();

  assert.deepEqual(starts, ["batch-1-1", "batch-2-2"]);
  assert.equal(hub.stateFor(conversationId).last_outcome, "replied");
});
