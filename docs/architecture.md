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

会话类型、摘要、自主发言冷却、90 秒活跃聊天窗口和最后被回复的群成员。

### messages

用户和机器人实际消息。用户消息按 QQ `event_id` 去重；成功发送的每个机器人气泡独立写一行。

### lore

角色资料库（`0004_lore.sql`）：`title`、`content`、`sort_order`。内容由维护者本地的语料同步脚本写入，语料本身不进入公开仓库。每批处理时读取一次，作为独立 system 消息插在摘要之后、历史之前；表为空或迁移未应用时按「无资料」运行。

### settings

QQ access token 与过期时间。

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
| `src/llm.js` | DeepSeek 调用与图片回退 |
| `src/sender.js` | 单气泡 QQ 发送与有限网络重试 |
| `src/pure.js` | 消息解析、提示词消息构建、正文清理与气泡切分 |
| `src/prompts.js` | 全部提示词、人设、输出协议与兜底话术（唯一编辑入口） |
