// Shared test harness.
//
// The harness keeps tests offline and deterministic:
// - a D1-compatible adapter backed by node:sqlite with the real migrations,
// - a manual clock so debounce sleeps and cooldown checks are controlled,
// - a scripted fetch for QQ token, DeepSeek, and QQ send calls.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createRuntime } from "../src/runtime.js";

export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export const QQ_SEND_PATTERN = /\/v2\/(groups|users)\//;

const SCHEMA_SQL = readFileSync(
  new URL("../db/migrations/0001_init.sql", import.meta.url),
  "utf8",
);

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createSqliteD1() {
  const database = new DatabaseSync(":memory:");

  database.exec(SCHEMA_SQL);

  function statement(sql) {
    let params = [];

    const bound = {
      bind(...values) {
        params = values;
        return bound;
      },
      async first() {
        const row = database.prepare(sql).get(...params);
        return row === undefined ? null : row;
      },
      async all() {
        return {
          success: true,
          results: database.prepare(sql).all(...params),
        };
      },
      async run() {
        const result = database.prepare(sql).run(...params);

        return {
          success: true,
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid),
          },
        };
      },
    };

    return bound;
  }

  return {
    database,
    prepare: statement,
  };
}

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

export function createFakeFetch(handlers = {}) {
  const calls = [];

  const sendCalls = () =>
    calls.filter(
      (call) => call.method === "POST" && QQ_SEND_PATTERN.test(call.url),
    );

  const llmCalls = () =>
    calls.filter((call) => call.url.endsWith("/chat/completions"));

  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url);
    const call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      init,
    };

    calls.push(call);

    if (handlers.onRequest) {
      const custom = await handlers.onRequest(call, calls);

      if (custom) {
        return custom;
      }
    }

    if (url.startsWith(QQ_TOKEN_URL)) {
      return jsonResponse({
        access_token: "test-access-token",
        expires_in: 7200,
      });
    }

    if (url.endsWith("/chat/completions")) {
      const reply =
        typeof handlers.llmReply === "function"
          ? handlers.llmReply(call, llmCalls().length)
          : (handlers.llmReply ?? "好的");

      return jsonResponse({
        choices: [{ message: { content: reply } }],
      });
    }

    if (QQ_SEND_PATTERN.test(url)) {
      if (handlers.onQQSend) {
        return handlers.onQQSend(call, sendCalls().length);
      }

      return jsonResponse({ id: `mock-message-${sendCalls().length}` });
    }

    throw new Error(`unexpected fetch: ${url}`);
  };

  impl.calls = calls;
  impl.llmCalls = llmCalls;
  impl.sendCalls = sendCalls;

  return impl;
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
  const fetchImpl = options.fetch ?? createFakeFetch(options.fetchHandlers);

  const runtime = createRuntime(env, {
    now: options.now ?? (() => clock.now()),
    sleep: options.sleep ?? clock.sleep,
    random: options.random ?? (() => 0.5),
    fetch: fetchImpl,
    logger,
  });

  return { runtime, env, clock, logger, fetch: fetchImpl };
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

export function buildC2cPayload({
  id,
  content = "你好",
  userOpenid = "user-openid-1",
  attachments,
  msgElements,
  messageType,
} = {}) {
  return {
    op: 0,
    t: "C2C_MESSAGE_CREATE",
    id: `event-${id}`,
    d: {
      id,
      content,
      author: { user_openid: userOpenid },
      ...(attachments ? { attachments } : {}),
      ...(msgElements ? { msg_elements: msgElements } : {}),
      ...(messageType ? { message_type: messageType } : {}),
    },
  };
}

export function buildGroupPayload({
  id,
  content = "你好",
  groupOpenid = "group-openid-1",
  memberOpenid = "member-openid-1",
  username = "群友甲",
  mentioned = false,
  mentions,
  attachments,
  msgElements,
  messageType,
} = {}) {
  return {
    op: 0,
    t: mentioned ? "GROUP_AT_MESSAGE_CREATE" : "GROUP_MESSAGE_CREATE",
    id: `event-${id}`,
    d: {
      id,
      content,
      group_openid: groupOpenid,
      author: { member_openid: memberOpenid, username },
      ...(mentions ? { mentions } : {}),
      ...(attachments ? { attachments } : {}),
      ...(msgElements ? { msg_elements: msgElements } : {}),
      ...(messageType ? { message_type: messageType } : {}),
    },
  };
}

export async function listMessages(env, conversationId) {
  const { results } = await env.DB.prepare(
    `SELECT role, content, event_id
     FROM messages
     WHERE conversation_id = ?
     ORDER BY id`,
  )
    .bind(conversationId)
    .all();

  return results;
}

export function parseSendBody(call) {
  return JSON.parse(call.body);
}
