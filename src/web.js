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
  WEB_SEARCH_COUNT,
  WEB_SEARCH_MAX_QUERY_CHARS,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_SUMMARY_MAX_CHARS,
  WEB_SEARCH_TIMEOUT_MS,
} from "./config.js";
import { formatNowForPrompt } from "./pure.js";
import { searchContextPrompt, webContextPrompt } from "./prompts.js";

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

// BOT-025-02: path A uses local, testable rules instead of a model tool call.
// Only explicit search verbs, time-sensitive topics, or news questions trigger;
// URLs are handled by Fetch and take precedence.
const SEARCH_VERB_PATTERN =
  /(?:搜一下|搜一搜|搜搜|搜索|查一下|查一查|查查|查询|上网查|网上查)/u;
const SELF_SEARCH_PATTERN =
  /(?:^|[，。！？；：、,.!?;:\s])我(?:正在|在|去|来|刚)?(?:搜|查)/u;
const TIME_MARKER_PATTERN =
  /(?:今天|今晚|现在|目前|最近|最新|这两天|这周|本周|今年|刚才|刚刚)/u;
const TOPIC_PATTERN =
  /(?:新闻|热搜|股价|股票|比分|汇率|价格|报价|天气|气温|发布会|进展|消息)/u;
const TERSE_TOPIC_PATTERN =
  /(?:新闻|热搜|股价|股票|比分|汇率|价格|报价|天气|气温|发布会|消息|进展|更新)$/u;
const NEGATION_PATTERN =
  /(?:没|没有|无)(?:什么)?(?:新闻|热搜|消息|进展|更新)/u;
const NEWS_PATTERN = /(?:新闻|热搜)/u;
const TERM_PATTERN =
  /(?:是什么意思|是啥意思|什么意思|是什么梗|什么梗|是什么来头|什么来头|怎么读|怎么念)/u;
