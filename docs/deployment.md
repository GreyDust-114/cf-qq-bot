# 部署、迁移与回滚

## 前置条件

- Node.js
- Cloudflare 账号和 Wrangler
- QQ 官方机器人 AppID / AppSecret
- DeepSeek API Key
- Cloudflare D1

## 安装和登录

```powershell
npm install
npx wrangler login
```

## 配置

首次使用时从模板创建本地配置：

```powershell
Copy-Item wrangler.toml.example wrangler.toml
```

真实的 `wrangler.toml` 已被 gitignore，不会进入公开仓库。

## D1

查找或创建数据库：

```powershell
npx wrangler d1 list
npx wrangler d1 create qq-ai-bot-db
```

将真实 `database_id` 写入本地 `wrangler.toml`。

应用迁移：

```powershell
npx wrangler d1 migrations apply qq-ai-bot-db --local
npx wrangler d1 migrations apply qq-ai-bot-db --remote
```

迁移只向前追加。不要修改已在远程执行的历史迁移；需要撤销时新增补偿迁移。

当前迁移：

- `0001_init.sql`：conversations / messages / settings
- `0002_active_window.sql`：群聊活跃窗口
- `0003_outbox.sql`：逐气泡可靠发送记录
- `0004_lore.sql`：角色资料库表（内容由维护者本地的语料同步脚本写入，不随仓库分发；表为空时机器人按无人设资料运行）
- `0005_memory.sql`：长期记忆（`messages.member_openid`、`conversations.summarized_until`、`memory_digests`）

## 变量与机密

非机密变量位于本地 `wrangler.toml`（参考公开模板 `wrangler.toml.example`）；机密通过 Wrangler 写入：

```powershell
npx wrangler secret put QQ_APP_SECRET
npx wrangler secret put LLM_API_KEY
```

本地复制 `.dev.vars.example` 为 `.dev.vars`，不要提交真实值。

长期记忆开关（非机密变量，写在本地 `wrangler.toml`）：

- `MEMORY_DRY_RUN`：`"true"`（默认）只报告不删除；试运行 3 天后改为 `"false"` 才开启删除；
- `MEMORY_RETENTION_DAYS`：原文保留天数（先 `30`，观察一周后收到 `7`）；
- `[triggers] crons = ["0 20 * * *"]`：北京时间每天 04:00 触发整理（UTC 前一天 20:00）。

长期记忆开闸顺序（先 dry_run、再 30 天保留、最后 7 天）：

1. 先应用远程 migration 0005，再部署带 crons 的版本（顺序不能颠倒：新代码读 `memory_digests` 失败时按无记忆降级，但迁移未应用时表不存在）；
2. `MEMORY_DRY_RUN="true"` 跑满 3 天，每天检查 `stage=memory done` 的 `deleted` 与 `failures=0`，并抽查 digest 内容是否只保留事实与约定；
3. 3 天无异常后改为 `MEMORY_DRY_RUN="false"`，保留期保持 30 天；删除后确认被删区间仍能从画像/digest 回答（问一个几天前的事）；
4. 观察一周无记忆丢失后，把 `MEMORY_RETENTION_DAYS` 收到 `7`（再做一次同样的核对）。

每次调整都要留三组证据：删除条数与水位线、被删区间的可答性、`stage=usage` 的命中率与长度分布。

## 部署

```powershell
npm run deploy
npx wrangler tail
```

Durable Object migration 由 `wrangler.toml` 的 `[[migrations]]` 管理，不需要手工创建对象。

部署成功后访问：

```text
https://<worker-domain>/
```

应返回：

```text
QQ AI Bot is running.
```

QQ 开放平台 webhook 设置为：

```text
https://<worker-domain>/qq/webhook
```

订阅：

- `C2C_MESSAGE_CREATE`
- `GROUP_AT_MESSAGE_CREATE`
- `GROUP_MESSAGE_CREATE`

接收非 @ 群消息需要在 QQ 群设置中开启完整群聊消息范围和机器人主动发言权限。Worker 没有固定出口 IP，不要启用 QQ IP 白名单。

## 部署检查

```powershell
npx wrangler deploy --dry-run --outdir dist
```

确认绑定包含：

- `CONVERSATION_HUB`
- `DB`
- `QQ_APP_ID`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `ALLOWED_GROUP_OPENID`

## 回滚

Worker：

```powershell
npx wrangler rollback
```

回滚前确认目标版本、灰度群变量和 secrets。代码回滚不会删除 D1 表或字段；D1 结构需要通过新的补偿迁移处理。

## 生产变更门禁

远程 migration、部署、删除数据和修改 Cloudflare 资源前应由维护者明确确认。灰度优先通过 `ALLOWED_GROUP_OPENID` 限定到单群。
