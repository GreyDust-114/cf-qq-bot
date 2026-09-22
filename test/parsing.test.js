import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  cleanContent,
  mdToPlain,
  parseIncomingMessage,
  parseReplyOutput,
  replyPartGapMs,
} from "../src/pure.js";

import { PART_GAP_MAX_MS, PART_GAP_MIN_MS } from "../src/config.js";

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

test("parseReplyOutput accepts a structured message array", () => {
  const parsed = parseReplyOutput(
    '{"messages":["第一句","第二句","第三句"]}',
  );

  assert.equal(parsed.kind, "messages");
  assert.deepEqual(parsed.messages, ["第一句", "第二句", "第三句"]);
  assert.equal(parsed.warning, null);
});

test("parseReplyOutput unwraps fenced JSON and cleans each bubble", () => {
  const parsed = parseReplyOutput(
    '```json\n{"messages":["**加粗**","`代码`"]}\n```',
  );

  assert.equal(parsed.kind, "messages");
  assert.deepEqual(parsed.messages, ["加粗", "代码"]);
});

test("long bubbles are split at punctuation into short bubbles without dangling separators", () => {
  const parsed = parseReplyOutput(
    JSON.stringify({
      messages: [
        "那个包看着就痒，别挠啊，越挠越大，明天肿起来更难受，随便抹点东西吧",
      ],
    }),
  );

  assert.equal(parsed.kind, "messages");
  assert.deepEqual(parsed.messages, [
    "那个包看着就痒，别挠啊",
    "越挠越大，明天肿起来更难受",
    "随便抹点东西吧",
  ]);
});

test("model bubbles stay separate when they are already short", () => {
  const parsed = parseReplyOutput(
    '{"messages":["好的","没问题"]}',
  );

  assert.deepEqual(parsed.messages, ["好的", "没问题"]);
});

test("non-final separator punctuation is removed but internal and final punctuation survive", () => {
  const parsed = parseReplyOutput(
    '{"messages":["那就别再开新的了，","改完立刻关电脑，","晚安。"]}',
  );

  assert.deepEqual(parsed.messages, [
    "那就别再开新的了",
    "改完立刻关电脑",
    "晚安。",
  ]);
});

test("a single bubble keeps its own final punctuation", () => {
  const parsed = parseReplyOutput(
    '{"messages":["那就别再开新的了，"]}',
  );

  assert.deepEqual(parsed.messages, ["那就别再开新的了，"]);
});

test("overflow beyond four bubbles is merged without dropping content", () => {
  const parsed = parseReplyOutput(
    '{"messages":["一甲","二甲","三甲","四甲","五甲","六甲"]}',
  );

  assert.equal(parsed.kind, "messages");
  assert.equal(parsed.messages.length, 4);
  assert.equal(parsed.messages.join(""), "一甲二甲三甲四甲五甲六甲");
  assert.equal(parsed.warning, "merged-overflow");
});

test("parseReplyOutput merges overflow bubbles instead of dropping them", () => {
  const parsed = parseReplyOutput(
    '{"messages":["一","二","三","四","五"]}',
  );

  assert.equal(parsed.kind, "messages");
  assert.deepEqual(parsed.messages, ["一二", "三", "四", "五"]);
  assert.equal(parsed.warning, "merged-overflow");
});

test("parseReplyOutput rejects truncated JSON instead of half of it", () => {
  const parsed = parseReplyOutput('{"messages":["一","二"');

  assert.equal(parsed.kind, "invalid");
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.warning, "json-parse");
});

test("parseReplyOutput recognizes silent and legacy NO_REPLY", () => {
  assert.equal(parseReplyOutput('{"silent":true}').kind, "silent");
  assert.equal(parseReplyOutput("NO_REPLY").kind, "silent");
  assert.equal(parseReplyOutput("   ").kind, "empty");
});

test("parseReplyOutput falls back to a single plain-text bubble", () => {
  const parsed = parseReplyOutput("就是普通的一句话");

  assert.equal(parsed.kind, "messages");
  assert.deepEqual(parsed.messages, ["就是普通的一句话"]);
  assert.equal(parsed.warning, "plain-text-fallback");
});

test("parseReplyOutput keeps the legacy separator fallback observable", () => {
  const parsed = parseReplyOutput("一|||二");

  assert.equal(parsed.kind, "messages");
  assert.deepEqual(parsed.messages, ["一", "二"]);
  assert.equal(parsed.warning, "legacy-separator");
});

test("parseReplyOutput splits newlines inside one bubble", () => {
  const parsed = parseReplyOutput(
    '{"messages":["第一句，先说这个\\n\\n第二句，再说这个"]}',
  );

  assert.equal(parsed.kind, "messages");
  assert.deepEqual(parsed.messages, [
    "第一句，先说这个",
    "第二句，再说这个",
  ]);
  assert.equal(parsed.warning, null);
});

test("plain-text fallback also splits paragraphs into bubbles", () => {
  const parsed = parseReplyOutput("第一句，先说这个\n\n第二句，再说这个");

  assert.equal(parsed.kind, "messages");
  assert.deepEqual(parsed.messages, [
    "第一句，先说这个",
    "第二句，再说这个",
  ]);
  assert.equal(parsed.warning, "plain-text-fallback");
});

test("single line breaks also become separate bubbles", () => {
  const parsed = parseReplyOutput("第一句\n第二句");

  assert.deepEqual(parsed.messages, ["第一句", "第二句"]);
});

test("split bubbles still obey the four-bubble overflow merge", () => {
  const parsed = parseReplyOutput(
    '{"messages":["一\\n二","三","四","五"]}',
  );

  assert.deepEqual(parsed.messages, ["一二", "三", "四", "五"]);
  assert.equal(parsed.warning, "merged-overflow");
});

test("replyPartGapMs grows with the previous bubble and stays bounded", () => {
  const random = () => 0.5;

  assert.equal(replyPartGapMs("", random), PART_GAP_MIN_MS);
  assert.equal(replyPartGapMs("x".repeat(500), random), PART_GAP_MAX_MS);
  assert.ok(
    replyPartGapMs("好的", random) <
      replyPartGapMs("这是一条明显更长的消息内容", random),
  );
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
