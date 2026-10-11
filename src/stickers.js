import { STICKER_MAX_BYTES } from "./config.js";

const DEFAULT_HASH_TIMEOUT_MS = 8_000;
const MAX_NOTE_CHARS = 160;
const FINGERPRINT_PREFIX_LENGTH = 8;
const encoder = new TextEncoder();

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

// Only fetch transiently to identify the image. Callers persist the SHA-256
// and, if review is needed, a short-lived source URL reference—not image bytes.
export async function fetchStickerFingerprint(
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

    return {
      ok: true,
      fingerprint: await fingerprintStickerBytes(bytes),
      mimeType,
      size: bytes.length,
    };
  } catch {
    return { ok: false, reason: "fetch-failed" };
  }
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

  const ignore = text.match(/^忽略贴纸\s+([a-f\d]{8,64})$/iu);
  if (ignore) {
    return { kind: "ignore", id: ignore[1].toLowerCase() };
  }

  const setLabel = text.match(
    /^(确认|纠正)贴纸\s+([a-f\d]{8,64})\s+(\S+)(?:\s+([\s\S]*))?$/iu,
  );
  if (!setLabel) return null;

  const label = normalizeStickerNote(setLabel[3]).replace(/[【】]/gu, "");
  if (!label) return null;
  return {
    kind: setLabel[1] === "确认" ? "confirm" : "correct",
    id: setLabel[2].toLowerCase(),
    label,
    note: normalizeStickerNote(setLabel[4] ?? ""),
  };
}
