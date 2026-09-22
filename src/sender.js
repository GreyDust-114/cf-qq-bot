import {
  MIN_STAGE_BUDGET_MS,
  PART_GAP_MAX_MS,
  QQ_API_BASE_URL,
  SEND_RETRY_TIMEOUT_MS,
  SEND_TIMEOUT_MS,
} from "./config.js";

import {
  isRetryableSendError,
  replyPartGapMs,
} from "./pure.js";

export function createReplySender(deps, tokenManager) {
  async function postQQMessage(
    incoming,
    content,
    accessToken,
    timeoutMs,
    msgSeq,
  ) {
    const targetType = incoming.scope === "group" ? "groups" : "users";

    const endpoint =
      `${QQ_API_BASE_URL}/v2/${targetType}/` +
      `${encodeURIComponent(incoming.targetId)}/messages`;

    const response = await deps.fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        msg_type: 0,
        msg_id: incoming.messageId,
        msg_seq: msgSeq,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await response.text();

    return { ok: response.ok, status: response.status, body };
  }

  async function sendQQMessage(
    incoming,
    content,
    deadline,
    msgSeq = 1,
    tokenPromise = null,
  ) {
    const startedAt = deps.now();
    const remaining = () => Math.max(0, deadline - deps.now());

    let accessToken = null;

    try {
      accessToken = tokenPromise ? await tokenPromise : null;

      if (!accessToken) {
        accessToken = await tokenManager.fetchAccessToken();
      }
    } catch (error) {
      deps.logger.error("stage=token unavailable for send:", error);
      return { ok: false, reason: "token" };
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const baseTimeout =
        attempt === 1 ? SEND_TIMEOUT_MS : SEND_RETRY_TIMEOUT_MS;
      const timeout = Math.min(baseTimeout, remaining());

      if (timeout < MIN_STAGE_BUDGET_MS) {
        deps.logger.error(
          `stage=send skipped: budget exhausted (attempt ${attempt})`,
        );
        return { ok: false, reason: "budget" };
      }

      try {
        const result = await postQQMessage(
          incoming,
          content,
          accessToken,
          timeout,
          msgSeq,
        );

        if (result.ok) {
          deps.logger.log(
            `stage=send ok in ${deps.now() - startedAt}ms ` +
              `(msg_seq ${msgSeq}, attempt ${attempt})`,
          );
          return { ok: true };
        }

        deps.logger.error(
          `stage=send http ${result.status} (msg_seq ${msgSeq}, ` +
            `attempt ${attempt}): ` +
            result.body.slice(0, 300),
        );

        return { ok: false, reason: "http", status: result.status };
      } catch (error) {
        deps.logger.error(
          `stage=send attempt ${attempt} failed after ` +
            `${deps.now() - startedAt}ms:`,
          error,
        );

        if (!isRetryableSendError(error)) {
          return { ok: false, reason: "network" };
        }
      }
    }

    deps.logger.error(
      "stage=send failed after retry; outcome uncertain " +
        `(${deps.now() - startedAt}ms)`,
    );

    return { ok: false, reason: "timeout" };
  }

  async function sendReplyParts(
    incoming,
    messages,
    deadline,
    tokenPromise = null,
    shouldContinue = null,
  ) {
    const parts = (Array.isArray(messages) ? messages : [])
      .map((part) => String(part ?? "").trim())
      .filter(Boolean);

    if (parts.length === 0) {
      return { sentTexts: [], reason: "empty" };
    }

    const sentTexts = [];
    let stopped = null;

    for (let index = 0; index < parts.length; index += 1) {
      if (shouldContinue) {
        const gate = await shouldContinue();

        if (!gate?.current) {
          stopped = "superseded";
          deps.logger.log(
            "Reply parts: newer messages arrived, stopping",
            { reason: gate?.reason ?? "unknown" },
          );
          break;
        }
      }

      if (index > 0) {
        const remaining = deadline - deps.now();

        if (remaining < MIN_STAGE_BUDGET_MS + PART_GAP_MAX_MS) {
          deps.logger.log(
            "Reply parts: budget low, skipping remaining parts",
          );
          break;
        }

        await deps.sleep(
          replyPartGapMs(parts[index - 1], deps.random),
        );
      }

      const result = await sendQQMessage(
        incoming,
        parts[index],
        deadline,
        index + 1,
        tokenPromise,
      );

      if (!result.ok) {
        deps.logger.error(
          `Reply part ${index + 1} failed:`,
          result.reason,
        );
        break;
      }

      sentTexts.push(parts[index]);
    }

    return {
      sentTexts,
      reason: stopped ?? (sentTexts.length > 0 ? null : "send-failed"),
    };
  }

  return { sendReplyParts };
}
