// Dependency injection seam for the runtime.
//
// Production defaults are the real clock, sleep, randomness, fetch, and
// console logger. Tests replace them with a manual clock, scripted fetch,
// and a capturing logger so message handling is deterministic and offline.

export function createDependencies(env, overrides = {}) {
  return {
    env,
    now: overrides.now ?? (() => Date.now()),
    sleep:
      overrides.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: overrides.random ?? (() => Math.random()),
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    logger: overrides.logger ?? console,
  };
}
