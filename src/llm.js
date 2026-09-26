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

    // 思考默认开启（聊天路径依赖它）；记忆整理这类抽取任务传
    // { thinking: false } 关掉：思考 token 与正文共享 max_tokens，
    // 复杂输入会把预算吃满并返回空正文（2026-09-25 首次 cron 实例）。
    const thinking = options.thinking !== false;

    const body = {
      model: deps.env.LLM_MODEL,
      messages,
      ...(thinking
        ? { thinking: { type: "enabled" }, reasoning_effort: "low" }
        : { thinking: { type: "disabled" } }),
      // NOTE: response_format: json_object was tried and reverted. With
      // thinking enabled the API returned JSON shapes that parsed to empty
      // messages (mention replies fell back to the safe reply, autonomous
      // batches turned silent). The structured protocol is requested by the
      // prompts only; the parser accepts plain text as a fallback.
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
    const usage = data.usage ?? {};
    const finishReason = data.choices?.[0]?.finish_reason ?? "unknown";
    const reply = data.choices?.[0]?.message?.content;

    // 每次调用记一行用量（含缓存命中/未命中拆分），空正文也要先记一行，
    // 这样失败调用同样能对账，并留下 finish_reason 供排错。
    deps.logger.log(
      `stage=usage request=${options.label ?? "unknown"} ` +
        `prompt=${usage.prompt_tokens ?? "?"} ` +
        `hit=${usage.prompt_cache_hit_tokens ?? "?"} ` +
        `miss=${usage.prompt_cache_miss_tokens ?? "?"} ` +
        `out=${usage.completion_tokens ?? "?"} ` +
        `thinking=${
          usage.completion_tokens_details?.reasoning_tokens ?? "?"
        } ` +
        `images=${options.imageCount ?? 0} ` +
        `finish=${finishReason} ` +
        `ms=${elapsedMs}`,
    );

    if (!reply) {
      throw new Error(
        `DeepSeek returned an empty response (${elapsedMs}ms, ` +
          `finish=${finishReason}, out=${usage.completion_tokens ?? "?"}, ` +
          `thinking=${
            usage.completion_tokens_details?.reasoning_tokens ?? "?"
          })`,
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
        imageCount: includeImages ? (options.imageCount ?? 0) : 0,
        label: includeImages
          ? (options.label ?? "unknown")
          : `${options.label ?? "unknown"}+no-images`,
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
