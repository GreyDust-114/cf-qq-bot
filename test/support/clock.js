// 测试用手动时钟：sleep 不占真实时间，由测试显式放行。

export function createManualClock(startMs = Date.UTC(2026, 8, 22, 4, 0, 0)) {
  let current = startMs;
  const pending = [];

  return {
    now: () => current,
    sleep: (ms) =>
      new Promise((resolve) => {
        pending.push({ ms, resolve });
      }),
    pendingCount: () => pending.length,
    releaseNext: () => {
      const item = pending.shift();

      if (!item) {
        throw new Error("manual clock: no pending sleep to release");
      }

      current += item.ms;
      item.resolve();
    },
    releaseAll: () => {
      while (pending.length > 0) {
        const item = pending.shift();
        current += item.ms;
        item.resolve();
      }
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export async function waitFor(predicate, options = {}) {
  const label = options.label ?? "condition";
  const tries = options.tries ?? 500;

  for (let index = 0; index < tries; index += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  throw new Error(`waitFor timed out: ${label}`);
}