const TERM_SUBJECT_PATTERN = /^[\p{L}\p{N}_\-+.# ]{1,20}$/u;
const PRONOUN_SUBJECT_PATTERN =
  /^(?:这|那|它|你|我|他|她|我们|你们|他们|她们|这个|那个|这段|那段|这些|那些|这里|那里)/u;
const QUESTION_PATTERN =
  /(?:吗|呢|怎么|如何|多少|有没有|是什么|什么|？|\?)/u;

function normalizeIntentText(text) {
  return String(text ?? "")
    .replace(/<@!?[^>]+>/gu, " ")
    .replace(
      /(^|[\s，。！？；：、,.!?;:])@[^\s，。！？；：、,.!?;:]+/gu,
      "$1",
    )
    .replace(/【[^】]*】/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function termSubject(source) {
  const match = source.match(
    /^(.*?)(?:是什么意思|是啥意思|什么意思|是什么梗|什么梗|是什么来头|什么来头|怎么读|怎么念)/u,
  );

  if (!match) {
    return "";
  }

  return match[1]
    .replace(/[「」『』“”"']/gu, "")
    .replace(/^[\s，。！？；：、,.!?;:]+/u, "")
    .trim();
}

function buildSearchQuery(source) {
  return source
    .replace(
      /(^|[，。！？；：、,.!?;:\s])(?:帮我|给我|你|能不能|可不可以|麻烦)\s*/gu,
      "$1",
    )
    .replace(
      /(?:搜一下|搜一搜|搜搜|搜索一下|搜索下|搜索|查一下|查一查|查查|查询一下|查询下|查询|上网查|网上查)/gu,
      " ",
    )
    .replace(
      /(?:是什么意思|是啥意思|什么意思|是什么梗|什么梗|是什么来头|什么来头|怎么读|怎么念)/gu,
      "",
    )
    .replace(/(?:怎么样|如何|怎么看|有什么|有哪些|是多少)/gu, "")
    .replace(/[你我]$/u, "")
    .replace(/[吗呢]$/u, "")
    .replace(/^[\s，。！？；：、,.!?;:]+/u, "")
    .replace(/[\s，。！？；：、,.!?;:]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, WEB_SEARCH_MAX_QUERY_CHARS);
}

export function detectSearchIntent(text) {
  const source = normalizeIntentText(text);

  if (!source || extractUrls(source).length > 0) {
    return null;
  }

  if (SELF_SEARCH_PATTERN.test(source)) {
    return null;
  }

  const question = QUESTION_PATTERN.test(source);
  const negated = NEGATION_PATTERN.test(source) && !question;
  const explicit = SEARCH_VERB_PATTERN.test(source);
  const timely =
    !negated &&
    TIME_MARKER_PATTERN.test(source) &&
    TOPIC_PATTERN.test(source) &&
    (question || TERSE_TOPIC_PATTERN.test(source));
  const news =
    !negated &&
    NEWS_PATTERN.test(source) &&
    (question || source.length <= 12);
  const term = TERM_PATTERN.test(source) ? termSubject(source) : "";
  const termTrigger =
    term.length > 0 &&
    TERM_SUBJECT_PATTERN.test(term) &&
    !PRONOUN_SUBJECT_PATTERN.test(term);

  if (!explicit && !timely && !news && !termTrigger) {
    return null;
  }

  const query = buildSearchQuery(source);

  if (query.length < 2) {
    return null;
  }

  return {
    query,
    trigger: explicit
      ? "explicit"
      : termTrigger
        ? "term"
        : timely
          ? "time-sensitive"
          : "news",
  };
}

function clipText(text, maxChars, label = "正文") {
  const value = String(text ?? "").trim();

  if (value.length <= maxChars) {
    return value;
  }

  return (
    `${value.slice(0, maxChars)}\n` +
    `…（${label}已截断，原始 ${value.length} 字符）`
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
      content: clipText(content, WEB_FETCH_MAX_CHARS, "正文"),
      url,
      fetchedAt: deps.now(),
      elapsedMs,
    };
  }

  async function search(query, { timeoutMs = WEB_SEARCH_TIMEOUT_MS } = {}) {
    const normalizedQuery = String(query ?? "")
      .trim()
      .slice(0, WEB_SEARCH_MAX_QUERY_CHARS);

    if (!normalizedQuery) {
      throw webError("invalid-query", 0);
    }

    const startedAt = deps.now();
    let response;

    try {
      response = await deps.fetch(`${baseUrl}/v1/tools/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.env.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: normalizedQuery,
          count: WEB_SEARCH_COUNT,
          need_content: false,
        }),
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

    const results = (Array.isArray(data?.results) ? data.results : [])
      .filter(
        (result) => result && typeof result.url === "string" && result.url,
      )
      .slice(0, WEB_SEARCH_MAX_RESULTS)
      .map((result) => ({
        title:
          typeof result.title === "string"
            ? result.title.trim().slice(0, 200)
            : "",
        url: result.url,
        summary: clipText(
          result.summary || result.snippet || "",
          WEB_SEARCH_SUMMARY_MAX_CHARS,
          "摘要",
        ),
        date: typeof result.date === "string" ? result.date : null,
      }))
      .filter((result) => result.summary);

    return { results, elapsedMs };
  }

  return { fetchPage, search };
}

export function formatWebContext(pages, { now } = {}) {
  const items = (Array.isArray(pages) ? pages : []).map((page) => ({
    ...page,
    fetchedAtText: formatNowForPrompt(page?.fetchedAt ?? now),
  }));

  return webContextPrompt(items);
}

function formatSearchDate(date) {
  const value = String(date ?? "").trim();

  if (!value) {
    return "未知";
  }

  return value.slice(0, 10);
}

export function formatSearchContext(results, { now } = {}) {
  const items = (Array.isArray(results) ? results : []).map((result) => ({
    ...result,
    searchedAtText: formatNowForPrompt(now),
    publishedText: formatSearchDate(result?.date),
  }));

  return searchContextPrompt(items);
}
