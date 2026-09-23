import { Buffer } from "node:buffer";

import {
  MAX_FACE_EXT_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_URL_LENGTH,
  MAX_REPLY_CHARS,
  MAX_REPLY_PARTS,
  MAX_REPLY_TOTAL_CHARS,
  BUBBLE_TARGET_MAX_CHARS,
  PART_GAP_MAX_MS,
  PART_GAP_MIN_MS,
  PART_GAP_PER_CHAR_MS,
  STORED_CONTENT_MAX_CHARS,
} from "./config.js";

import {
  GROUP_SYSTEM_PROMPT,
  GROUP_MENTION_SYSTEM_PROMPT,
  GROUP_CONTINUATION_SYSTEM_PROMPT,
  PRIVATE_SYSTEM_PROMPT,
} from "./prompts.js";

export function randomBetween(minMs, maxMs, random) {
  return minMs + random() * (maxMs - minMs);
}

export function formatNowForPrompt(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  }).formatToParts(new Date(nowMs));

  const get = (type) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return (
    `${get("year")}年${get("month")}月${get("day")}日 ` +
    `${get("weekday")} ${get("hour")}:${get("minute")}`
  );
}

export function formatMessageTime(ms) {
  const date = new Date(Number(ms) || Date.now());

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function estimateBase64Size(base64) {
  const len = base64.length;
  const padding = base64.endsWith("==")
    ? 2
    : base64.endsWith("=")
      ? 1
      : 0;

  return Math.ceil((len * 3) / 4) - padding;
}

export function parseFaceTags(text) {
  return String(text ?? "")
    .replace(
      /<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g,
      (match, ext) => {
        try {
          if (estimateBase64Size(ext) > MAX_FACE_EXT_BYTES) {
            return "【表情】";
          }

          const decoded = Buffer.from(ext, "base64").toString("utf8");
          const parsed = JSON.parse(decoded);
          const name = String(parsed?.text ?? "").trim();

          return name ? `【表情:${name}】` : "【表情】";
        } catch {
          return "【表情】";
        }
      },
    )
    .replace(/\[<face,id=\d+\/?>]/g, "【表情】");
}

export function cleanContent(content, appId) {
  const escapedAppId = String(appId).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );

  const stripped = String(content ?? "")
    .replace(new RegExp(`<@!?${escapedAppId}>\\s*`, "g"), "")
    .trim();

  return parseFaceTags(stripped).trim();
}

export function normalizeAttachmentUrl(url) {
  const value = String(url ?? "").trim();

  if (!value) {
    return "";
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  return value;
}

export function collectImageUrlInto(urls, att) {
  if (urls.length >= MAX_IMAGES_PER_MESSAGE) {
    return;
  }

  const contentType = String(att?.content_type ?? "").toLowerCase();

  if (!contentType.startsWith("image/")) {
    return;
  }

  const url = normalizeAttachmentUrl(att?.url);

  if (!url.startsWith("https://")) {
    return;
  }

  if (url.length > MAX_IMAGE_URL_LENGTH) {
    console.log("Image skipped: url too long");
    return;
  }

  const size = Number(att?.size ?? 0);

  if (size > MAX_IMAGE_BYTES) {
    console.log("Image skipped: file too large");
    return;
  }

  if (urls.includes(url)) {
    return;
  }

  urls.push(url);
}

export function collectImageUrls(attachments, urls = []) {
  if (!Array.isArray(attachments)) {
    return urls;
  }

  for (const att of attachments) {
    collectImageUrlInto(urls, att);
  }

  return urls;
}

export function collectImageUrlsFromElements(elements, urls, depth = 0) {
  if (!Array.isArray(elements) || elements.length === 0 || depth > 3) {
    return urls;
  }

  for (const element of elements) {
    if (!element || typeof element !== "object") {
      continue;
    }

    if (urls.length >= MAX_IMAGES_PER_MESSAGE) {
      return urls;
    }

    collectImageUrls(element.attachments, urls);
    collectImageUrlsFromElements(element.msg_elements, urls, depth + 1);
  }

  return urls;
}

export function describeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "";
  }

  const parts = [];

  for (const att of attachments) {
    const contentType = String(att?.content_type ?? "").toLowerCase();

    if (contentType.startsWith("image/")) {
      parts.push("【图片】");
    } else if (
      contentType === "voice" ||
      contentType.startsWith("audio/")
    ) {
      parts.push("【语音】");
    } else if (contentType.startsWith("video/")) {
      parts.push("【视频】");
    } else if (contentType === "file") {
      const name = String(att?.filename ?? "").trim();
      parts.push(name ? `【文件:${name}】` : "【文件】");
    } else {
      parts.push("【附件】");
    }
  }

  return parts.join(" ");
}

