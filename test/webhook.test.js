import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";

import worker from "../src/index.js";
import {
  buildC2cPayload,
  createTestContext,
  jsonResponse,
  listMessages,
} from "./support/index.js";

const PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

// Deliberately re-implements the Ed25519 key derivation documented by QQ so
// the tests do not depend on the production signing helper.
function testPrivateKey(appSecret) {
  let seedText = appSecret;

  while (seedText.length < 32) {
    seedText += seedText;
  }

  const seed = Buffer.from(seedText.slice(0, 32), "utf8");

  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function signBody(appSecret, timestamp, body) {
  const bodyBuffer = Buffer.isBuffer(body)
    ? body
    : Buffer.from(String(body), "utf8");

  return crypto
    .sign(
      null,
      Buffer.concat([Buffer.from(timestamp, "utf8"), bodyBuffer]),
      testPrivateKey(appSecret),
    )
    .toString("hex");
}

function makeCtx() {
  return {
    promises: [],
    waitUntil(promise) {
      this.promises.push(promise);
    },
  };
}

async function signedRequest(env, body, options = {}) {
  const timestamp = options.timestamp ?? "1727000000";
  const signature =
    options.signature ?? signBody(env.QQ_APP_SECRET, timestamp, body);

  return new Request("https://example.com/qq/webhook", {
    method: "POST",
    headers: {
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": signature,
    },
    body,
  });
}

test("worker entry serves the health check", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/"),
    {},
    makeCtx(),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "QQ AI Bot is running.");
});

test("worker entry rejects unknown paths and non-POST webhook calls", async () => {
  const notFound = await worker.fetch(
    new Request("https://example.com/nope"),
    {},
    makeCtx(),
  );
  assert.equal(notFound.status, 404);

  const methodNotAllowed = await worker.fetch(
    new Request("https://example.com/qq/webhook"),
    {},
    makeCtx(),
  );
  assert.equal(methodNotAllowed.status, 405);
});

test("webhook rejects invalid JSON with 400", async () => {
  const { runtime } = createTestContext();

  const response = await runtime.handleRequest(
    new Request("https://example.com/qq/webhook", {
      method: "POST",
      body: "{not json",
    }),
    makeCtx(),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid json" });
});

test("op 13 validation returns a signature that verifies", async () => {
  const { runtime, env } = createTestContext();
  const body = JSON.stringify({
    op: 13,
    d: { plain_token: "plain-token-1", event_ts: "1727000000" },
  });

  const response = await runtime.handleRequest(
    new Request("https://example.com/qq/webhook", {
      method: "POST",
      body,
    }),
    makeCtx(),
  );

  assert.equal(response.status, 200);

  const data = await response.json();

  assert.equal(data.plain_token, "plain-token-1");

  const publicKey = crypto.createPublicKey(
    testPrivateKey(env.QQ_APP_SECRET),
  );
  const valid = crypto.verify(
    null,
    Buffer.from("1727000000plain-token-1", "utf8"),
    publicKey,
    Buffer.from(data.signature, "hex"),
  );

  assert.equal(valid, true);
});

test("op 13 validation rejects incomplete payloads", async () => {
  const { runtime } = createTestContext();

  const response = await runtime.handleRequest(
    new Request("https://example.com/qq/webhook", {
      method: "POST",
      body: JSON.stringify({ op: 13, d: { plain_token: "x" } }),
    }),
    makeCtx(),
  );

  assert.equal(response.status, 400);
});

test("webhook rejects a bad signature without scheduling work", async () => {
  const { runtime, env } = createTestContext();
  const ctx = makeCtx();
  const body = JSON.stringify(buildC2cPayload({ id: "bad-sig" }));

  const response = await runtime.handleRequest(
    await signedRequest(env, body, { signature: "00".repeat(64) }),
    ctx,
  );

  assert.equal(response.status, 401);
  assert.equal(ctx.promises.length, 0);
});

test("signed webhook event acks immediately and processes the message", async () => {
  const { runtime, env, fetch } = createTestContext({
    sleep: async () => {},
    fetchHandlers: { llmReply: "在的" },
  });
  const ctx = makeCtx();
  const body = JSON.stringify(
    buildC2cPayload({ id: "http-1", content: "在吗" }),
  );

  const response = await runtime.handleRequest(
    await signedRequest(env, body),
    ctx,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { op: 12, d: 0 });
  assert.equal(ctx.promises.length, 1);

  await ctx.promises[0];

  assert.equal(fetch.sendCalls().length, 1);

  const sendBody = JSON.parse(fetch.sendCalls()[0].body);

  assert.equal(sendBody.content, "在的");
  assert.equal(sendBody.msg_seq, 1);

  const messages = await listMessages(env, "c2c:user-openid-1");

  assert.equal(messages.length, 2);
});

test("duplicate event ids are ignored on redelivery", async () => {
  const { runtime, env, fetch, logger } = createTestContext({
    sleep: async () => {},
    fetchHandlers: { llmReply: "只回一次" },
  });
  const body = JSON.stringify(
    buildC2cPayload({ id: "dup-http", content: "重复推送" }),
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ctx = makeCtx();
    const response = await runtime.handleRequest(
      await signedRequest(env, body),
      ctx,
    );

    assert.equal(response.status, 200);
    await ctx.promises[0];
  }

  assert.equal(fetch.llmCalls().length, 1);
  assert.equal(fetch.sendCalls().length, 1);
  assert.ok(logger.has("Duplicate event ignored"));
});

test("webhook keeps responding when processing fails", async () => {
  const { runtime, env, logger } = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      onRequest: (call) =>
        call.url.endsWith("/chat/completions")
          ? jsonResponse({ error: "boom" }, 500)
          : null,
    },
  });
  const ctx = makeCtx();
  const body = JSON.stringify(
    buildC2cPayload({ id: "llm-500", content: "会失败吗" }),
  );

  const response = await runtime.handleRequest(
    await signedRequest(env, body),
    ctx,
  );

  assert.equal(response.status, 200);
  await ctx.promises[0];

  assert.ok(logger.has("stage=llm private failed"));
});
