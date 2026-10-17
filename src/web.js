// BOT-025-01: DeepSeek Fetch as a Worker-side tool.
//
// This is not model tool calling: the model never receives a `tools` parameter.
// Search/Fetch are plain REST endpoints, so this path does not need the
// reasoning_content replay that `tools` + thinking requires. The Worker fetches
// once, before the single reply call, and injects the result as untrusted
// reference material.

import {
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_TIMEOUT_MS,
  WEB_MAX_URLS_PER_TURN,
} from "./config.js";
import { formatNowForPrompt } from "./pure.js";
import { webContextPrompt } from "./prompts.js";

const DEFAULT_WEB_BASE_URL = "https://api.deepseek.com";
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。！？；：、（）【】「」『』“”‘’]+/giu;
// Chat messages commonly glue punctuation to a URL: "看这个 https://e.com/a，".
// Strip it before parsing so the request body only contains the URL.
const TRAILING_PUNCTUATION = /[)\]}>.,;:!?，。！？；：、"'”’]+$/u;

export function extractUrls(text, limit = WEB_MAX_URLS_PER_TURN) {
  const source = typeof text === "string" ? text : "";
  const urls = [];
  const seen = new Set();

  if (!source || limit <= 0) {
    return urls;
  }

  for (const match of source.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, "");

    if (!raw || raw.length > 8192) {
      continue;
    }

    let parsed;

    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      continue;
    }

    if (!parsed.hostname) {
      continue;
    }

    const normalized = parsed.toString();

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    urls.push(normalized);

    if (urls.length >= limit) {
      break;
    }
  }

  return urls;
}

function clipContent(text, maxChars = WEB_FETCH_MAX_CHARS) {
  const value = String(text ?? "").trim();

  if (value.length <= maxChars) {
    return value;
  }

  return (
    `${value.slice(0, maxChars)}\n` +
    `…（正文已截断，原始 ${value.length} 字符）`
  );
}

function webError(status, elapsedMs) {
  const error = new Error(`web fetch failed: ${status}`);
  error.status = status;
  error.elapsedMs = elapsedMs;
  return error;
}

export function createWebTools(deps) {
  const baseUrl = String(
    deps.env.LLM_BASE_URL ?? DEFAULT_WEB_BASE_URL,
  ).replace(/\/+$/, "");

  async function fetchPage(url, { timeoutMs = WEB_FETCH_TIMEOUT_MS } = {}) {
    const startedAt = deps.now();
    let response;

    try {
      response = await deps.fetch(`${baseUrl}/v1/tools/fetch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.env.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw webError(
        error?.name === "TimeoutError" ? "timeout" : "network",
        deps.now() - startedAt,
      );
    }

    let body;

    try {
      body = await response.text();
    } catch {
      throw webError("network", deps.now() - startedAt);
    }

    const elapsedMs = deps.now() - startedAt;

    if (!response.ok) {
      throw webError(response.status, elapsedMs);
    }

    let data;

    try {
      data = JSON.parse(body);
    } catch {
      throw webError("invalid-json", elapsedMs);
    }

    const content =
      typeof data?.content === "string" ? data.content.trim() : "";

    if (!content) {
      throw webError("empty", elapsedMs);
    }

    return {
      title:
        typeof data?.title === "string"
          ? data.title.trim().slice(0, 200)
          : "",
      content: clipContent(content),
      url,
      fetchedAt: deps.now(),
      elapsedMs,
    };
  }

  return { fetchPage };
}

export function formatWebContext(pages, { now } = {}) {
  const items = (Array.isArray(pages) ? pages : []).map((page) => ({
    ...page,
    fetchedAtText: formatNowForPrompt(page?.fetchedAt ?? now),
  }));

  return webContextPrompt(items);
}
