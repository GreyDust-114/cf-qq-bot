# 架构与数据职责

## 总览

```text
QQ 官方 Bot
   │ HTTPS Webhook
   ▼
Cloudflare Worker
   ├─ Ed25519 验签 / op:13
   ├─ 解析 QQ 消息
   └─ 按 conversationId 路由
          ▼
Durable Object: ConversationHub
   ├─ pending / alarm / batch / revision / lease
   ├─ 批次生成与逐气泡发送
   ├─ DeepSeek API
   ├─ QQ OpenAPI
   └─ D1
       ├─ conversations
       ├─ messages
       ├─ lore
       ├─ settings
       └─ outbox
```

每个群聊或私聊映射到一个 `ConversationHub` Durable Object。同一会话内的批次、生成、发送和状态迁移串行执行；不同会话由不同对象并行处理。

## 消息流程

1. Worker 验证 QQ 签名并解析消息。
2. `conversationId` 通过 `idFromName()` 定位 Durable Object。
3. 入站消息立即写入 D1 `messages`，重复 `event_id` 被忽略。
4. 协调器增加 revision、追加 pending，并设置尾随静默窗口 alarm。
5. alarm 把 pending 消息形成一个批次，记录 batch revision 与 lease。
6. 处理器加载 D1 上下文并调用 DeepSeek。
7. 发送前与每个气泡之间检查 revision / lease；新消息会停止过时回复。
8. 每个气泡先写 outbox `pending`，成功后写独立 assistant message 并标记 `sent`。
9. 失败或结果不确定分别标记为 `failed` / `uncertain`。

## 长期记忆整理（BOT-017，P1）

Cron 触发 `scheduled` 入口（`src/index.js` → `src/runtime.js` → `src/memory.js`），
与聊天路径完全分离：

1. 选会话：存在 `created_at >= summarized_until` 且 `created_at < now - 保留期` 的消息的会话；
2. 取区间：按 `created_at, id` 升序取前缀，受条数与字符双上限约束；
3. 一次模型调用：输入为现有画像 + 带 `[MM-DD HH:MM] [发言人]` 的原文，要求按 `【画像】/【本期】` 两个区块输出；
4. 写入顺序固定：`memory_digests` → 画像与 `summarized_until` → 删除区间原文；
   前两步失败就不删，下一次触发重取同一区间（主键 `(conversation_id, period_start)` 保证幂等）；
5. `MEMORY_DRY_RUN` 不为 `"false"` 时只统计可删条数，不执行删除；
6. 单个会话失败不阻断其他会话，但整轮会报失败（`failures`），便于告警。

水位线语义：`summarized_until` 表示“小于该时刻的原文都已经进过摘要”。
取区间用 `>=`、删除用 `<`，两条边界一致，不会出现跳过或重复删除。

删除还有第二道保险：`deleteMessagesBefore` 除水位线外再要求“消息落在某段
`memory_digests` 区间内”，即使水位线被误推进，也不会删掉没有摘要覆盖的消息。

### 记忆注入（回复路径）

回复上下文的消息顺序：

```
系统提示（人设/规则）→ 资料库 → 长期画像 → 近期 digest → 输出协议
  → 历史消息 → 分钟级时间上下文（最后）
```

画像来自 `conversations.summary`，近期 digest 取 `memory_digests` 中最近的
`MEMORY_DIGESTS_INJECTED` 段（按时间升序、带 `[MM-DD]` 前缀）。
整个记忆块位于静态前缀内、且一天只变一次，因此不会破坏前缀缓存；
`memory_digests` 表缺失或为空时按无记忆运行。

## Cloudflare Worker 边缘职责

主要文件：`src/runtime.js`、`src/index.js`。

- 健康检查与 webhook 路由
- op:13 验证响应
- Ed25519 webhook 验签
- QQ payload 解析
- Durable Object stub 路由

Worker 不执行长时间模型生成；实际会话处理在 Durable Object alarm 中完成。

## Durable Object 协调状态

主要文件：`src/conversation-hub.js`、`src/coordinator.js`、`src/coordinator-state.js`。

协调状态只解决并发与恢复问题：

- `revision`：每个新入站消息递增
- `pending`：等待静默窗口结束的消息
- `batch`：当前正在处理的消息集合
- `lease`：失效对象接管时更新，旧执行失去发送资格
- `attempts / last_error / failed_batch`：alarm 失败恢复
- `scheduled_for`：下一次 alarm 时间

协调状态存在 Durable Object storage；对话事实存在 D1。

## D1 事实数据

### conversations

会话类型、摘要（长期画像，由每日整理任务写入）、自主发言冷却、90 秒活跃聊天窗口、最后被回复的群成员，以及长期记忆水位线 `summarized_until`。

### messages

用户和机器人实际消息。用户消息按 QQ `event_id` 去重；群消息另存 `member_openid` 作为说话人身份（昵称可能重复或修改）；成功发送的每个机器人气泡独立写一行。超过保留期且已进过摘要的原文会被删除。

### lore

角色资料库（`0004_lore.sql`）：`title`、`content`、`sort_order`。内容由维护者本地的语料同步脚本写入，语料本身不进入公开仓库。每批处理时读取一次，作为独立 system 消息插在人设之后、摘要与协议提醒之前；静态块整体排在历史与时间上下文之前，顺序是前缀缓存的一部分，不能把分钟粒度的时间上下文插到静态块前面。表为空或迁移未应用时按「无资料」运行。

### settings

QQ access token 与过期时间。

### memory_digests

按区间保存的整理结果（`0005_memory.sql`）：`conversation_id` + `period_start` 为主键，`period_end`、`kind`、`content`、`message_count`。群聊与私聊严格按 `conversation_id` 隔离；主键同时保证同一区间重复运行不会写出第二份。

### outbox

每个生成气泡一行，唯一键为 `(batch_id, part_index)`：

- `pending`：尚未发送或被新 revision 停止
- `sent`：QQ 发送成功，并关联 assistant message / QQ message id
- `failed`：确定性失败
- `uncertain`：网络超时，无法确认是否送达，不自动重发

同一批次重跑时跳过 `sent / failed / uncertain`；稳定的 `msg_seq` 允许 QQ 侧幂等处理。

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.js` | Worker 入口并导出 Durable Object 类 |
| `src/runtime.js` | webhook 验签、解析与会话路由 |
| `src/conversation-hub.js` | Durable Object 适配层 |
| `src/coordinator.js` | alarm、批次、revision、lease 与重试 |
| `src/coordinator-state.js` | 纯状态迁移与存储恢复 |
| `src/processor.js` | 上下文、模型调用、路由、outbox 与发送编排 |
| `src/store.js` | D1 读写 |
| `src/memory.js` | 长期记忆整理：选会话、取区间、模型调用、写 digest 与画像、推进水位线、删除原文 |
| `src/llm.js` | DeepSeek 调用与图片回退 |
| `src/sender.js` | 单气泡 QQ 发送与有限网络重试 |
| `src/pure.js` | 消息解析、提示词消息构建、正文清理与气泡切分 |
| `src/prompts.js` | 全部提示词、人设、输出协议与兜底话术（唯一编辑入口） |
