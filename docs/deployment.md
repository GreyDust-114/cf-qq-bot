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

## 变量与机密

非机密变量位于本地 `wrangler.toml`（参考公开模板 `wrangler.toml.example`）；机密通过 Wrangler 写入：

```powershell
npx wrangler secret put QQ_APP_SECRET
npx wrangler secret put LLM_API_KEY
```

本地复制 `.dev.vars.example` 为 `.dev.vars`，不要提交真实值。

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
