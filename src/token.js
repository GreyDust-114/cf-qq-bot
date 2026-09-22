import {
  QQ_TOKEN_URL,
  TOKEN_SETTINGS_KEY,
  TOKEN_TIMEOUT_MS,
} from "./config.js";

export function createTokenManager(deps) {
  let cachedToken = null;
  let cachedExpiresAt = 0;
  let inflightRequest = null;

  async function loadStoredToken() {
    try {
      const row = await deps.env.DB.prepare(
        `SELECT value, expires_at
         FROM settings
         WHERE key = ?`,
      )
        .bind(TOKEN_SETTINGS_KEY)
        .first();

      if (!row?.value) {
        return null;
      }

      const expiresAt = Number(row.expires_at ?? 0);

      if (!expiresAt || deps.now() >= expiresAt - 5 * 60 * 1000) {
        return null;
      }

      return { token: String(row.value), expiresAt };
    } catch (error) {
      deps.logger.error("stage=token d1 read failed:", error);
      return null;
    }
  }

  async function saveStoredToken(token, expiresAt) {
    try {
      await deps.env.DB.prepare(
        `INSERT INTO settings (key, value, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key)
         DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at`,
      )
        .bind(TOKEN_SETTINGS_KEY, token, expiresAt)
        .run();
    } catch (error) {
      deps.logger.error("stage=token d1 write failed:", error);
    }
  }

  async function requestAccessToken(timeoutMs) {
    const response = await deps.fetch(QQ_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appId: deps.env.QQ_APP_ID,
        clientSecret: deps.env.QQ_APP_SECRET,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `QQ token failed: HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const data = JSON.parse(body);

    if (!data.access_token) {
      throw new Error(`QQ token missing: ${body.slice(0, 300)}`);
    }

    return {
      token: data.access_token,
      expiresAt: deps.now() + Number(data.expires_in ?? 7200) * 1000,
    };
  }

  async function fetchAccessToken(options = {}) {
    const timeoutMs = options.timeoutMs ?? TOKEN_TIMEOUT_MS;
    const maxAttempts = options.retry === false ? 1 : 2;

    if (
      cachedToken &&
      deps.now() < cachedExpiresAt - 5 * 60 * 1000
    ) {
      return cachedToken;
    }

    const stored = await loadStoredToken();

    if (stored) {
      cachedToken = stored.token;
      cachedExpiresAt = stored.expiresAt;
      deps.logger.log("stage=token loaded from d1");
      return cachedToken;
    }

    if (inflightRequest) {
      return inflightRequest;
    }

    inflightRequest = (async () => {
      const startedAt = deps.now();
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result = await requestAccessToken(timeoutMs);

          cachedToken = result.token;
          cachedExpiresAt = result.expiresAt;

          await saveStoredToken(result.token, result.expiresAt);

          deps.logger.log(
            `stage=token fetched in ${deps.now() - startedAt}ms ` +
              `(attempt ${attempt})`,
          );

          return cachedToken;
        } catch (error) {
          lastError = error;
          deps.logger.error(
            `stage=token attempt ${attempt} failed after ` +
              `${deps.now() - startedAt}ms:`,
            error,
          );
        }
      }

      throw lastError ?? new Error("QQ token unavailable");
    })();

    try {
      return await inflightRequest;
    } finally {
      inflightRequest = null;
    }
  }

  return { fetchAccessToken };
}
