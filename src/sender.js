// QQ send primitives.
//
// This module only knows how to deliver one bubble: token, timeouts, one
// retry for retryable network errors, and an honest uncertainty flag when the
// outcome cannot be known. Bubble ordering, pacing, outbox bookkeeping and the
// revision gate live in the processor, which owns the batch.

import {
  MIN_STAGE_BUDGET_MS,
  QQ_API_BASE_URL,
  SEND_RETRY_TIMEOUT_MS,
  SEND_TIMEOUT_MS,
} from "./config.js";

import { isRetryableSendError } from "./pure.js";

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

  function parseQQMessageId(body) {
    try {
      const data = JSON.parse(body);

      return typeof data?.id === "string" ? data.id : null;
    } catch {
      return null;
    }
  }

  async function sendMessage(
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
      return { ok: false, reason: "token", uncertain: false, attempts: 0 };
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const baseTimeout =
        attempt === 1 ? SEND_TIMEOUT_MS : SEND_RETRY_TIMEOUT_MS;
      const timeout = Math.min(baseTimeout, remaining());

      if (timeout < MIN_STAGE_BUDGET_MS) {
        deps.logger.error(
          `stage=send skipped: budget exhausted (attempt ${attempt})`,
        );
        return {
          ok: false,
          reason: "budget",
          uncertain: false,
          attempts: attempt - 1,
        };
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
          return {
            ok: true,
            attempts: attempt,
            qqMessageId: parseQQMessageId(result.body),
          };
        }

        deps.logger.error(
          `stage=send http ${result.status} (msg_seq ${msgSeq}, ` +
            `attempt ${attempt}): ` +
            result.body.slice(0, 300),
        );

        return {
          ok: false,
          reason: "http",
          status: result.status,
          uncertain: false,
          attempts: attempt,
        };
      } catch (error) {
        deps.logger.error(
          `stage=send attempt ${attempt} failed after ` +
            `${deps.now() - startedAt}ms:`,
          error,
        );

        if (!isRetryableSendError(error)) {
          return {
            ok: false,
            reason: "network",
            uncertain: false,
            attempts: attempt,
          };
        }
      }
    }

    deps.logger.error(
      "stage=send failed after retry; outcome uncertain " +
        `(${deps.now() - startedAt}ms)`,
    );

    return { ok: false, reason: "timeout", uncertain: true, attempts: 2 };
  }

  return { sendMessage };
}
