// Pure conversation coordinator state machine.
//
// D1 keeps the chat facts (conversations, messages, cooldowns). This state
// only tracks coordination for one conversation: how many messages have
// arrived (revision), which ones are still waiting (pending), which batch is
// currently being generated or sent (batch), and how retries/leases are
// going. Keeping it pure makes the interesting transitions testable without
// a real Durable Object.

import {
  DEBOUNCE_GROUP_MAX_MS,
  DEBOUNCE_GROUP_MIN_MS,
  DEBOUNCE_MENTION_MAX_MS,
  DEBOUNCE_MENTION_MIN_MS,
} from "./config.js";

import { randomBetween } from "./pure.js";

export const COORDINATOR_STATE_KEY = "conversation_coordinator";

export function createEmptyCoordinatorState() {
  return {
    schema_version: 1,
    revision: 0,
    pending: [],
    batch: null,
    last_lease: 0,
    attempts: 0,
    last_error: null,
    last_completed_at: null,
    last_outcome: null,
    failed_batch: null,
    scheduled_for: null,
  };
}

function isMessage(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0
  );
}

function isBatch(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.messages) &&
    typeof value.lease === "number"
  );
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

// Storage may hold a state written by an older revision of the worker, so
// every field is validated instead of trusted.
export function restoreCoordinatorState(raw) {
  const base = createEmptyCoordinatorState();

  if (raw === null || typeof raw !== "object") {
    return base;
  }

  const pending = Array.isArray(raw.pending)
    ? raw.pending.filter(isMessage)
    : [];

  const batch = isBatch(raw.batch)
    ? { ...raw.batch, messages: raw.batch.messages.filter(isMessage) }
    : null;

  return {
    ...base,
    revision:
      Number.isInteger(raw.revision) && raw.revision >= 0
        ? raw.revision
        : 0,
    pending,
    batch,
    last_lease:
      Number.isInteger(raw.last_lease) && raw.last_lease >= 0
        ? raw.last_lease
        : 0,
    attempts:
      Number.isInteger(raw.attempts) && raw.attempts >= 0
        ? raw.attempts
        : 0,
    last_error:
      typeof raw.last_error === "string" ? raw.last_error : null,
    last_completed_at: finiteNumber(raw.last_completed_at, null),
    last_outcome:
      typeof raw.last_outcome === "string" ? raw.last_outcome : null,
    failed_batch:
      raw.failed_batch !== null && typeof raw.failed_batch === "object"
        ? raw.failed_batch
        : null,
    scheduled_for: finiteNumber(raw.scheduled_for, null),
  };
}

export function hasQueuedEvent(state, eventId) {
  if (state.pending.some((message) => message.eventId === eventId)) {
    return true;
  }

  if (
    state.batch &&
    state.batch.messages.some((message) => message.eventId === eventId)
  ) {
    return true;
  }

  return false;
}

// One trailing silence window per pending batch: an addressed message gets
// the short window, otherwise the group window applies.
export function silenceWindowMs(messages, random) {
  const addressed = messages.some(
    (message) => message.wasMentioned === true,
  );

  return addressed
    ? randomBetween(
        DEBOUNCE_MENTION_MIN_MS,
        DEBOUNCE_MENTION_MAX_MS,
        random,
      )
    : randomBetween(
        DEBOUNCE_GROUP_MIN_MS,
        DEBOUNCE_GROUP_MAX_MS,
        random,
      );
}

export function enqueueMessage(state, incoming, options) {
  const nowMs = options.nowMs;
  const pending = [...state.pending, incoming];
  const scheduledFor = Math.round(
    nowMs + silenceWindowMs(pending, options.random),
  );

  return {
    ...state,
    revision: state.revision + 1,
    pending,
    scheduled_for: scheduledFor,
    // A new arrival is a fresh chance for the queue: clear previous
    // failure bookkeeping so a stuck batch is not abandoned too early.
    attempts: 0,
    last_error: null,
  };
}

export function takeBatch(state, nowMs) {
  const lastLease = state.last_lease + 1;
  const batch = {
    id: `batch-${state.revision}-${lastLease}`,
    revision: state.revision,
    lease: lastLease,
    status: "processing",
    taken_at: Math.round(nowMs),
    messages: state.pending,
  };

  return {
    batch,
    state: {
      ...state,
      pending: [],
      batch,
      last_lease: lastLease,
      attempts: 0,
      scheduled_for: null,
    },
  };
}

export function isBatchLeased(state, batch) {
  return (
    state.batch !== null &&
    state.batch.id === batch.id &&
    state.batch.lease === batch.lease
  );
}

export function isBatchStale(state, batch) {
  return state.revision !== batch.revision;
}

export function finishBatch(state, batch, outcome, nowMs) {
  if (!isBatchLeased(state, batch)) {
    return state;
  }

  return {
    ...state,
    batch: null,
    attempts: 0,
    last_error: null,
    last_outcome: outcome,
    last_completed_at: Math.round(nowMs),
  };
}

export function scheduleRetry(state, batch, message, nowMs, retryDelayMs) {
  if (!isBatchLeased(state, batch)) {
    return state;
  }

  return {
    ...state,
    batch: { ...batch, status: "retry", taken_at: Math.round(nowMs) },
    attempts: state.attempts + 1,
    last_error: message,
    scheduled_for: Math.round(nowMs + retryDelayMs),
  };
}

export function abandonBatch(state, batch, message, nowMs) {
  if (!isBatchLeased(state, batch)) {
    return state;
  }

  return {
    ...state,
    batch: null,
    attempts: 0,
    last_error: message,
    last_outcome: "failed",
    last_completed_at: Math.round(nowMs),
    failed_batch: {
      id: batch.id,
      revision: batch.revision,
      messages: batch.messages.length,
      failed_at: Math.round(nowMs),
      error: message,
    },
  };
}
