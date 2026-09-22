import {
  FALLBACK_RETRY_TIMEOUT_MS,
  LLM_TIMEOUT_MS,
  MIN_STAGE_BUDGET_MS,
  SEND_BUDGET_RESERVE_MS,
} from "./config.js";

const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";

export function createLlmClient(deps) {
  async function callDeepSeek(messages, options = {}) {
    const baseUrl = String(
      deps.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    ).replace(/\/+$/, "");

    const body = {
      model: deps.env.LLM_MODEL,
      messages,
      thinking: { type: "enabled" },
      reasoning_effort: "low",
      // Every generation path expects the structured reply/silent JSON
      // protocol, so enforce JSON output instead of relying on the prompt.
      response_format: { type: "json_object" },
      max_tokens: options.maxTokens ?? 2000,
      stream: false,
    };

    const startedAt = deps.now();

    const response = await deps.fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.env.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? LLM_TIMEOUT_MS),
    });

    const responseBody = await response.text();
    const elapsedMs = deps.now() - startedAt;

    if (!response.ok) {
      throw new Error(
        `DeepSeek failed: HTTP ${response.status} ` +
          `(${elapsedMs}ms): ${responseBody.slice(0, 500)}`,
      );
    }

    const data = JSON.parse(responseBody);
    const reply = data.choices?.[0]?.message?.content;

    if (!reply) {
      throw new Error(
        `DeepSeek returned an empty response (${elapsedMs}ms)`,
      );
    }

    deps.logger.log(`stage=llm ok in ${elapsedMs}ms`);
    return reply;
  }

  async function callDeepSeekWithFallback(
    buildMessages,
    options,
    hasImages,
    deadline,
  ) {
    const remaining = () => Math.max(0, deadline - deps.now());

    const run = async (includeImages, timeoutMs) => {
      const budget = remaining() - SEND_BUDGET_RESERVE_MS;
      const timeout = Math.min(timeoutMs, budget);

      if (timeout < MIN_STAGE_BUDGET_MS) {
        throw new Error("LLM time budget exhausted");
      }

      return callDeepSeek(buildMessages(includeImages), {
        ...options,
        timeoutMs: timeout,
      });
    };

    if (!hasImages) {
      return run(true, options.timeoutMs ?? LLM_TIMEOUT_MS);
    }

    try {
      return await run(true, options.timeoutMs ?? LLM_TIMEOUT_MS);
    } catch (error) {
      deps.logger.error(
        "stage=llm vision failed, retrying without images:",
        error,
      );
      return run(false, FALLBACK_RETRY_TIMEOUT_MS);
    }
  }

  return { callDeepSeek, callDeepSeekWithFallback };
}
