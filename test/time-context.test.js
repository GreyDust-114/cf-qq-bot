import { test } from "node:test";
import assert from "node:assert/strict";

import { stripTimePrefix } from "../src/pure.js";

import {
  buildC2cPayload,
  buildGroupPayload,
  createTestContext,
  parseSendBody,
} from "./support/index.js";

test("stripTimePrefix removes only the exact leading timestamp format", () => {
  assert.equal(stripTimePrefix("[09-22 16:26] 你好"), "你好");
  assert.equal(stripTimePrefix("[2026-09-22 16:26] 你好"), "你好");
  assert.equal(stripTimePrefix("[09-22 16:26:30] 你好"), "你好");

  // Dates and times discussed inside the text must survive.
  assert.equal(
    stripTimePrefix("今天 [09-22 16:26] 在开会"),
    "今天 [09-22 16:26] 在开会",
  );
  assert.equal(stripTimePrefix("09-22 16:26 你好"), "09-22 16:26 你好");
  assert.equal(stripTimePrefix("[] 你好"), "[] 你好");
});

test("assistant history keeps its plain form while user history keeps timestamps", async () => {
  const ctx = createTestContext({
    fetchHandlers: { llmReply: "好的" },
  });

  await ctx.deliver(
    buildC2cPayload({ id: "time-1", content: "第一句" }),
  );
  await ctx.deliver(
    buildC2cPayload({ id: "time-2", content: "第二句" }),
  );

  const second = JSON.parse(ctx.fetch.llmCalls()[1].body);
  const assistantLines = second.messages
    .filter((message) => message.role === "assistant")
    .map((message) => String(message.content));

  assert.deepEqual(assistantLines, ["好的"]);

  const userLines = second.messages
    .filter((message) => message.role === "user")
    .map((message) => String(message.content));

  assert.ok(userLines.length >= 2);
  assert.match(userLines[0], /^\[\d{2}-\d{2} \d{2}:\d{2}\] /);
});

test("group assistant history also keeps its plain form", async () => {
  const ctx = createTestContext({
    fetchHandlers: { llmReply: "收到" },
  });

  await ctx.deliver(
    buildGroupPayload({
      id: "group-time-1",
      content: "喂",
      mentioned: true,
    }),
  );
  await ctx.deliver(
    buildGroupPayload({
      id: "group-time-2",
      content: "接着说",
      mentioned: false,
    }),
  );

  const second = JSON.parse(ctx.fetch.llmCalls()[1].body);
  const assistantLines = second.messages
    .filter((message) => message.role === "assistant")
    .map((message) => String(message.content));

  assert.deepEqual(assistantLines, ["收到"]);
});

test("outbound replies lose a leading timestamp prefix but keep discussed dates", async () => {
  const replies = [
    JSON.stringify({ messages: ["[09-22 16:26] 你好呀"] }),
    JSON.stringify({ messages: ["[2026-09-22 16:26] 在的"] }),
    JSON.stringify({ messages: ["今天 [09-22 16:26] 在开会"] }),
    JSON.stringify({ messages: ["09-22 16:26 你好"] }),
  ];
  let index = 0;

  const ctx = createTestContext({
    fetchHandlers: {
      llmReply: () => replies[index++],
    },
  });

  for (const id of ["prefix-1", "prefix-2", "prefix-3", "prefix-4"]) {
    await ctx.deliver(buildC2cPayload({ id, content: id }));
  }

  const sends = ctx.fetch.sendCalls().map(parseSendBody);

  assert.deepEqual(
    sends.map((send) => send.content),
    ["你好呀", "在的", "今天 [09-22 16:26] 在开会", "09-22 16:26 你好"],
  );
});

test("the time context hint tells the model not to copy timestamps", async () => {
  const ctx = createTestContext({
    fetchHandlers: { llmReply: "好的" },
  });

  await ctx.deliver(
    buildC2cPayload({ id: "hint-1", content: "嗨" }),
  );

  const body = JSON.parse(ctx.fetch.llmCalls()[0].body);
  const systemLines = body.messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content));

  assert.ok(systemLines.some((line) => line.includes("当前时间")));
  assert.ok(systemLines.some((line) => line.includes("不要写进回复")));
});
