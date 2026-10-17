import { STICKER_MAX_BYTES, STICKER_MEDIA_URL_TTL_SECONDS } from "./config.js";
import { STICKER_ASSET_MIME_TYPES } from "./stickers.js";

const encoder = new TextEncoder();
const MEDIA_URL_TTL_SECONDS = STICKER_MEDIA_URL_TTL_SECONDS;
const MEDIA_URL_MAX_FUTURE_SECONDS = 300;

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function importSigningKey(secret) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("QQ_APP_SECRET is unavailable or too short");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(secret, payload) {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return toBase64Url(new Uint8Array(signature));
}

export async function createStickerMediaUrl({
  name,
  baseUrl,
  secret,
  now = Date.now(),
}) {
  if (!name || !baseUrl) throw new Error("sticker media URL is not configured");
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) {
    throw new Error("invalid sticker media name");
  }
  const parsedBase = new URL(String(baseUrl));
  if (
    parsedBase.protocol !== "https:" ||
    parsedBase.username ||
    parsedBase.password ||
    parsedBase.pathname !== "/" ||
    parsedBase.search ||
    parsedBase.hash
  ) {
    throw new Error("sticker media base URL must be public HTTPS");
  }
  const origin = parsedBase.origin;
  const expires = Math.floor(now / 1000) + MEDIA_URL_TTL_SECONDS;
  const signature = await sign(secret, `${origin}\n${name}\n${expires}`);
  return `${origin}/media/stickers/${encodeURIComponent(name)}?expires=${expires}&sig=${signature}`;
}

export async function verifyStickerMediaUrl({
  name,
  origin,
  expires,
  signature,
  secret,
  now = Date.now(),
}) {
  const expiry = Number(expires);
  const nowSeconds = Math.floor(now / 1000);
  if (
    !Number.isInteger(expiry) ||
    expiry < nowSeconds ||
    expiry > nowSeconds + MEDIA_URL_MAX_FUTURE_SECONDS ||
    !/^[A-Za-z0-9_-]{40,50}$/.test(signature ?? "")
  ) {
    return false;
  }
  try {
    const key = await importSigningKey(secret);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signature),
      encoder.encode(`${origin}\n${name}\n${expiry}`),
    );
  } catch {
    return false;
  }
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Public, read-only, short-lived capability URL used only by QQ's media
// uploader to pull a curated D1 asset. Invalid signatures and absent assets
// intentionally share the same response to avoid revealing the sticker index.
export async function serveStickerMedia(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/media\/stickers\/([^/]+)$/);
  if (!match || request.method !== "GET") {
    return new Response("Not Found", { status: 404 });
  }

  let name;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  const valid = await verifyStickerMediaUrl({
    name,
    origin: url.origin,
    expires: url.searchParams.get("expires"),
    signature: url.searchParams.get("sig"),
    secret: env.QQ_APP_SECRET,
    now,
  });
  if (!valid || !env.DB) return new Response("Not Found", { status: 404 });

  try {
    const row = await env.DB.prepare(
      `SELECT mime_type, data_base64
       FROM sticker_assets
       WHERE name = ? AND enabled = 1`,
    ).bind(name).first();
    if (!row || !STICKER_ASSET_MIME_TYPES.includes(row.mime_type)) {
      return new Response("Not Found", { status: 404 });
    }

    const bytes = decodeBase64(row.data_base64);
    if (bytes.length === 0 || bytes.length > STICKER_MAX_BYTES) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": row.mime_type,
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}
