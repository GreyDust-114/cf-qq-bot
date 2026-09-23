// Central place for tunables and fixed endpoints.
// Values intentionally match the original single-file Worker behavior.

export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export const QQ_API_BASE_URL = "https://api.sgroup.qq.com";

export const CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CONTEXT_MAX_MESSAGES = 100;
export const CONTEXT_MAX_CHARS = 60000;
export const STORED_CONTENT_MAX_CHARS = 2000;
export const MAX_REPLY_CHARS = 1800;

export const MAX_REPLY_PARTS = 4;
// Target maximum characters per bubble. Longer model output is split at
// punctuation so replies read like chat instead of paragraphs.
export const BUBBLE_TARGET_MAX_CHARS = 12;
// Hard budget for one reply. Content beyond it is dropped/truncated so the
// bot keeps a human chat rhythm instead of composing paragraphs. Human
// messages in the gray group have a median length of 8 characters and a
// median turn of 10 characters.
export const MAX_REPLY_TOTAL_CHARS = 30;
export const PART_GAP_MIN_MS = 300;
export const PART_GAP_MAX_MS = 1500;
export const PART_GAP_PER_CHAR_MS = 30;

export const DEBOUNCE_MENTION_MIN_MS = 3 * 1000;
export const DEBOUNCE_MENTION_MAX_MS = 5 * 1000;
export const DEBOUNCE_GROUP_MIN_MS = 6 * 1000;
export const DEBOUNCE_GROUP_MAX_MS = 9 * 1000;

export const AUTONOMOUS_COOLDOWN_MIN_MS = 15 * 1000;
export const AUTONOMOUS_COOLDOWN_MAX_MS = 45 * 1000;

// 群聊里机器人刚接完话的活跃期：原发言者的续句直接走回复路径，不再经过插话冷却判断。
export const ACTIVE_WINDOW_MS = 90 * 1000;

export const INVOCATION_BUDGET_MS = 28 * 1000;
export const MIN_STAGE_BUDGET_MS = 2000;
export const SEND_BUDGET_RESERVE_MS = 8000;

// Conversation coordinator (Durable Object) tunables.
// A processing batch older than PROCESSING_STALE_MS is considered abandoned
// (instance evicted / crashed) and is taken over by the next alarm.
export const PROCESSING_STALE_MS = 45 * 1000;
export const PROCESSING_RETRY_DELAY_MS = 5 * 1000;
export const MAX_PROCESSING_ATTEMPTS = 3;

export const LLM_TIMEOUT_MS = 12 * 1000;
export const FALLBACK_RETRY_TIMEOUT_MS = 8 * 1000;
export const TOKEN_TIMEOUT_MS = 5 * 1000;
export const SEND_TIMEOUT_MS = 8 * 1000;
export const SEND_RETRY_TIMEOUT_MS = 4 * 1000;

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_URL_LENGTH = 8192;
export const MAX_FACE_EXT_BYTES = 64 * 1024;

export const TOKEN_SETTINGS_KEY = "qq_access_token";
