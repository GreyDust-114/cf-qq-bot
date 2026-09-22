// Conversation coordinator: the serialized state machine behind every
// conversation Durable Object.
//
// The webhook handler only parses and enqueues. From then on this module owns
// one conversation:
//   - every arrival bumps a revision and extends a trailing silence window
//     (one alarm per conversation, no per-message sleep/waitUntil)
//   - when the window closes, pending arrivals become one tracked batch
//   - generation/send runs outside the mutation chain, so new arrivals can
//     raise the revision while the model is thinking
//   - before sending, the batch asks `isCurrent()`; a newer revision or a
//     lost lease makes the run drop its stale output
//   - batch state, errors and retry attempts live in Durable Object storage,
//     so an evicted instance can be resumed by the next alarm
//
// All state mutations run through an in-instance promise chain. The processing
// itself intentionally does not hold that chain: otherwise a message that
// arrives during generation would wait for the generation to finish and the
// revision check could never observe it.

import {
  abandonBatch,
  enqueueMessage,
  finishBatch,
  hasQueuedEvent,
  isBatchLeased,
  isBatchStale,
  restoreCoordinatorState,
  scheduleRetry,
  takeBatch,
  COORDINATOR_STATE_KEY,
} from "./coordinator-state.js";

import {
  MAX_PROCESSING_ATTEMPTS,
  PROCESSING_RETRY_DELAY_MS,
  PROCESSING_STALE_MS,
} from "./config.js";

