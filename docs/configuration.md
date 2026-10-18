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
| `WEB_TOOLS_ENABLED` | 变量 | BOT-025：`"false"` 关闭显式 URL 抓取与显式搜索；默认开启 |
| `ALLOWED_GROUP_OPENID` | 变量 | 灰度群；留空表示不限制 |
| `MEMORY_DRY_RUN` | 变量 | 长期记忆：`"true"` 只报告不删原文，`"false"` 才实际删除 |
| `MEMORY_RETENTION_DAYS` | 变量 | 长期记忆：原文保留天数（超过的部分先进摘要、再删除） |
| `MEMORY_COMPACT_AFTER_DAYS` | 变量 | 长期记忆：超过多少天的消息开始压缩（默认 `2`，与保留期无关） |
| `STICKER_MEDIA_BASE_URL` | 变量 | BOT-021：QQ 服务端可访问的 HTTPS Worker origin，用于短时签名 D1 贴纸图片 URL；未配置时贴纸发送安全失败 |
| `STICKER_COOLDOWN_MS` | 变量 | BOT-021：同一会话任意贴纸之间的最小间隔，毫秒，默认 `1800000`（30 分钟），最大按 24 小时截断；同一张连续使用始终禁止 |
| `STICKER_OWNER_OPENID` | 变量 | BOT-020：owner 的 QQ C2C openid，用于识别私聊送图、“待确认贴纸”以及“收录/确认/纠正/详情/忽略贴纸”命令；同时用于 BOT-025-03 私聊里的“关联网/开联网”命令。QQ 群 `member_openid` 与 C2C `user_openid` 不同，群消息不作为管理命令 |
| `STICKER_REVIEW_MONTHLY_LIMIT` | 变量 | BOT-020：每月最多被动回复几张待确认贴纸，默认 `2`，最多配置 `4`；owner 必须先私聊发起，不使用已停用的 C2C 主动推送 |

## 核心参数

参数集中在 `src/config.js`。

