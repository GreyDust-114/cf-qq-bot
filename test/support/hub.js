// 测试用会话 hub：按 conversationId 给每个会话一个独立协调器，
// 模拟真实环境中「每个会话一个 Durable Object」的寻址与并行模型。
//
// 生产环境的 alarm 由 Cloudflare 调度；这里把它变成手动时钟上的待办，
// 测试通过 runNextAlarm / runAllAlarms / startNextAlarm 显式驱动。

import { createCoordinator } from "../../src/coordinator.js";
import { COORDINATOR_STATE_KEY } from "../../src/coordinator-state.js";

export { COORDINATOR_STATE_KEY };

export function createTestHub(options) {
  const clock = options.clock;
  const logger = options.logger;
  const random = options.random ?? (() => 0.5);
  const recordIncoming = options.recordIncoming;
  const processBatch = options.processBatch;
  const oversized = {
    staleMs: options.staleMs,
    retryDelayMs: options.retryDelayMs,
    maxAttempts: options.maxAttempts,
  };

  const entries = new Map();
  const alarms = [];

  function cancelAlarm(conversationId) {
    for (let index = alarms.length - 1; index >= 0; index -= 1) {
      if (alarms[index].conversationId === conversationId) {
        alarms.splice(index, 1);
      }
    }
  }

  function scheduleAlarm(conversationId, at) {
    cancelAlarm(conversationId);
    alarms.push({ conversationId, at });
    alarms.sort((a, b) => a.at - b.at);
  }

  function ensureConversation(conversationId) {
    const existing = entries.get(conversationId);

    if (existing) {
      return existing;
    }

    const storage = new Map();
    const entry = {
      conversationId,
      storage,
      alarmAt: null,
      coordinator: null,
    };

    entry.coordinator = createCoordinator({
      storage: {
        get: async (key) => storage.get(key),
        put: async (key, value) => {
          storage.set(key, structuredClone(value));
        },
        delete: async (key) => {
          storage.delete(key);
        },
      },
      scheduler: {
        setAlarm: async (at) => {
          entry.alarmAt = Number(at);
          scheduleAlarm(conversationId, entry.alarmAt);
        },
        clearAlarm: async () => {
          entry.alarmAt = null;
          cancelAlarm(conversationId);
        },
      },
      now: () => clock.now(),
      random,
      logger,
      recordIncoming,
      processBatch,
      ...(Number.isFinite(oversized.staleMs)
        ? { staleMs: oversized.staleMs }
        : {}),
      ...(Number.isFinite(oversized.retryDelayMs)
        ? { retryDelayMs: oversized.retryDelayMs }
        : {}),
      ...(Number.isFinite(oversized.maxAttempts)
        ? { maxAttempts: oversized.maxAttempts }
        : {}),
    });

    entries.set(conversationId, entry);
    return entry;
  }

  function startNextAlarm() {
    const next = alarms.shift();

    if (!next) {
      throw new Error("test hub: no pending alarm");
    }

    if (next.at > clock.now()) {
      clock.advance(next.at - clock.now());
    }

    return entries.get(next.conversationId).coordinator.alarm();
  }

  async function runNextAlarm() {
    return startNextAlarm();
  }

  async function runAllAlarms(runOptions = {}) {
    const max = runOptions.max ?? 100;
    let steps = 0;

    while (alarms.length > 0) {
      if (steps >= max) {
        throw new Error("test hub: alarms did not settle");
      }

      steps += 1;
      await runNextAlarm();
    }
  }

  return {
    enqueue: (incoming) =>
      ensureConversation(incoming.conversationId).coordinator.enqueue(
        incoming,
      ),
    ensureConversation,
    stateFor: (conversationId) =>
      ensureConversation(conversationId).storage.get(
        COORDINATOR_STATE_KEY,
      ) ?? null,
    pendingAlarmCount: () => alarms.length,
    nextAlarmAt: () => alarms[0]?.at ?? null,
    pendingAlarms: () => alarms.map((alarm) => ({ ...alarm })),
    startNextAlarm,
    runNextAlarm,
    runAllAlarms,
  };
}
