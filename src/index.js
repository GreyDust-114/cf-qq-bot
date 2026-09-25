import { createRuntime } from "./runtime.js";

export { ConversationHub } from "./conversation-hub.js";

// The runtime is cached per isolate so the in-memory QQ access token cache
// survives between requests. Tests construct their own runtime directly.
let cachedRuntime = null;

function getRuntime(env) {
  if (!cachedRuntime) {
    cachedRuntime = createRuntime(env);
  }

  return cachedRuntime;
}

export default {
  async fetch(request, env, ctx) {
    return getRuntime(env).handleRequest(request, ctx);
  },

  // Cron trigger：长期记忆整理（见 wrangler.toml 的 [triggers]）。
  // 用 waitUntil 把批次交给运行时，避免请求返回后执行被中断。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      getRuntime(env)
        .handleScheduled(event)
        .catch((error) => {
          console.error("stage=memory scheduled failed:", error);
        }),
    );
  },
};
