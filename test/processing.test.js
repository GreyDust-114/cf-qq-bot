import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildC2cPayload,
  buildGroupPayload,
  createTestContext,
  jsonResponse,
  listMessages,
  parseSendBody,
} from "./support/index.js";

test("consecutive messages merge into one tracked batch and the latest context is used", async () => {
  const ctx = createTestContext({
    fetchHandlers: { llmReply: "收到" },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "c1", content: "第一条" }),
  );
  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "c2", content: "第二条" }),
  );

  // The trailing silence window resets on every arrival, so there is exactly
  // one pending alarm and one merged batch, not two generation tasks.
  assert.equal(ctx.hub.pendingAlarmCount(), 1);

  const state = ctx.hub.stateFor("c2c:user-openid-1");

  assert.equal(state.revision, 2);
  assert.deepEqual(
    state.pending.map((message) => message.eventId),
    ["c1", "c2"],
  );

  await ctx.hub.runAllAlarms();

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

test("a reply that is superseded during generation is dropped before sending", async () => {
  let ctx;
  let llmIndex = 0;

  ctx = createTestContext({
    fetchHandlers: {
      onRequest: async (call) => {
        if (!call.url.endsWith("/chat/completions")) {
          return null;
        }

        llmIndex += 1;

        if (llmIndex === 1) {
          // A newer message arrives while the first generation is in flight.
          await ctx.runtime.processIncomingMessage(
            buildC2cPayload({ id: "newer", content: "更晚的话" }),
          );

          return jsonResponse({
            choices: [{ message: { content: "过时回复" } }],
          });
        }

        return jsonResponse({
          choices: [{ message: { content: "最新回复" } }],
        });
      },
    },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "older", content: "先说的话" }),
  );
  await ctx.hub.runAllAlarms();

  const sentContents = ctx.fetch
    .sendCalls()
    .map((call) => parseSendBody(call).content);

  assert.deepEqual(sentContents, ["最新回复"]);
  assert.equal(ctx.fetch.llmCalls().length, 2);
  assert.ok(ctx.logger.has("dropping stale reply"));
  assert.ok(ctx.logger.has("newer-messages"));

  const messages = await listMessages(ctx.env, "c2c:user-openid-1");

  assert.deepEqual(
    messages.map((row) => [row.role, row.content]),
    [
      ["user", "先说的话"],
      ["user", "更晚的话"],
      ["assistant", "最新回复"],
    ],
  );
});

test("a structured reply sends its bubbles in order with length-aware gaps", async () => {
  const sleeps = [];
  const ctx = createTestContext({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchHandlers: {
      llmReply: JSON.stringify({
        messages: ["第一段", "第二段", "第三段"],
      }),
    },
  });

  await ctx.deliver(
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

  // Each bubble is three characters: 300ms base + 3 * 30ms per char, with
  // the test random source fixed at 0.5 (jitter factor 1.0).
  assert.deepEqual(sleeps, [390, 390]);

  const messages = await listMessages(ctx.env, "c2c:user-openid-1");
  const assistant = messages.filter((row) => row.role === "assistant");

  assert.deepEqual(
    assistant.map((row) => row.content),
    ["第一段", "第二段", "第三段"],
  );
});

test("overflow bubbles are merged into the last bubble, never silently dropped", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: JSON.stringify({
        messages: ["一", "二", "三", "四", "五"],
      }),
    },
  });

  await ctx.deliver(
    buildC2cPayload({ id: "split-2", content: "超过三条" }),
  );

  const sends = ctx.fetch.sendCalls().map(parseSendBody);

  assert.deepEqual(
    sends.map((send) => send.content),
    ["一", "二", "三 四 五"],
  );
  assert.ok(ctx.logger.has("merged-overflow"));
});

test("a truncated structured reply falls back instead of sending half the JSON", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: '{"messages":["前半","后半"',
    },
  });

  await ctx.deliver(
    buildGroupPayload({
      id: "split-3",
      content: "截断的回复",
      mentioned: true,
    }),
  );

  const sends = ctx.fetch.sendCalls().map(parseSendBody);

  assert.deepEqual(
    sends.map((send) => send.content),
    ["刚刚走神了一下，你再说一次？"],
  );
  assert.ok(ctx.logger.has("reply invalid"));
});

test("remaining bubbles stop when a newer message arrives after the first one", async () => {
  let ctx;
  let llmIndex = 0;

  ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: () => {
        llmIndex += 1;

        if (llmIndex === 1) {
          return JSON.stringify({
            messages: ["第一句", "第二句", "第三句"],
          });
        }

        return "新回复";
      },
      onQQSend: async (call, attempt) => {
        if (attempt === 1) {
          await ctx.runtime.processIncomingMessage(
            buildC2cPayload({
              id: "newer-during-parts",
              content: "打断一下",
            }),
          );
        }

        return jsonResponse({ id: `part-${attempt}` });
      },
    },
  });

  await ctx.runtime.processIncomingMessage(
    buildC2cPayload({ id: "parts-1", content: "慢慢说" }),
  );
  await ctx.hub.runAllAlarms();

  const sends = ctx.fetch.sendCalls().map(parseSendBody);

  assert.deepEqual(
    sends.map((send) => send.content),
    ["第一句", "新回复"],
  );
  assert.ok(ctx.logger.has("newer messages arrived, stopping"));
  assert.ok(ctx.logger.has("partial reply stopped"));

  const messages = await listMessages(ctx.env, "c2c:user-openid-1");
  const assistant = messages.filter((row) => row.role === "assistant");

  assert.deepEqual(
    assistant.map((row) => row.content),
    ["第一句", "新回复"],
  );
});

test("HTTP send failure is not retried and does not store a reply", async () => {
  const ctx = createTestContext({
    sleep: async () => {},
    fetchHandlers: {
      llmReply: "发不出去",
      onQQSend: () => jsonResponse({ message: "server error" }, 500),
    },
  });

  await ctx.deliver(
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

  await ctx.deliver(
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

  await ctx.deliver(
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

  await ctx.deliver(
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

  await ctx.deliver(
    buildGroupPayload({
      id: "group-1",
      content: "随便聊聊",
      mentioned: false,
    }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 0);
  assert.ok(ctx.logger.has("Decision: no reply"));

  const messages = await listMessages(ctx.env, "group:group-openid-1");

  assert.equal(messages.filter((row) => row.role === "assistant").length, 0);
});

test("autonomous cooldown suppresses other members' back-to-back interjections", async () => {
  const ctx = createTestContext({
    fetchHandlers: { llmReply: "接句话" },
  });

  await ctx.deliver(
    buildGroupPayload({
      id: "group-2",
      content: "话题一",
      mentioned: false,
      memberOpenid: "member-openid-1",
    }),
  );

  // Same group, different member: this is a new interjection, not a
  // continuation of the conversation the bot just joined.
  await ctx.deliver(
    buildGroupPayload({
      id: "group-3",
      content: "话题二",
      mentioned: false,
      memberOpenid: "member-openid-2",
    }),
  );

  assert.equal(ctx.fetch.llmCalls().length, 2);
  assert.equal(ctx.fetch.sendCalls().length, 1);
  assert.ok(ctx.logger.has("Autonomous reply skipped: cooldown active"));
});
