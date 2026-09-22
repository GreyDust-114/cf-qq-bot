import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildC2cPayload,
  createTestContext,
  jsonResponse,
  listMessages,
  listOutbox,
} from "./support/index.js";

const CONVERSATION = "c2c:user-openid-1";

test("each sent bubble leaves its own outbox and assistant record", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: JSON.stringify({ messages: ["一", "二"] }),
    },
  });

  await ctx.deliver(
    buildC2cPayload({ id: "outbox-1", content: "发两条" }),
  );

  const outbox = await listOutbox(ctx.env, CONVERSATION);

  assert.deepEqual(
    outbox.map((row) => [row.part_index, row.msg_seq, row.status]),
    [
      [1, 1, "sent"],
      [2, 2, "sent"],
    ],
  );
  assert.match(outbox[0].batch_id, /^batch-/);
  assert.equal(outbox[0].revision, 1);
  assert.ok(outbox.every((row) => row.assistant_message_id));

  const messages = await listMessages(ctx.env, CONVERSATION);
  const assistant = messages.filter((row) => row.role === "assistant");

  assert.deepEqual(
    assistant.map((row) => row.content),
    ["一", "二"],
  );

  assert.ok(ctx.logger.has("stage=outbox sent part=1"));
  assert.ok(ctx.logger.has("stage=outbox sent part=2"));
});

test("outbox rows carry the trigger event and revision for causal traces", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: { llmReply: "收到" },
  });

  await ctx.deliver(
    buildC2cPayload({ id: "outbox-link", content: "关联" }),
  );

  const [row] = await listOutbox(ctx.env, CONVERSATION);

  assert.equal(row.trigger_event_id, "outbox-link");
  assert.equal(row.revision, 1);
});

test("a failed bubble stops the rest and history only keeps what was sent", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: JSON.stringify({ messages: ["一", "二", "三"] }),
      onQQSend: (call, attempt) =>
        attempt === 2
          ? jsonResponse({ message: "server error" }, 500)
          : jsonResponse({ id: `ok-${attempt}` }),
    },
  });

  await ctx.deliver(
    buildC2cPayload({ id: "outbox-2", content: "中间失败" }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 2);

  const outbox = await listOutbox(ctx.env, CONVERSATION);

  assert.deepEqual(
    outbox.map((row) => [row.part_index, row.status]),
    [
      [1, "sent"],
      [2, "failed"],
      [3, "pending"],
    ],
  );
  assert.equal(outbox[1].error, "http");
  assert.ok(ctx.logger.has("stage=outbox failed part=2"));

  const assistant = (await listMessages(ctx.env, CONVERSATION)).filter(
    (row) => row.role === "assistant",
  );

  assert.deepEqual(
    assistant.map((row) => row.content),
    ["一"],
  );
});

test("an uncertain send is recorded and not resent automatically", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: JSON.stringify({ messages: ["可能发出去了"] }),
      onQQSend: () => {
        throw new TypeError("fetch failed");
      },
    },
  });

  await ctx.deliver(
    buildC2cPayload({ id: "outbox-3", content: "超时" }),
  );

  // One bubble, one network retry, then the outcome is uncertain.
  assert.equal(ctx.fetch.sendCalls().length, 2);

  const outbox = await listOutbox(ctx.env, CONVERSATION);

  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].status, "uncertain");
  assert.equal(outbox[0].error, "timeout");
  assert.ok(ctx.logger.has("stage=outbox uncertain part=1"));

  const assistant = (await listMessages(ctx.env, CONVERSATION)).filter(
    (row) => row.role === "assistant",
  );

  assert.equal(assistant.length, 0);

  await ctx.hub.runAllAlarms();

  assert.equal(ctx.fetch.sendCalls().length, 2);
});

test("a redelivered webhook does not create duplicate outbox rows or bubbles", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: JSON.stringify({ messages: ["只回一次"] }),
    },
  });
  const payload = buildC2cPayload({
    id: "outbox-dup",
    content: "重复推送",
  });

  await ctx.deliver(payload);
  await ctx.deliver(payload);

  assert.equal(ctx.fetch.sendCalls().length, 1);

  const outbox = await listOutbox(ctx.env, CONVERSATION);

  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].status, "sent");
});

test("re-running the same batch skips bubbles that were already sent", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: JSON.stringify({ messages: ["一", "二"] }),
    },
  });

  await ctx.deliver(
    buildC2cPayload({ id: "outbox-rec", content: "恢复" }),
  );

  const [first] = await listOutbox(ctx.env, CONVERSATION);
  const incoming = {
    scope: "c2c",
    targetId: "user-openid-1",
    conversationId: CONVERSATION,
    eventId: "outbox-rec",
    messageId: "outbox-rec",
    content: "恢复",
    imageUrls: [],
    senderName: "用户",
    wasMentioned: true,
  };

  const outcome = await ctx.processor.processBatch(
    {
      id: first.batch_id,
      revision: first.revision,
      lease: 1,
      status: "processing",
      taken_at: ctx.clock.now(),
      messages: [incoming],
    },
    { isCurrent: async () => ({ current: true }) },
  );

  assert.equal(outcome.status, "replied");
  assert.equal(ctx.fetch.sendCalls().length, 2);

  const outbox = await listOutbox(ctx.env, CONVERSATION);

  assert.deepEqual(
    outbox.map((row) => row.status),
    ["sent", "sent"],
  );

  const assistant = (await listMessages(ctx.env, CONVERSATION)).filter(
    (row) => row.role === "assistant",
  );

  assert.deepEqual(
    assistant.map((row) => row.content),
    ["一", "二"],
  );
});
