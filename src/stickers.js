import { STICKER_MAX_BYTES } from "./config.js";

const DEFAULT_HASH_TIMEOUT_MS = 8_000;
const MAX_NOTE_CHARS = 160;
const FINGERPRINT_PREFIX_LENGTH = 8;
const encoder = new TextEncoder();

export const STICKER_ASSET_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

async function readImageBytes(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length <= maxBytes ? bytes : null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fingerprintStickerBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", view),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Only fetch transiently to identify or curate the image. Incoming images are
// hashed and discarded; image bytes are stored only after the owner explicitly
// asks to collect the sticker as an outbound asset.
export async function fetchStickerImage(
  url,
  fetchImpl = fetch,
  options = {},
) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    return { ok: false, reason: "invalid-url" };
  }

  const maxBytes = Math.max(1, Number(options.maxBytes) || STICKER_MAX_BYTES);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_HASH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "http", status: response.status };

    const mimeType = String(response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith("image/")) {
      return { ok: false, reason: "mime" };
    }

    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > maxBytes) return { ok: false, reason: "too-large" };

    const bytes = await readImageBytes(response, maxBytes);
    if (!bytes) return { ok: false, reason: "too-large" };
    if (bytes.length === 0) return { ok: false, reason: "empty" };

    return { ok: true, bytes, mimeType, size: bytes.length };
  } catch {
    return { ok: false, reason: "fetch-failed" };
  }
}

export async function fetchStickerFingerprint(
  url,
  fetchImpl = fetch,
  options = {},
) {
  const image = await fetchStickerImage(url, fetchImpl, options);
  if (!image.ok) return image;
  return {
    ok: true,
    fingerprint: await fingerprintStickerBytes(image.bytes),
    mimeType: image.mimeType,
    size: image.size,
  };
}

export function stickerBytesToBase64(bytes) {
  return bytesToBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

export function stickerAssetName(fingerprint) {
  return `sticker-${String(fingerprint ?? "").slice(0, 16).toLowerCase()}`;
}

function bytesToBase64(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function sourceUrlKey(secret) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("QQ_APP_SECRET is unavailable for temporary URL encryption");
  }
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`BOT-020 sticker source URL\\n${secret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptStickerSourceUrl(url, secret) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || url.length > 8192) {
    return null;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sourceUrlKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(url),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptStickerSourceUrl(ciphertext, secret) {
  try {
    const [ivText, dataText, extra] = String(ciphertext ?? "").split(".");
    if (!ivText || !dataText || extra !== undefined) return null;
    const key = await sourceUrlKey(secret);
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(ivText) },
      key,
      base64ToBytes(dataText),
    );
    const url = new TextDecoder().decode(clear);
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? url
      : null;
  } catch {
    return null;
  }
}

export function normalizeStickerNote(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

export function stickerReviewId(fingerprint) {
  return String(fingerprint ?? "").slice(0, FINGERPRINT_PREFIX_LENGTH).toLowerCase();
}

export function parseOwnerStickerCommand(value) {
  const text = String(value ?? "").trim();
  if (/^(?:待确认贴纸|贴纸待确认)$/u.test(text)) {
    return { kind: "list-pending" };
  }

  const detail = text.match(/^贴纸详情\s+([a-f\d]{8,64})$/iu);
  if (detail) {
    return { kind: "detail", id: detail[1].toLowerCase() };
  }

  const ignore = text.match(/^忽略贴纸\s+([a-f\d]{8,64})$/iu);
  if (ignore) {
    return { kind: "ignore", id: ignore[1].toLowerCase() };
  }

  // The label is optional for confirm/correct/collect: a vision suggestion may
  // already be stored on the semantic row, and the owner can accept it as-is.
  const setLabel = text.match(
    /^(收录|确认|纠正)贴纸\s+([a-f\d]{8,64})(?:\s+(\S+))?(?:\s+([\s\S]*))?$/iu,
  );
  if (!setLabel) return null;

  const kind = { 收录: "collect", 确认: "confirm", 纠正: "correct" }[setLabel[1]];
  const label = normalizeStickerNote(setLabel[3] ?? "").replace(/[【】]/gu, "");
  return {
    kind,
    id: setLabel[2].toLowerCase(),
    label: label || null,
    note: normalizeStickerNote(setLabel[4] ?? ""),
  };
}

// Vision output is advisory only. Parse two labeled lines and treat anything
// unparseable as "no suggestion" instead of inventing a meaning.
export function parseStickerVisionSuggestion(raw) {
  let label = "";
  let note = "";

  for (const line of String(raw ?? "").split(/\r?\n/u)) {
    const match = line.match(/^\s*(标签|用途|用法)\s*[:：]\s*(.*)$/u);
    if (!match) continue;
    const value = normalizeStickerNote(match[2]).replace(/[【】]/gu, "");
    if (match[1] === "标签" && !label) label = value.slice(0, 24);
    else if (match[1] !== "标签" && !note) note = value;
  }

  if (!label && !note) {
    const single = normalizeStickerNote(raw).replace(/[【】]/gu, "");
    if (single && single.length <= 48) label = single.slice(0, 24);
  }
  if (/^(?:不确定|无法判断|看不清|未知|不知道)$/u.test(label)) label = "";

  return { label, note };
}
