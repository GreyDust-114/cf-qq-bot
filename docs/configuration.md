# 环境变量与可调参数

## Cloudflare 绑定

绑定在本地 `wrangler.toml` 中声明；公开仓库仅提供 `wrangler.toml.example` 模板（含占位符），不包含真实环境标识。

| 名称 | 类型 | 说明 |
|---|---|---|
| `CONVERSATION_HUB` | Durable Object namespace | 按 conversationId 寻址的会话协调器 |
| `DB` | D1 | 对话、设置与 outbox |

## 环境变量与 secrets

| 名称 | 类型 | 说明 |
|---|---|---|
| `QQ_APP_ID` | 变量 | QQ 机器人 AppID |
| `QQ_APP_SECRET` | Secret | webhook 验签与 access token |
| `LLM_API_KEY` | Secret | DeepSeek API Key |
| `LLM_BASE_URL` | 变量 | 默认 `https://api.deepseek.com` |
| `LLM_MODEL` | 变量 | 默认 `deepseek-flash` |
| `ALLOWED_GROUP_OPENID` | 变量 | 灰度群；留空表示不限制 |
| `MEMORY_DRY_RUN` | 变量 | 长期记忆：`"true"` 只报告不删原文，`"false"` 才实际删除 |
| `MEMORY_RETENTION_DAYS` | 变量 | 长期记忆：原文保留天数（超过的部分先进摘要、再删除） |

## 核心参数

参数集中在 `src/config.js`。

| 参数 | 当前值 | 作用 |
|---|---:|---|
| `CONTEXT_WINDOW_MS` | 24 小时 | 上下文时间窗口 |
| `CONTEXT_MAX_MESSAGES` | 100 | 上下文消息条数上限 |
| `CONTEXT_MAX_CHARS` | 60000 | 上下文字符上限 |
| `MAX_REPLY_PARTS` | 4 | 解析层气泡硬上限（提示词通常 1 条、最多 3 条） |
| `BUBBLE_TARGET_MAX_CHARS` | 12 | 单条气泡目标长度 |
| `MAX_REPLY_TOTAL_CHARS` | 40 | 单次回复硬字数预算（提示词软引导 20 字、被问设定时 30 字） |
| `PART_GAP_MIN_MS / MAX` | 300 / 1500 | 气泡发送间隔上下限 |
| `PART_GAP_PER_CHAR_MS` | 30 | 依据上一条长度增加间隔 |
| `DEBOUNCE_MENTION_MIN_MS / MAX` | 3000 / 5000 | @ / 私聊静默窗口 |
| `DEBOUNCE_GROUP_MIN_MS / MAX` | 6000 / 9000 | 普通群消息静默窗口 |
| `ACTIVE_WINDOW_MS` | 90000 | 回复后的群聊活跃期 |
| `AUTONOMOUS_COOLDOWN_MIN_MS / MAX` | 15000 / 45000 | 新话题主动插话冷却 |
| `PROCESSING_STALE_MS` | 45000 | 失效批次接管阈值 |
| `PROCESSING_RETRY_DELAY_MS` | 5000 | 批次失败重试间隔 |
| `MAX_PROCESSING_ATTEMPTS` | 3 | 批次最大处理次数 |
| `INVOCATION_BUDGET_MS` | 28000 | 单次批次内部时间预算 |
| `LLM_TIMEOUT_MS` | 12000 | 模型调用上限 |
| `SEND_TIMEOUT_MS` | 8000 | QQ 单次发送上限 |
| `MAX_IMAGES_PER_MESSAGE` | 4 | 当前消息图片上限 |
| `MEMORY_RETENTION_MS` | 30 天 | 长期记忆：原文保留期（`MEMORY_RETENTION_DAYS` 可覆盖） |
| `MEMORY_DRY_RUN_DEFAULT` | true | 长期记忆：默认不删除，只报告 |
| `MEMORY_MAX_MESSAGES_PER_CHUNK` | 400 | 单次摘要输入的消息条数上限 |
| `MEMORY_MAX_CHARS_PER_CHUNK` | 40000 | 单次摘要输入的字符上限 |
| `MEMORY_MAX_CHUNKS_PER_CONVERSATION` | 4 | 每个会话每轮最多压缩几块 |
| `MEMORY_MAX_CONVERSATIONS_PER_RUN` | 20 | 每轮最多处理几个会话 |
| `MEMORY_PROFILE_MAX_CHARS` | 1200 | 长期画像长度上限 |
| `MEMORY_DIGEST_MAX_CHARS` | 1200 | 单段 digest 长度上限 |
| `MEMORY_DIGESTS_INJECTED` | 7 | 注入回复上下文时携带的最近 digest 段数 |
| `MEMORY_TIMEOUT_MS` | 20000 | 单次摘要模型调用上限 |

长度参数来自小规模灰度样本，只用于结构护栏，不用于硬性规定句号、`~` 或其他语言风格。

## 提示词说明

`src/prompts.js` 是提示词的唯一编辑入口，包含当前完整的实验 / 测试提示词：

- 人设与口语风格
- 群聊自主参与规则
- @、续聊、私聊场景差异
- `messages` / `silent` 输出协议
- 长度和气泡数量软约束
- 时间上下文、摘要标题、@ / 续聊系统提示碎片
- 模型不可用时的兜底话术

文案按纯文本排版（模板字符串），要优化或更换提示词时只改这一个文件；`src/pure.js` 与 `src/processor.js` 只引用，不内联文案。改动后按 `test/prompt-file.test.js` 的接缝测试与全量测试验证，再部署。

提示词不是框架接口，生产版本可能继续调整，并不保证后续完整同步到公开仓库。
