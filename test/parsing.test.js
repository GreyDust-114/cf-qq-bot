import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  cleanContent,
  mdToPlain,
  parseGroupDecision,
  parseIncomingMessage,
  splitReplyParts,
} from "../src/pure.js";

import { buildC2cPayload, buildGroupPayload, createTestEnv } from "./support/index.js";

const env = createTestEnv();

test("cleanContent strips bot mentions and renders face tags", () => {
  const facePayload = Buffer.from(
    JSON.stringify({ text: "笑死" }),
    "utf8",
  ).toString("base64");

  const raw =
    `<@!test-app-id> 你好 ` +
    `<faceType=1,faceId="1",ext="${facePayload}">`;

  assert.equal(cleanContent(raw, env.QQ_APP_ID), "你好 【表情:笑死】");
});

test("parseIncomingMessage maps a c2c message", () => {
  const incoming = parseIncomingMessage(
    buildC2cPayload({ id: "parse-1", content: "私聊消息" }),
    env,
  );

  assert.equal(incoming.scope, "c2c");
  assert.equal(incoming.conversationId, "c2c:user-openid-1");
  assert.equal(incoming.eventId, "parse-1");
  assert.equal(incoming.messageId, "parse-1");
  assert.equal(incoming.content, "私聊消息");
  assert.equal(incoming.wasMentioned, true);
});

test("parseIncomingMessage detects an explicit group mention", () => {
  const incoming = parseIncomingMessage(
    buildGroupPayload({
      id: "parse-2",
      content: "机器人你好",
      mentions: [{ is_you: true }],
    }),
    env,
  );

  assert.equal(incoming.scope, "group");
  assert.equal(incoming.conversationId, "group:group-openid-1");
  assert.equal(incoming.wasMentioned, true);
  assert.equal(incoming.senderName, "群友甲");
});

test("parseIncomingMessage treats quoted bot messages as mentions", () => {
  const incoming = parseIncomingMessage(
    buildGroupPayload({
      id: "parse-3",
      content: "这个说法有意思",
      mentioned: false,
      messageType: 103,
      msgElements: [
        {
          content: "之前的回复",
          author: { username: "新約エクシア", bot: true },
        },
      ],
    }),
    env,
  );

  assert.equal(incoming.wasMentioned, true);
  assert.equal(incoming.quotedBot, true);
  assert.match(incoming.content, /\[引用/);
});

test("parseIncomingMessage extracts images from attachments", () => {
  const incoming = parseIncomingMessage(
    buildC2cPayload({
      id: "parse-4",
      content: "",
      attachments: [
        {
          content_type: "image/jpeg",
          url: "https://example.com/photo.jpg",
          size: 2048,
        },
      ],
    }),
    env,
  );

  assert.deepEqual(incoming.imageUrls, ["https://example.com/photo.jpg"]);
  assert.match(incoming.content, /【图片】/);
});

test("parseIncomingMessage ignores messages from other groups", () => {
  const restricted = createTestEnv({
    ALLOWED_GROUP_OPENID: "group-allowed",
  });

  const incoming = parseIncomingMessage(
    buildGroupPayload({
      id: "parse-5",
      groupOpenid: "group-other",
      mentioned: true,
    }),
    restricted,
  );

  assert.equal(incoming, null);
});

test("splitReplyParts cleans markdown and caps at three parts", () => {
  const parts = splitReplyParts(
    "**加粗**|||`代码`|||第三|||第四",
  );

  assert.deepEqual(parts, ["加粗", "代码", "第三"]);
});

test("parseGroupDecision recognizes NO_REPLY and quoted replies", () => {
  assert.deepEqual(parseGroupDecision("NO_REPLY"), {
    kind: "no_reply",
    content: "",
  });
  assert.deepEqual(parseGroupDecision("no_reply，因为没必要"), {
    kind: "no_reply",
    content: "",
  });
  assert.deepEqual(parseGroupDecision("「好呀」"), {
    kind: "reply",
    content: "好呀",
  });
  assert.deepEqual(parseGroupDecision("   "), {
    kind: "empty",
    content: "",
  });
});

test("mdToPlain converts links and removes code fences", () => {
  const plain = mdToPlain(
    "看这个 [链接](https://example.com) 和 `行内` 代码\n```\n块代码\n```",
  );

  assert.match(plain, /链接 \(https:\/\/example\.com\)/);
  assert.match(plain, /和 行内 代码/);
  assert.match(plain, /块代码/);
  assert.doesNotMatch(plain, /```/);
});