export function describeArkData(arkData) {
  if (!arkData || typeof arkData !== "object") {
    return "";
  }

  const fields =
    arkData.fields && typeof arkData.fields === "object"
      ? arkData.fields
      : {};

  const label = String(arkData.ark_name ?? arkData.ark_type ?? "卡片");

  const detail = [
    fields.title,
    fields.desc,
    fields.nickname,
    fields.address,
    arkData.prompt,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" - ");

  return detail ? `【分享:${label} ${detail}】` : `【分享:${label}】`;
}

export function describeMsgElements(elements, depth = 0, isQuote = false) {
  if (!Array.isArray(elements) || elements.length === 0 || depth > 3) {
    return "";
  }

  const parts = [];

  for (const element of elements) {
    if (!element || typeof element !== "object") {
      continue;
    }

    const content = String(element.content ?? "").trim();

    if (content) {
      const author = String(element.author?.username ?? "").trim();

      if (isQuote && depth === 0) {
        parts.push(
          author
            ? `[引用 ${author}：${content}]`
            : `[引用：${content}]`,
        );
      } else {
        parts.push(author ? `[${author}] ${content}` : content);
      }
    }

    const nested = describeMsgElements(element.msg_elements, depth + 1);

    if (nested) {
      parts.push(nested);
    }

    const attachmentText = describeAttachments(element.attachments);

    if (attachmentText) {
      parts.push(attachmentText);
    }
  }

  return parts.join("\n");
}

export function detectQuotedBot(message) {
  if (message?.message_type !== 103) {
    return false;
  }

  const first = Array.isArray(message?.msg_elements)
    ? message.msg_elements[0]
    : null;

  return first?.author?.bot === true;
}

export function buildRichContent(message, env) {
  const content = cleanContent(message?.content, env.QQ_APP_ID);
  const elementsText = describeMsgElements(
    message?.msg_elements,
    0,
    message?.message_type === 103,
  );
  const attachmentText = describeAttachments(message?.attachments);
  const arkText = describeArkData(message?.ark_data);

  const text = [elementsText, content, attachmentText, arkText]
    .filter(Boolean)
    .join("\n")
    .trim();

  const imageUrls = [];
  collectImageUrls(message?.attachments, imageUrls);
  collectImageUrlsFromElements(message?.msg_elements, imageUrls);

  return { text, imageUrls, quotedBot: detectQuotedBot(message) };
}

export function truncateStoredContent(text) {
  const value = String(text ?? "").trim();

  if (value.length <= STORED_CONTENT_MAX_CHARS) {
    return value;
  }

  return value.slice(0, STORED_CONTENT_MAX_CHARS - 1) + "…";
}

export function truncateReply(text) {
  const value = String(text ?? "").trim();

  if (value.length <= MAX_REPLY_CHARS) {
    return value;
  }

  return value.slice(0, MAX_REPLY_CHARS - 1) + "…";
}

