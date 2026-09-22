// 测试用脚本化 fetch：覆盖 QQ token、DeepSeek 和 QQ 发送三类请求。

export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export const QQ_SEND_PATTERN = /\/v2\/(groups|users)\//;

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createFakeFetch(handlers = {}) {
  const calls = [];

  const sendCalls = () =>
    calls.filter(
      (call) => call.method === "POST" && QQ_SEND_PATTERN.test(call.url),
    );

  const llmCalls = () =>
    calls.filter((call) => call.url.endsWith("/chat/completions"));

  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url);
    const call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      init,
    };

    calls.push(call);

    if (handlers.onRequest) {
      const custom = await handlers.onRequest(call, calls);

      if (custom) {
        return custom;
      }
    }

    if (url.startsWith(QQ_TOKEN_URL)) {
      return jsonResponse({
        access_token: "test-access-token",
        expires_in: 7200,
      });
    }

    if (url.endsWith("/chat/completions")) {
      const reply =
        typeof handlers.llmReply === "function"
          ? handlers.llmReply(call, llmCalls().length)
          : (handlers.llmReply ?? "好的");

      return jsonResponse({
        choices: [{ message: { content: reply } }],
      });
    }

    if (QQ_SEND_PATTERN.test(url)) {
      if (handlers.onQQSend) {
        return handlers.onQQSend(call, sendCalls().length);
      }

      return jsonResponse({ id: `mock-message-${sendCalls().length}` });
    }

    throw new Error(`unexpected fetch: ${url}`);
  };

  impl.calls = calls;
  impl.llmCalls = llmCalls;
  impl.sendCalls = sendCalls;

  return impl;
}

export function parseSendBody(call) {
  return JSON.parse(call.body);
}
