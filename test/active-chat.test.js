import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGroupPayload,
  createTestContext,
  parseSendBody,
} from "./support/index.js";

const GROUP_ID = "group:group-openid-1";

async function readActiveWindow(env, conversationId = GROUP_ID) {
  const row = await env.DB.prepare(
    `SELECT active_until, active_speaker_member_openid
     FROM conversations
     WHERE conversation_id = ?`,
  )
    .bind(conversationId)
    .first();

  return {
    until: Number(row?.active_until ?? 0),
    speaker: row?.active_speaker_member_openid ?? null,
  };
}

test("a group reply opens a 90s active window and the same speaker's follow-up is answered", async () => {
  let calls = 0;
  const ctx = createTestContext({
    fetchHandlers: {
      llmReply: () => {
        calls += 1;
        return calls === 1 ? "第一句" : "续上";
      },
    },
  });

  await ctx.deliver(
    buildGroupPayload({
      id: "active-1",
      content: "喂",
      mentioned: true,
      memberOpenid: "member-a",
    }),
  );

  let window = await readActiveWindow(ctx.env);

  assert.equal(window.speaker, "member-a");
  assert.equal(window.until, ctx.clock.now() + 90_000);

  // The follow-up does not @ the bot, but it comes from the same person while
  // the window is open, so it must take the reply path.
  ctx.clock.advance(30_000);

  await ctx.deliver(
    buildGroupPayload({
      id: "active-2",
      content: "继续说",
      mentioned: false,
      memberOpenid: "member-a",
    }),
  );

  const sends = ctx.fetch.sendCalls().map(parseSendBody);

  assert.deepEqual(
    sends.map((send) => send.content),
    ["第一句", "续上"],
  );
  assert.ok(ctx.logger.has("Route: active"));

  window = await readActiveWindow(ctx.env);

  assert.equal(window.until, ctx.clock.now() + 90_000);
});

test("other members during the active window still go through the model decision", async () => {
  let calls = 0;
  const ctx = createTestContext({
    fetchHandlers: {
      llmReply: () => {
        calls += 1;
        return calls === 1 ? "好呀" : "NO_REPLY";
      },
    },
  });

  await ctx.deliver(
    buildGroupPayload({
      id: "other-1",
      content: "喂",
      mentioned: true,
      memberOpenid: "member-a",
    }),
  );

  ctx.clock.advance(10_000);

  await ctx.deliver(
    buildGroupPayload({
      id: "other-2",
      content: "我也说一句",
      mentioned: false,
      memberOpenid: "member-b",
    }),
  );

  assert.equal(ctx.fetch.llmCalls().length, 2);
  assert.equal(ctx.fetch.sendCalls().length, 1);
  assert.ok(ctx.logger.has("Decision: no reply"));
  assert.ok(ctx.logger.has("Route: autonomous"));
});

test("after the active window expires, plain group messages return to autonomous rules", async () => {
  let calls = 0;
  const ctx = createTestContext({
    fetchHandlers: {
      llmReply: () => {
        calls += 1;
        return calls === 1 ? "好呀" : "NO_REPLY";
      },
    },
  });

  await ctx.deliver(
    buildGroupPayload({
      id: "expire-1",
      content: "喂",
      mentioned: true,
      memberOpenid: "member-a",
    }),
  );

  const before = await readActiveWindow(ctx.env);

  ctx.clock.advance(90_000);

  await ctx.deliver(
    buildGroupPayload({
      id: "expire-2",
      content: "还在吗",
      mentioned: false,
      memberOpenid: "member-a",
    }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 1);
  assert.ok(ctx.logger.has("Decision: no reply"));
  assert.ok(ctx.logger.has("Route: autonomous"));

  const after = await readActiveWindow(ctx.env);

  assert.equal(after.until, before.until);
  assert.ok(after.until < ctx.clock.now());
});

test("the interjection cooldown does not swallow the active speaker's continuation", async () => {
  let calls = 0;
  const ctx = createTestContext({
    fetchHandlers: {
      llmReply: () => {
        calls += 1;
        return calls === 1 ? "哈哈" : "我在呢";
      },
    },
  });

  // A non-mention message gets an autonomous reply: this opens the active
  // window and starts the 15-45s interjection cooldown for this group.
  await ctx.deliver(
    buildGroupPayload({
      id: "cool-1",
      content: "话题",
      mentioned: false,
      memberOpenid: "member-b",
    }),
  );

  assert.equal(ctx.fetch.sendCalls().length, 1);

  // Still inside the cooldown, the person the bot just talked to continues
  // the conversation: the continuation must not be swallowed.
  ctx.clock.advance(10_000);

  await ctx.deliver(
    buildGroupPayload({
      id: "cool-2",
      content: "接着说",
      mentioned: false,
      memberOpenid: "member-b",
    }),
  );

  const sends = ctx.fetch.sendCalls().map(parseSendBody);

  assert.deepEqual(
    sends.map((send) => send.content),
    ["哈哈", "我在呢"],
  );
  assert.ok(ctx.logger.has("Route: active"));
  assert.equal(ctx.logger.has("Autonomous reply skipped"), false);
});