// Removes a leading "[MM-DD HH:MM] " style prefix that the model sometimes
// copies from the context metadata. Only the exact leading timestamp format
// is touched; dates and times discussed inside the text survive.
export function stripTimePrefix(text) {
  return String(text ?? "")
    .replace(
      /^\s*\[(?:\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?\]\s*/,
      "",
    )
    .trim();
}

export function mdToPlain(md) {
  let value = String(md ?? "");

  value = value.replace(
    /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g,
    (_, body) => body.replace(/\n+$/, ""),
  );
  value = value.replace(/`([^`\n]+)`/g, "$1");
  value = value.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_, alt, url) => alt || url,
  );
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  value = value.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  value = value.replace(/\*\*([^*]+)\*\*/g, "$1");
  value = value.replace(/\*([^*\n]+)\*/g, "$1");
  value = value.replace(/~~([^~]+)~~/g, "$1");
  value = value.replace(/__([^_]+)__/g, "$1");
  value = value.replace(/^#{1,6}\s+/gm, "");
  value = value.replace(/^>\s?/gm, "");
  value = value.replace(/^\s*[-*+]\s+/gm, "• ");
  value = value.replace(/\n{3,}/g, "\n\n");

  return value.trim();
}

// Reply pacing: a bubble is followed by a gap proportional to its length,
// bounded to a natural typing rhythm. `random` is injected so tests are
// deterministic.
export function replyPartGapMs(previousText, random) {
  const length = String(previousText ?? "").length;
  const base = Math.min(
    PART_GAP_MAX_MS,
    PART_GAP_MIN_MS + length * PART_GAP_PER_CHAR_MS,
  );
  const jitter = 0.85 + random() * 0.3;

  return Math.round(base * jitter);
}

function stripCodeFence(value) {
  const fenced = value.match(
    /^```[a-zA-Z0-9_+-]*\s*\n?([\s\S]*?)\n?```$/,
  );

  return fenced ? fenced[1].trim() : value;
}

// A bubble should read like one short chat line. When the model writes a long
// sentence, split it at punctuation and pack the clauses into short bubbles.
// Clauses of separate model bubbles are never merged unless the total exceeds
// MAX_REPLY_PARTS, in which case the shortest neighbours are merged first.
const CLAUSE_BOUNDARY = /(?<=[。！？!?…；;，,、])/;

function splitIntoClauses(text) {
  return String(text ?? "")
    .split(CLAUSE_BOUNDARY)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function packClauses(clauses, maxChars) {
  const bubbles = [];
  let current = "";

  for (const clause of clauses) {
    const candidate = current + clause;

    if (current && candidate.length > maxChars) {
      bubbles.push(current);
      current = clause;
      continue;
    }

    current = candidate;
  }

  if (current) {
    bubbles.push(current);
  }

  return bubbles;
}

function splitLongBubble(bubble, maxChars) {
  if (bubble.length <= maxChars) {
    return [bubble];
  }

  const clauses = splitIntoClauses(bubble);

  if (clauses.length <= 1) {
    return [bubble];
  }

  return packClauses(clauses, maxChars);
}

function truncateBubbleToBudget(bubble, budget) {
  const clauses = splitIntoClauses(bubble);
  let out = "";

  for (const clause of clauses) {
    if (out && out.length + clause.length > budget) {
      break;
    }

    out += clause;
  }

  // A punctuation-less sentence can be one huge clause; hard-slice it so the
  // budget still holds.
  if (out.length > budget || !out) {
    out = out.slice(0, Math.max(1, budget - 1));
  }

  return `${out.replace(/[，,、；;：:]\s*$/, "")}…`;
}

function trimToTotalBudget(bubbles, maxTotal) {
  const kept = [];
  let total = 0;

  for (const bubble of bubbles) {
    if (kept.length === 0 && bubble.length > maxTotal) {
      return {
        bubbles: [truncateBubbleToBudget(bubble, maxTotal)],
        trimmed: true,
      };
    }

    if (kept.length > 0 && total + bubble.length > maxTotal) {
      break;
    }

    kept.push(bubble);
    total += bubble.length;
  }

  return { bubbles: kept, trimmed: kept.length < bubbles.length };
}

function mergeToCap(bubbles, maxParts) {
  const result = bubbles.slice();

  while (result.length > maxParts) {
    let bestIndex = 0;
    let bestLength = Infinity;

    for (let index = 0; index < result.length - 1; index += 1) {
      const combined = result[index].length + result[index + 1].length;

      if (combined < bestLength) {
        bestLength = combined;
        bestIndex = index;
      }
    }

    const left = result[bestIndex];
    const right = result[bestIndex + 1];
    // Real sentences need a connector when merged; single short fragments
    // would otherwise run together without any punctuation.
    const connector = /[。！？!?…；;，,、：:]\s*$/.test(left) ? "" : "，";

    result.splice(bestIndex, 2, left + connector + right);
  }

  return result;
}

function finalizeReplyMessages(items) {
  const dropped = items.some((item) => typeof item !== "string");
  // Every line break starts a new model bubble before the 1-4 bubble policy
  // is applied.
  const modelBubbles = items
    .flatMap((item) =>
      typeof item === "string" ? item.split(/\r?\n+/) : [item],
    )
    .filter((item) => typeof item === "string")
    .map((item) => mdToPlain(item))
    .filter(Boolean);

  if (modelBubbles.length === 0) {
    return { kind: "empty", messages: [], warning: null };
  }

  const split = modelBubbles.flatMap((bubble) =>
    splitLongBubble(bubble, BUBBLE_TARGET_MAX_CHARS),
  );
  const merged = mergeToCap(split, MAX_REPLY_PARTS);
  const trimmedResult = trimToTotalBudget(merged, MAX_REPLY_TOTAL_CHARS);
  const messages = trimmedResult.bubbles.map((bubble) =>
    truncateReply(bubble),
  );
  const normalized = messages.map((message, index) =>
    index < messages.length - 1
      ? message.replace(/[，,、；;：:]\s*$/, "").trim()
      : message,
  );

  return {
    kind: "messages",
    messages: normalized,
    warning: trimmedResult.trimmed
      ? "trimmed-total"
      : merged.length < split.length
        ? "merged-overflow"
        : dropped
          ? "non-string-bubble"
          : null,
  };
}

// Parses the model's structured reply protocol:
//   {"messages":["...", "..."]}  -> one to three complete bubbles
//   {"silent":true}                -> no reply (autonomous decision)
// Truncated JSON is rejected outright instead of being sent as text. Plain
// text is accepted as a single-bubble fallback so an old/invalid model output
// still produces something reasonable, and the fallback is observable in logs.
export function parseReplyOutput(raw) {
  const text = stripCodeFence(String(raw ?? "").trim());

  if (!text) {
    return { kind: "empty", messages: [], warning: null };
  }

  if (text.startsWith("{") || text.startsWith("[")) {
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "invalid", messages: [], warning: "json-parse" };
    }

    if (parsed !== null && typeof parsed === "object") {
      if (parsed.silent === true) {
        return { kind: "silent", messages: [], warning: null };
      }

      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.messages)
          ? parsed.messages
          : null;

      if (list !== null) {
        return finalizeReplyMessages(list);
      }
    }

    return { kind: "invalid", messages: [], warning: "json-shape" };
  }

  if (/^no_reply\b/i.test(text)) {
    return { kind: "silent", messages: [], warning: null };
  }

  if (text.includes("|||")) {
    return {
      ...finalizeReplyMessages(text.split("|||")),
      warning: "legacy-separator",
    };
  }

  return {
    ...finalizeReplyMessages([text]),
    warning: "plain-text-fallback",
  };
}

export function mergeConsecutiveUserMessages(rows) {
  const merged = [];

  for (const row of rows) {
    const last = merged[merged.length - 1];

    if (
      row.role === "user" &&
      last &&
      last.role === "user" &&
      last.sender_name === row.sender_name
    ) {
      last.content = `${last.content} ${row.content}`;
      last.event_id = row.event_id;
      last.created_at = row.created_at;
      continue;
    }

    merged.push({ ...row });
  }

  return merged;
}

export function buildImageParts(imageUrls) {
  return (imageUrls ?? []).map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
}

export function buildPrivateMessages(context, incoming, options = {}) {
  const messages = [
    { role: "system", content: PRIVATE_SYSTEM_PROMPT },
    {
      role: "system",
      content:
        `当前时间：${formatNowForPrompt(options.now)}（北京时间）。` +
        "聊天记录里用户消息前的时间戳是发送时间，只用于理解语境，不要写进回复。",
    },
  ];

  if (context.summary) {
    messages.push({
      role: "system",
      content: `此前对话的摘要：\n${context.summary}`,
    });
  }

  const history = mergeConsecutiveUserMessages(context.messages);

  history.forEach((row) => {
    const role = row.role === "assistant" ? "assistant" : "user";
    const isCurrent =
      row.role === "user" && row.event_id === incoming.eventId;
    const line =
      row.role === "assistant"
        ? row.content
        : `[${formatMessageTime(row.created_at)}] ${row.content}`;

    if (
      isCurrent &&
      options.includeImages !== false &&
      incoming.imageUrls?.length
    ) {
      messages.push({
        role,
        content: [
          { type: "text", text: line },
          ...buildImageParts(incoming.imageUrls),
        ],
      });
      return;
    }

    messages.push({ role, content: line });
  });

  if (history.length === 0) {
    messages.push({
      role: "user",
      content: incoming.content || "【图片】",
    });
  }

  return messages;
}

export function buildGroupMessages(context, incoming, options = {}) {
  const decision = options.decision === true;

  const messages = [
    {
      role: "system",
      content: decision
        ? GROUP_SYSTEM_PROMPT
        : options.continuation
          ? GROUP_CONTINUATION_SYSTEM_PROMPT
          : GROUP_MENTION_SYSTEM_PROMPT,
    },
    {
      role: "system",
      content:
        `当前时间：${formatNowForPrompt(options.now)}（北京时间）。` +
        "聊天记录里用户消息前的时间戳是发送时间，只用于理解语境，不要写进回复。",
    },
  ];

  if (context.summary) {
    messages.push({
      role: "system",
      content: `群聊长期摘要：\n${context.summary}`,
    });
  }

  const history = mergeConsecutiveUserMessages(context.messages);

  history.forEach((row) => {
    if (row.role === "assistant") {
      messages.push({
        role: "assistant",
        content: row.content,
      });
      return;
    }

    let text =
      `[${formatMessageTime(row.created_at)}] ` +
      `[${row.sender_name || "群成员"}] ${row.content}`;
    const isCurrent = row.event_id === incoming.eventId;

    if (isCurrent && decision) {
      text += incoming.wasMentioned
        ? "\n\n[系统提示] 这条消息明确 @ 了你，必须回复。"
        : "\n\n[系统提示] 这条消息没有 @ 你，请按群聊规则判断是否需要回复。";
    } else if (isCurrent && options.continuation) {
      text +=
        "\n\n[系统提示] 这条消息来自刚刚和你聊过的群友，" +
        "是刚才话题的继续，请直接自然地接话。";
    }

    if (
      isCurrent &&
      options.includeImages !== false &&
      incoming.imageUrls?.length
    ) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text },
          ...buildImageParts(incoming.imageUrls),
        ],
      });
      return;
    }

    messages.push({ role: "user", content: text });
  });

  if (history.length === 0) {
    messages.push({
      role: "user",
      content:
        `[${incoming.senderName || "群成员"}] ` +
        (incoming.content || "【图片】"),
    });
  }

  return messages;
}

export function isRetryableSendError(error) {
  if (!error) {
    return false;
  }

  const name = String(error.name ?? "");

  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    error instanceof TypeError
  );
}

export function parseIncomingMessage(payload, env) {
  const message = payload.d;

  if (payload.t === "C2C_MESSAGE_CREATE") {
    const openid = message?.author?.user_openid;
    const rich = buildRichContent(message, env);

    if (!openid || !message?.id) {
      return null;
    }

    if (!rich.text && rich.imageUrls.length === 0) {
      return null;
    }

    return {
      scope: "c2c",
      targetId: openid,
      conversationId: `c2c:${openid}`,
      eventId: message.id,
      messageId: message.id,
      content: rich.text,
      imageUrls: rich.imageUrls,
      senderName: "用户",
      wasMentioned: true,
    };
  }

  if (
    payload.t === "GROUP_MESSAGE_CREATE" ||
    payload.t === "GROUP_AT_MESSAGE_CREATE"
  ) {
    if (message?.author?.bot) {
      return null;
    }

    const groupOpenid = message?.group_openid;
    const memberOpenid = message?.author?.member_openid;

    const rich = buildRichContent(message, env);

    const wasMentioned =
      payload.t === "GROUP_AT_MESSAGE_CREATE" ||
      message?.mentions?.some(
        (mention) => mention?.is_you === true,
      ) === true ||
      rich.quotedBot === true;

    if (!rich.text && rich.imageUrls.length === 0) {
      if (!wasMentioned) {
        return null;
      }
      rich.text = "(只 @ 了机器人，没有其他内容)";
    }

    if (!groupOpenid || !memberOpenid || !message?.id) {
      return null;
    }

    if (
      env.ALLOWED_GROUP_OPENID &&
      groupOpenid !== env.ALLOWED_GROUP_OPENID
    ) {
      console.log("Ignored message from another group");
      return null;
    }

    return {
      scope: "group",
      targetId: groupOpenid,
      conversationId: `group:${groupOpenid}`,
      eventId: message.id,
      messageId: message.id,
      content: rich.text,
      imageUrls: rich.imageUrls,
      senderName: message?.author?.username?.trim() || "群成员",
      memberOpenid,
      wasMentioned,
      quotedBot: rich.quotedBot === true,
    };
  }

  return null;
}
