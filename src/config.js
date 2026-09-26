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
// bot keeps a human chat rhythm instead of composing paragraphs. The gray
// group's human messages (small sample: two people) have a median length of
// 8 characters and a median turn of 10 characters, so this is a deliberately
// loose guardrail rather than a style rule. 40 leaves room for the extra
// sentence a setting/lore answer needs without letting casual chat drift.
export const MAX_REPLY_TOTAL_CHARS = 40;
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

// 长期记忆（BOT-017）：把超过压缩期的原文压成 digest 与画像；删除只发生在
// 超过保留期（且已被 digest 覆盖）的区间上。两个阈值分开：
// - 压缩期（MEMORY_COMPACT_AFTER_MS）：多久之后值得总结。太晚压缩会漏掉读窗口
//   之外的内容（读窗口只有 24 小时），所以默认 2 天；
// - 保留期（MEMORY_RETENTION_MS）：多久之后可以删原文。分档推进：先 30 天，
//   观察一周后收到 7 天。
// dry_run 期间照常写 digest 与画像，只不删除。
export const MEMORY_COMPACT_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
export const MEMORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MEMORY_DRY_RUN_DEFAULT = true;
// 单次模型调用的输入上限，超出的部分留到下一块（保证取到的是最早的连续区间）。
export const MEMORY_MAX_MESSAGES_PER_CHUNK = 400;
export const MEMORY_MAX_CHARS_PER_CHUNK = 40000;
// 每个会话每轮最多压缩几块，防止积压过多时一次 cron 跑飞。
export const MEMORY_MAX_CHUNKS_PER_CONVERSATION = 4;
export const MEMORY_MAX_CONVERSATIONS_PER_RUN = 20;
// 画像与单段 digest 的输出长度上限（字符），注入时同样受这两个值约束。
export const MEMORY_PROFILE_MAX_CHARS = 1200;
export const MEMORY_DIGEST_MAX_CHARS = 1200;
// 注入回复上下文时携带最近几段 digest，更早的细节由画像承担。
export const MEMORY_DIGESTS_INJECTED = 7;
export const MEMORY_TIMEOUT_MS = 20 * 1000;
export const MEMORY_MAX_TOKENS = 2000;
