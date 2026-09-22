import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildC2cPayload,
  buildGroupPayload,
  createTestContext,
  jsonResponse,
  listMessages,
  parseSendBody,
  waitFor,
} from "./helpers.js";

test("consecutive messages: earlier one defers, latest replies with merged context", async () => {
  const ctx = createTestContext({
    fetchHandlers: { llmReply: "收到" },
  });

  const first = ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "c1", content: "第一条" }),
  );

  await waitFor(() => ctx.clock.pendingCount() === 1, {
    label: "first debounce sleep",
  });

  const second = ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "c2", content: "第二条" }),
  );

  await waitFor(() => ctx.clock.pendingCount() === 2, {
    label: "second debounce sleep",
  });

  ctx.clock.releaseNext();
  await first;

  assert.ok(ctx.logger.has("Debounce: deferring to newer message"));

  ctx.clock.releaseNext();
  await second;

  assert.equal(ctx.fetch.llmCalls().length, 1);

  const llmBody = JSON.parse(ctx.fetch.llmCalls()[0].body);
  const userLines = llmBody.messages
    .filter((message) => message.role === "user")
    .map((message) => String(message.content));

  assert.equal(userLines.length, 1);
  assert.match(userLines[0], /第一条 第二条/);

  assert.equal(ctx.fetch.sendCalls().length, 1);
  assert.equal(parseSendBody(ctx.fetch.sendCalls()[0]).content, "收到");

  const messages = await listMessages(ctx.env, "c2c:user-openid-1");

  assert.equal(messages.filter((row) => row.role === "user").length, 2);
  assert.equal(messages.filter((row) => row.role === "assistant").length, 1);
});

test("a single reply is split into sequential parts with gaps", async () => {
  const sleeps = [];
  const ctx = createTestContext({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchHandlers: { llmReply: "第一段|||第二段|||第三段" },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "split-1", content: "分三条" }),
  );

  const sends = ctx.fetch.sendCalls().map(parseSendBody);

  assert.deepEqual(
    sends.map((send) => send.content),
    ["第一段", "第二段", "第三段"],
  );
  assert.deepEqual(
    sends.map((send) => send.msg_seq),
    [1, 2, 3],
  );

  // Debounce for an "always mentioned" c2c message plus two part gaps,
  // all deterministic because the test random source is fixed at 0.5.
  assert.deepEqual(sleeps, [4000, 800, 800]);

  const messages = await listMessages(ctx.env, "c2c:user-openid-1");
  const assistant = messages.filter((row) => row.role === "assistant");

  assert.deepEqual(
    assistant.map((row) => row.content),
    ["第一段 第二段 第三段"],
  );
});

test("reply parts are capped at three", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: { llmReply: "一|||二|||三|||四" },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "split-2", content: "超过三条" }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 3);
});

test("HTTP send failure is not retried and does not store a reply", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: "发不出去",
      onQQSend: () => jsonResponse({ message: "server error" }, 500),
    },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "fail-1", content: "试试" }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 1);
  assert.ok(ctx.logger.has("stage=send http 500"));

  const messages = await listMessages(ctx.env, "c2c:user-openid-1");

  assert.equal(messages.filter((row) => row.role === "assistant").length, 0);
});

test("network send failure is retried once and then succeeds", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: "重试成功",
      onQQSend: (call, attempt) => {
        if (attempt === 1) {
          throw new TypeError("fetch failed");
        }

        return jsonResponse({ id: "ok-after-retry" });
      },
    },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "fail-2", content: "再试试" }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 2);
  assert.ok(ctx.logger.has("stage=send attempt 1 failed"));

  const messages = await listMessages(ctx.env, "c2c:user-openid-1");

  assert.deepEqual(
    messages
      .filter((row) => row.role === "assistant")
      .map((row) => row.content),
    ["重试成功"],
  );
});

test("failed vision request falls back to a text-only retry", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      onRequest: (call) => {
        if (!call.url.endsWith("/chat/completions")) {
          return null;
        }

        const body = JSON.parse(call.body);
        const hasImages = body.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "image_url"),
        );

        if (hasImages) {
          return jsonResponse({ error: "vision unsupported" }, 400);
        }

        return jsonResponse({
          choices: [{ message: { content: "看到图了" } }],
        });
      },
    },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({
      id: "vision-1",
      content: "看这个",
      attachments: [
        {
          content_type: "image/png",
          url: "https://example.com/a.png",
          size: 1024,
        },
      ],
    }),
  );

  assert.equal(ctx.fetch.llmCalls().length, 2);
  assert.ok(ctx.logger.has("stage=llm vision failed"));

  const sendBody = parseSendBody(ctx.fetch.sendCalls()[0]);

  assert.equal(sendBody.content, "看到图了");
});

test("LLM failure still produces the private fallback reply", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      onRequest: (call) =>
        call.url.endsWith("/chat/completions")
          ? jsonResponse({ error: "boom" }, 500)
          : null,
    },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "fallback-1", content: "还在吗" }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 1);
  assert.equal(
    parseSendBody(ctx.fetch.sendCalls()[0]).content,
    "AI 服务暂时无法响应，请稍后再试。",
  );
  assert.ok(ctx.logger.has("stage=llm private failed"));
});

test("group decision NO_REPLY stays silent", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: { llmReply: "NO_REPLY" },
  });

  await ctx.runtime.processIncomingMessage(
    buildGroupPayload({ id: "group-1", content: "随便聊聊", mentioned: false }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 0);
  assert.ok(ctx.logger.has("Decision: no reply"));

  const messages = await listMessages(ctx.env, "group:group-openid-1");

  assert.equal(messages.filter((row) => row.role === "assistant").length, 0);
});

test("autonomous cooldown suppresses back-to-back interjections", async () => {
  const ctx = createTestContext({
    fetchHandlers: { llmReply: "接句话" },
  });

  const first = ctx.runtime.processIncomingMessage(
    buildGroupPayload({ id: "group-2", content: "话题一", mentioned: false }),
  );

  await waitFor(() => ctx.clock.pendingCount() === 1);
  ctx.clock.releaseNext();
  await first;

  const second = ctx.runtime.processIncomingMessage(
    buildGroupPayload({ id: "group-3", content: "话题二", mentioned: false }),
  );

  await waitFor(() => ctx.clock.pendingCount() === 1);
  ctx.clock.releaseNext();
  await second;

  assert.equal(ctx.fetch.llmCalls().length, 2);
  assert.equal(ctx.fetch.sendCalls().length, 1);
  assert.ok(ctx.logger.has("Autonomous reply skipped: cooldown active"));
});
