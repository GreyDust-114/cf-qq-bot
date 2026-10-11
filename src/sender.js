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
    fileInfo = null,
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
        msg_type: fileInfo ? 7 : 0,
        ...(fileInfo ? { media: { file_info: fileInfo } } : {}),
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
    options = {},
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
          options.fileInfo ?? null,
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
            `attempt ${attempt})` +
            (options.fileInfo ? "" : `: ${result.body.slice(0, 300)}`),
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

  async function uploadImage(incoming, url, deadline, tokenPromise = null) {
    const startedAt = deps.now();
    const remaining = () => Math.max(0, deadline - deps.now());
    try {
      const mediaUrl = new URL(url);
      if (
        mediaUrl.protocol !== "https:" ||
        mediaUrl.username ||
        mediaUrl.password
      ) {
        return {
          ok: false,
          reason: "invalid-media-url",
          attempts: 0,
          elapsedMs: 0,
        };
      }
    } catch {
      return {
        ok: false,
        reason: "invalid-media-url",
        attempts: 0,
        elapsedMs: 0,
      };
    }
    let accessToken;

    try {
      accessToken = tokenPromise ? await tokenPromise : null;
      if (!accessToken) accessToken = await tokenManager.fetchAccessToken();
    } catch (error) {
      deps.logger.error("stage=sticker token unavailable for upload:", error);
      return {
        ok: false,
        reason: "token",
        attempts: 0,
        elapsedMs: deps.now() - startedAt,
      };
    }

    const timeout = Math.min(SEND_TIMEOUT_MS, remaining());
    if (timeout < MIN_STAGE_BUDGET_MS) {
      return {
        ok: false,
        reason: "budget",
        attempts: 0,
        elapsedMs: deps.now() - startedAt,
      };
    }

    const targetType = incoming.scope === "group" ? "groups" : "users";
    const endpoint =
      `${QQ_API_BASE_URL}/v2/${targetType}/` +
      `${encodeURIComponent(incoming.targetId)}/files`;

    try {
      const response = await deps.fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_type: 1, url, srv_send_msg: false }),
        signal: AbortSignal.timeout(timeout),
      });
      const body = await response.text();
      let data = null;
      try {
        data = JSON.parse(body);
      } catch {}

      if (
        !response.ok ||
        typeof data?.file_info !== "string" ||
        !data.file_info
      ) {
        deps.logger.error(`stage=sticker upload failed status=${response.status}`);
        return {
          ok: false,
          reason: response.ok ? "invalid-file-info" : "upload-http",
          status: response.status,
          attempts: 1,
          elapsedMs: deps.now() - startedAt,
        };
      }

      return {
        ok: true,
        fileInfo: data.file_info,
        ttl: Number(data.ttl ?? 0),
        attempts: 1,
        elapsedMs: deps.now() - startedAt,
      };
    } catch (error) {
      deps.logger.error("stage=sticker upload failed:", error);
      return {
        ok: false,
        reason: "upload-network",
        uncertain: false,
        attempts: 1,
        elapsedMs: deps.now() - startedAt,
      };
    }
  }

  function sendMediaMessage(
    incoming,
    fileInfo,
    deadline,
    msgSeq = 1,
    tokenPromise = null,
  ) {
    if (typeof fileInfo !== "string" || !fileInfo) {
      return Promise.resolve({
        ok: false,
        reason: "invalid-file-info",
        attempts: 0,
      });
    }
    return sendMessage(
      incoming,
      " ",
      deadline,
      msgSeq,
      tokenPromise,
      { fileInfo },
    );
  }

  return { sendMessage, uploadImage, sendMediaMessage };
}