| 参数 | 当前值 | 作用 |
|---|---:|---|
| `CONTEXT_WINDOW_MS` | 72 小时 | 上下文时间窗口（窗口外的旧内容由 digest 承担） |
| `CONTEXT_MAX_MESSAGES` | 400 | 上下文消息条数上限（按灰度群频率约等于 2 天活跃内容） |
| `CONTEXT_ANCHOR_SLACK_MESSAGES` | 200 | 窗口起点锚点的松弛量：条数超过 400+200 时才整体前移一次锚点 |
| `CONTEXT_MAX_CHARS` | 60000 | 上下文字符上限（超出时从最旧一端裁剪） |
| `STORED_CONTENT_MAX_CHARS` | 2000 | 入站消息与记忆写入 D1 时的正文截断上限 |
| `MAX_REPLY_CHARS` | 1800 | 单条最终气泡的防御性截断上限（40 字总预算之外的第二道保险） |
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
| `MIN_STAGE_BUDGET_MS` | 2000 | 单个模型阶段的最小可用预算；不足时跳过该阶段 |
| `SEND_BUDGET_RESERVE_MS` | 8000 | 为 QQ 发送预留的预算 |
| `LLM_TIMEOUT_MS` | 12000 | 模型调用上限 |
| `FALLBACK_RETRY_TIMEOUT_MS` | 8000 | 视觉调用失败后纯文本重试的超时 |
| `WEB_FETCH_TIMEOUT_MS` | 4000 | 单次 DeepSeek Fetch 超时 |
| `WEB_FETCH_MAX_CHARS` | 4000 | 注入上下文的网页正文上限 |
| `WEB_MAX_URLS_PER_TURN` | 1 | 单轮最多抓取的 URL 数 |
| `WEB_SEARCH_TIMEOUT_MS` | 4000 | 单次 DeepSeek Search 超时 |
| `WEB_SEARCH_COUNT` | 3 | 请求 Search 返回的候选条数 |
| `WEB_SEARCH_MAX_RESULTS` | 3 | 注入上下文的最多结果数 |
| `WEB_SEARCH_SUMMARY_MAX_CHARS` | 600 | 单条搜索结果摘要上限 |
| `WEB_SEARCH_MAX_QUERY_CHARS` | 128 | 搜索词上限（DeepSeek 接口限制） |
| `WEB_429_COOLDOWN_MS` | 60000 | 429 后该会话暂停联网的时长 |
| `WEB_FAILURE_WINDOW` | 20 | 本会话失败率统计的最近真实调用次数（跳过轮次不计入） |
| `WEB_FAILURE_RATE_THRESHOLD` | 0.5 | 失败率超过该比例（>50%）时触发熔断 |
| `WEB_FAILURE_BLOCK_MS` | 300000 | 熔断后暂停联网的时长 |
| `SEND_TIMEOUT_MS` | 8000 | QQ 单次发送上限 |
| `SEND_RETRY_TIMEOUT_MS` | 4000 | QQ 发送网络重试的超时 |
| `TOKEN_TIMEOUT_MS` | 5000 | QQ access token 获取超时 |
| `MAX_IMAGES_PER_MESSAGE` | 4 | 当前消息图片上限 |
| `MAX_IMAGES_PER_BATCH` | 4 | 每次模型调用的批次图片上限 |
| `MAX_IMAGE_BYTES` | 20 MiB | 单张图片 URL 声明大小上限 |
| `MAX_IMAGE_URL_LENGTH` | 8192 | 图片 URL 长度上限 |
| `MAX_FACE_EXT_BYTES` | 64 KiB | 表情 `ext` base64 大小上限 |
| `STICKER_MAX_BYTES` | 1572864 | 单张 D1 base64 贴纸图片字节上限（1.5 MiB） |
| `STICKER_MEDIA_URL_TTL_SECONDS` | 180 | QQ 拉取贴纸资源的签名 URL 有效期 |
| `STICKER_COOLDOWN_MS` | 1800000 | 每个会话贴纸发送最小间隔（可由环境变量覆盖） |
| `STICKER_SOURCE_URL_TTL_MS` | 86400000 | owner 待确认/待收录贴纸的加密源 URL 最长保留时间；未收录前不保存原图 bytes |
| `STICKER_REVIEW_MONTHLY_LIMIT` | 2 | owner 每月主动拉取的待确认贴纸回复条数（上限4） |
| `MEMORY_RETENTION_MS` | 30 天 | 长期记忆：原文保留期（`MEMORY_RETENTION_DAYS` 可覆盖） |
| `MEMORY_COMPACT_AFTER_MS` | 2 天 | 长期记忆：超过这个时长的消息才值得压缩（`MEMORY_COMPACT_AFTER_DAYS` 可覆盖） |
| `MEMORY_DRY_RUN_DEFAULT` | true | 长期记忆：默认不删除，只报告 |
| `MEMORY_MAX_MESSAGES_PER_CHUNK` | 400 | 单次摘要输入的消息条数上限 |
| `MEMORY_MAX_CHARS_PER_CHUNK` | 40000 | 单次摘要输入的字符上限 |
| `MEMORY_MAX_CHUNKS_PER_CONVERSATION` | 4 | 每个会话每轮最多压缩几块 |
| `MEMORY_MAX_CONVERSATIONS_PER_RUN` | 20 | 每轮最多处理几个会话 |
| `MEMORY_PROFILE_MAX_CHARS` | 1800 | 长期画像长度上限（2026-09-30 从 1200 放宽，画像此前连续顶到上限） |
| `MEMORY_DIGEST_MAX_CHARS` | 1200 | 单段 digest 长度上限 |
| `MEMORY_DIGESTS_INJECTED` | 7 | 注入回复上下文时携带的最近 digest 段数 |
| `MEMORY_TIMEOUT_MS` | 20000 | 单次摘要模型调用上限 |
| `MEMORY_MAX_TOKENS` | 2000 | 单次摘要输出的 token 上限（整理任务关闭思考，`thinking: false`） |

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