export function createCoordinator(options) {
  const storage = options.storage;
  const scheduler = options.scheduler;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());
  const logger = options.logger ?? console;
  const recordIncoming = options.recordIncoming;
  const processBatch = options.processBatch;
  const staleMs = options.staleMs ?? PROCESSING_STALE_MS;
  const retryDelayMs =
    options.retryDelayMs ?? PROCESSING_RETRY_DELAY_MS;
  const maxAttempts =
    options.maxAttempts ?? MAX_PROCESSING_ATTEMPTS;

  let chain = Promise.resolve();

  function serialize(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function loadState() {
    return restoreCoordinatorState(
      await storage.get(COORDINATOR_STATE_KEY),
    );
  }

  async function saveState(state) {
    await storage.put(COORDINATOR_STATE_KEY, state);
    return state;
  }

  function log(event, details) {
    logger.log(`stage=coordinator ${event}`, details);
  }

  async function enqueue(incoming) {
    return serialize(async () => {
      const state = await loadState();

      if (hasQueuedEvent(state, incoming.eventId)) {
        log("duplicate enqueue ignored", {
          conversationId: incoming.conversationId,
          eventId: incoming.eventId,
          revision: state.revision,
        });
        return { duplicate: true, reason: "queued" };
      }

      const recorded = await recordIncoming(incoming);

      if (!recorded?.isNew) {
        logger.log("Duplicate event ignored:", incoming.eventId);
        return { duplicate: true, reason: "stored" };
      }

      const next = enqueueMessage(state, incoming, {
        nowMs: now(),
        random,
      });

      await saveState(next);
      await scheduler.setAlarm(next.scheduled_for);

      log("enqueue", {
        conversationId: incoming.conversationId,
        eventId: incoming.eventId,
        revision: next.revision,
        pending: next.pending.length,
        alarmAt: next.scheduled_for,
      });

      return {
        duplicate: false,
        revision: next.revision,
        pending: next.pending.length,
      };
    });
  }

  async function alarm() {
    const nowMs = now();

    const decision = await serialize(async () => {
      const state = await loadState();

      if (state.batch !== null) {
        return planExistingBatch(state, nowMs);
      }

      if (state.pending.length === 0) {
        await scheduler.clearAlarm();
        return { action: "idle" };
      }

      if (
        state.scheduled_for !== null &&
        nowMs < state.scheduled_for
      ) {
        await scheduler.setAlarm(state.scheduled_for);
        log("alarm early", {
          revision: state.revision,
          pending: state.pending.length,
          alarmAt: state.scheduled_for,
        });
        return { action: "early" };
      }

      const result = takeBatch(state, nowMs);

      await saveState(result.state);
      // Watchdog: if this instance dies while processing, the next alarm
      // sees an old "processing" batch and takes it over.
      await scheduler.setAlarm(Math.round(nowMs + staleMs));

      return { action: "process", batch: result.batch };
    });

    if (decision.action !== "process") {
      return decision;
    }

    return runBatch(decision.batch);
  }

  // Called inside the mutation chain so the decision sees a consistent state.
  async function planExistingBatch(state, nowMs) {
    const batch = state.batch;

    if (batch.status === "retry") {
      const next = {
        ...state,
        batch: { ...batch, status: "processing" },
      };

      await saveState(next);
      await scheduler.setAlarm(Math.round(nowMs + staleMs));
      log("retry batch", {
        batchId: next.batch.id,
        revision: next.batch.revision,
        attempt: state.attempts + 1,
        messages: next.batch.messages.length,
      });

      return { action: "process", batch: next.batch };
    }

    const ageMs = nowMs - Number(batch.taken_at ?? 0);

    if (ageMs < staleMs) {
      // Still within the processing window: keep the batch, but make sure a
      // newer pending window or the watchdog eventually wakes us again.
      const pendingAt =
        state.scheduled_for !== null &&
        state.scheduled_for > nowMs
          ? state.scheduled_for
          : null;
      const watchdogAt = Number(batch.taken_at ?? nowMs) + staleMs;
      const alarmAt = Math.min(pendingAt ?? watchdogAt, watchdogAt);

      await scheduler.setAlarm(alarmAt);
      log("alarm deferred", {
        batchId: batch.id,
        ageMs,
        alarmAt,
      });

      return { action: "deferred" };
    }

    // The instance that took this batch is gone (eviction/crash). Take over
    // the same batch with a new lease; the old run loses its right to send.
    const lease = state.last_lease + 1;
    const next = {
      ...state,
      last_lease: lease,
      batch: {
        ...batch,
        lease,
        status: "processing",
        taken_at: Math.round(nowMs),
      },
    };

    await saveState(next);
    await scheduler.setAlarm(Math.round(nowMs + staleMs));
    logger.error("stage=coordinator recovering stale batch", {
      batchId: next.batch.id,
      revision: next.batch.revision,
      ageMs,
      messages: next.batch.messages.length,
    });

    return { action: "process", batch: next.batch };
  }

  async function runBatch(batch) {
    log("batch start", {
      batchId: batch.id,
      revision: batch.revision,
      messages: batch.messages.length,
    });

    const isCurrent = () =>
      serialize(async () => {
        const state = await loadState();

        if (!isBatchLeased(state, batch)) {
          return { current: false, reason: "lease-lost" };
        }

        if (isBatchStale(state, batch)) {
          return { current: false, reason: "newer-messages" };
        }

        return { current: true };
      });

    let outcome;

    try {
      outcome = await processBatch(batch, { isCurrent });
    } catch (error) {
      await failBatch(batch, error);
      return { action: "failed", batchId: batch.id };
    }

    await completeBatch(batch, outcome);
    return {
      action: "done",
      batchId: batch.id,
      outcome: outcome?.status ?? "done",
    };
  }

  async function completeBatch(batch, outcome) {
    const status = outcome?.status ?? "done";

    return serialize(async () => {
      const state = await loadState();

      if (!isBatchLeased(state, batch)) {
        log("batch finish ignored", {
          batchId: batch.id,
          status,
          reason: "lease-lost",
        });
        return;
      }

      const next = finishBatch(state, batch, status, now());

      await saveState(next);
      log("batch done", {
        batchId: batch.id,
        revision: batch.revision,
        status,
        pending: next.pending.length,
      });

      if (next.pending.length > 0) {
        const alarmAt = Math.max(next.scheduled_for ?? now(), now());

        await scheduler.setAlarm(alarmAt);
        log("pending scheduled", {
          batchId: batch.id,
          pending: next.pending.length,
          alarmAt,
        });
      } else {
        await scheduler.clearAlarm();
      }
    });
  }

  async function failBatch(batch, error) {
    const message = String(error?.message ?? error).slice(0, 500);

    return serialize(async () => {
      const state = await loadState();

      if (!isBatchLeased(state, batch)) {
        return;
      }

      const attempt = state.attempts + 1;

      if (attempt < maxAttempts) {
        const next = scheduleRetry(
          state,
          batch,
          message,
          now(),
          retryDelayMs,
        );

        await saveState(next);
        await scheduler.setAlarm(next.scheduled_for);
        logger.error(
          `stage=coordinator batch retry scheduled ` +
            `attempt=${attempt} batch=${batch.id}: ${message}`,
        );
        return;
      }

      const next = abandonBatch(state, batch, message, now());

      await saveState(next);
      logger.error(
        `stage=coordinator batch abandoned after ${attempt} ` +
          `attempts batch=${batch.id}: ${message}`,
      );

      if (next.pending.length > 0) {
        await scheduler.setAlarm(
          Math.max(next.scheduled_for ?? now(), now()),
        );
      } else {
        await scheduler.clearAlarm();
      }
    });
  }

  return {
    enqueue,
    alarm,
    getState: loadState,
  };
}
