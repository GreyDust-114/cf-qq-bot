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
};
