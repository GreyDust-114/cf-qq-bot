// 测试上下文组装：把生产 runtime 接到内存 D1、假 fetch、手动时钟、
// 捕获 logger，以及按会话隔离的内存协调器 hub。

import { createProcessor } from "../../src/processor.js";
import { createRuntime } from "../../src/runtime.js";

import { createManualClock } from "./clock.js";
import { createSqliteD1 } from "./d1.js";
import { createFakeFetch } from "./fetch.js";
import { createTestHub } from "./hub.js";

export function createTestLogger() {
  const entries = [];

  const record = (level) =>
    (...args) => {
      entries.push({ level, args });
    };

  return {
    entries,
    has: (substring) =>
      entries.some((entry) =>
        entry.args.some((arg) => String(arg).includes(substring)),
      ),
    log: record("log"),
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
  };
}

export function createTestEnv(overrides = {}) {
  return {
    DB: overrides.DB ?? createSqliteD1(),
    QQ_APP_ID: "test-app-id",
    QQ_APP_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    LLM_API_KEY: "test-llm-key",
    LLM_BASE_URL: "https://api.deepseek.com",
    LLM_MODEL: "deepseek-flash",
    ALLOWED_GROUP_OPENID: "",
    ...overrides,
  };
}

export function createTestContext(options = {}) {
  const env = options.env ?? createTestEnv();
  const logger = options.logger ?? createTestLogger();
  const clock = options.clock ?? createManualClock();
  const fetchImpl =
    options.fetch ?? createFakeFetch(options.fetchHandlers);

  const overrides = {
    now: options.now ?? (() => clock.now()),
    sleep: options.sleep ?? clock.sleep,
    random: options.random ?? (() => 0.5),
    fetch: fetchImpl,
    logger,
  };

  const processor = createProcessor(env, overrides);

  const hub = createTestHub({
    clock,
    logger,
    random: overrides.random,
    recordIncoming: processor.recordIncoming,
    processBatch: processor.processBatch,
    ...(options.hub ?? {}),
  });

  const runtime = createRuntime(env, {
    ...overrides,
    coordinator: hub,
  });

  const deliver = async (payload) => {
    const result = await runtime.processIncomingMessage(payload);

    await hub.runAllAlarms();

    return result;
  };

  return {
    runtime,
    env,
    clock,
    logger,
    fetch: fetchImpl,
    hub,
    processor,
    deliver,
  };
}
