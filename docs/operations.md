# 运维、日志与排错

## 健康检查

```powershell
curl https://<worker-domain>/
npx wrangler tail
```

健康响应：

```text
QQ AI Bot is running.
```

## 常用日志

| 日志 | 含义 |
|---|---|
| `Incoming message:` | webhook 消息已解析 |
| `stage=coordinator enqueue` | 进入会话协调器 |
| `stage=coordinator batch start/done` | 批次开始/结束 |
| `Coordinator: dropping stale reply` | 新 revision 拦截旧生成 |
| `Route: active/mention/autonomous` | 当前群聊路由 |
| `Active window opened:` | 活跃聊天窗口开启/续期 |
| `Reply parse warning: plain-text-fallback` | 模型返回纯文本，解析器兜底 |
| `Reply parse warning: merged-overflow` | 超出气泡条数，已均衡合并 |
| `Reply parse warning: trimmed-total` | 超出总字数预算，已裁剪 |
| `stage=outbox sent part=N` | 气泡成功并记录 |
| `stage=outbox failed part=N` | 确定性失败 |
| `stage=outbox uncertain part=N` | 发送结果不确定，不自动重发 |
| `stage=llm ok in Xms` | 模型耗时 |
| `stage=send ok in Xms` | QQ 发送耗时 |

## outbox 判定

- `sent`：必须有关联 assistant message；正常情况下还有 QQ message id
- `failed`：确定性失败，停止后续 part
- `uncertain`：可能已送达，不自动重发
- 旧 `pending`：按 `batch_id` 查对应 `batch done`
  - `stale`：该生成被新消息取代
  - `replied` 且仍有 pending：前序 part 已发送，新消息到达后停止剩余 part
  - 缺少终态并且年龄超过 `PROCESSING_STALE_MS`：可能卡死，需要检查 Durable Object 日志

## 告警建议

人工检查条件：

1. `failed / uncertain` outbox 出现；
2. sent outbox 缺 assistant / QQ id；
3. 时间前缀、气泡内换行或悬空分隔标点回归；
4. `trimmed-total` 持续高频；
5. `recovering stale batch` 持续出现；
6. LLM / QQ 发送 P90 明显高于验收基线。

灰度基线：LLM P90 约 1.9 秒，QQ 发送 P90 约 2.2 秒。详细见 [灰度验收记录](gray-acceptance-2026-09-23.md)。

## 常见问题

### 群里不回复

- 检查是否在 `ALLOWED_GROUP_OPENID` 灰度群
- 查看 `Route` 与 `Decision: no reply`
- active 路由不应被 autonomous cooldown 拦截

### 回复漏掉后半段

查 outbox：如果前序 `sent`、后序 `pending` 且批次 outcome 为 `replied/stale`，通常是新消息到达后主动停止了旧气泡。

### 时间前缀泄漏

检查 outbox 正文与 `stripTimePrefix`；正常不应出现严格 `[MM-DD HH:MM]` 开头。

### 回复过长

查看 `trimmed-total` 告警与 `MAX_REPLY_TOTAL_CHARS`；提示词用于软引导，解析层硬预算用于兜底。

## 已知限制

- 原始上下文窗口 24 小时；每日摘要尚未实现
- 不支持贴纸与网络搜索
- 图片只在当前消息内识别，历史仅保存占位描述
- `uncertain` 不会自动重发，需要人工确认后使用同一 msg_seq 恢复
