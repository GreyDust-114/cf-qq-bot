# qq-ai-bot

QQ 官方机器人 + Cloudflare Worker + D1 + DeepSeek API 的群聊 AI。
Serverless 部署，不需要服务器、不需要常驻进程。

## 架构

```text
QQ 官方 Bot
   │ HTTPS Webhook
   ▼
Cloudflare Worker（Wrangler 项目）
   ├─ Ed25519 验签 / op:13 回调验证
   ├─ D1：聊天记录、token 缓存、冷却状态
   ├─ DeepSeek API（OpenAI 兼容）
   └─ QQ OpenAPI：发送回复
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `src/index.js` | Worker 入口：只做环境接线与请求转发 |
| `src/runtime.js` | 编排：webhook 路由、防抖、会话处理、自主发言 |
| `src/pure.js` | 纯函数：消息解析、提示词组装、Markdown 清理、分条 |
| `src/store.js` | D1 读写：会话、消息、冷却状态 |
| `src/token.js` | QQ access_token 获取与 D1 缓存 |
| `src/llm.js` | DeepSeek 调用与图片失败回退 |
| `src/sender.js` | 分条发送、超时重试、时间预算控制 |
| `src/config.js` | 全部可调参数 |
| `src/crypto.js` | Ed25519 验签与 op:13 回调签名 |
| `src/dependencies.js` | 依赖注入接缝：时钟、sleep、随机、fetch、logger |
| `src/prompts.js` | 全部提示词：人设「新約エクシア」+ 群聊决策 / @ 回复 / 私聊 |
| `db/migrations/` | D1 schema 迁移文件 |
| `test/` | 离线回归测试（Node 内置 test runner）；`test/support/` 放测试环境：内存 D1 adapter、假 fetch、手动时钟、payload 构造器 |
| `scripts/` | 开发工具：语法检查、提交信息校验 |
| `.githooks/` `.gitmessage` | commit-msg 钩子与提交模板 |
| `wrangler.toml` | Wrangler 项目配置：入口、D1 绑定、变量 |

## 本地开发与测试

```powershell
npm install
npm run setup    # 配置 commit-msg 钩子与 .gitmessage 模板
npm run verify   # 语法检查 + 离线回归测试
npm run test     # 只跑测试
npm run check    # 只跑语法检查
```

提交信息使用中文，标题形如 `[修复] 一句话说明`，正文说明目的、影响和验证。可用标签：`[功能]`、`[修复]`、`[重构]`、`[文档]`、`[测试]`、`[构建]`、`[性能]`、`[维护]`。仓库的 commit-msg 钩子会自动校验，用 `npm run setup` 启用。

测试不访问网络、不依赖 Cloudflare 账号，通过依赖注入覆盖以下接缝：

- 时钟与 sleep：`deps.now` / `deps.sleep`，由手动时钟控制防抖、分条间隔和冷却
- D1：`node:sqlite` 实现的 D1 兼容 adapter，直接套用 `db/migrations/0001_init.sql`
- 模型调用与 QQ 发送：脚本化 `fetch`，可以按调用次数返回成功、HTTP 错误或网络异常

当前基线覆盖：webhook 验签与 op:13 回调、事件去重、同一会话连续消息的防抖让位、上下文合并、分条发送、发送失败不落库、网络失败重试、图片请求失败回退纯文本、私聊错误兜底、群聊 `NO_REPLY` 与自主发言冷却、消息解析。

本地起 Worker：

```powershell
npx wrangler d1 migrations apply qq-ai-bot-db --local
Copy-Item .dev.vars.example .dev.vars   # 填入真实机密，不要提交
npx wrangler dev
```

## 部署（Wrangler）

从「网页编辑器手工粘贴」迁移过来只需要一次配置，之后每次改动走同一条命令链。

### 1. 安装与登录

```powershell
npm install
npx wrangler login
```

### 2. 绑定 D1

```powershell
npx wrangler d1 list            # 找到 qq-ai-bot-db 的 database_id
# 如果还没有这个库：
npx wrangler d1 create qq-ai-bot-db
```

把真实 `database_id` 写进 `wrangler.toml` 的 `[[d1_databases]]`（当前是占位符 `REPLACE_WITH_D1_DATABASE_ID`）。

### 3. 配置变量与机密

`wrangler.toml` 的 `[vars]` 里维护非机密项：`QQ_APP_ID`、`LLM_BASE_URL`、`LLM_MODEL`、`ALLOWED_GROUP_OPENID`。

机密用 Wrangler 写入，不进入仓库：

```powershell
npx wrangler secret put QQ_APP_SECRET
npx wrangler secret put LLM_API_KEY
```

### 4. 应用数据库迁移

```powershell
npx wrangler d1 migrations apply qq-ai-bot-db --local    # 本地
npx wrangler d1 migrations apply qq-ai-bot-db --remote   # 远程
```

`0001_init.sql` 对每个对象都用了 `IF NOT EXISTS`，所以：

- 全新数据库：直接执行，会建出全部表和索引。
- 从手工部署迁移过来的数据库：执行也是安全的，不会覆盖已有数据；执行后 Wrangler 会把它记录为已应用。

未来的 schema 变更以新的迁移文件追加，不要修改已应用过的迁移。

### 5. 部署与验证

```powershell
npx wrangler deploy
npx wrangler tail    # 实时日志
```

部署成功后访问 `https://<worker域名>/`，应返回 `QQ AI Bot is running.`。随后在 QQ 开放平台把回调地址指向 `https://<worker域名>/qq/webhook`。

### 回滚

- Worker 代码：`npx wrangler deploy` 重新发布上一个版本，或用 `npx wrangler rollback` 回退到历史部署。
- 数据库：D1 migration 只向前执行。需要撤销结构变更时，新增一个补偿迁移，不要手改历史文件。
- 机密：重新 `npx wrangler secret put` 覆盖；确认不再使用时 `npx wrangler secret delete`。

### 本地配置检查

不需要账号即可验证配置与打包：

```powershell
npx wrangler deploy --dry-run --outdir dist
```

## 变量与机密

| 名称 | 类型 | 说明 |
|---|---|---|
| `QQ_APP_ID` | 变量 | 机器人 AppID（`wrangler.toml` 的 `[vars]`） |
| `QQ_APP_SECRET` | Secret | 机器人密钥（验签 + 取 access_token） |
| `LLM_API_KEY` | Secret | DeepSeek API Key |
| `LLM_BASE_URL` | 变量 | `https://api.deepseek.com` |
| `LLM_MODEL` | 变量 | `deepseek-flash` |
| `ALLOWED_GROUP_OPENID` | 变量 | 只响应这个群；留空表示不限制 |

## QQ 开放平台

- 开发设置 → 事件订阅与回调 → 选择 **Webhook**，回调地址填 `https://<worker域名>/qq/webhook`
- 订阅事件：`C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、`GROUP_MESSAGE_CREATE`
- 群消息全量模式（不 @ 也能收到）需要在 **QQ 手机端**开启：群设置里的「群聊消息范围」+「主动在群聊内发言」
- 不要开启 IP 白名单（Worker 没有固定出口 IP）

## 行为设计

| 机制 | 说明 |
|---|---|
| 防抖 | 收到消息后先等待再处理；窗口内又来新消息则让位给最新一条，碎片消息自动合并 |
| 分条发送 | 模型用 `\|\|\|` 分隔多条，最多 3 条，`msg_seq` 递增，条间隔随机 |
| 自主发言冷却 | 群聊中未被 @ 时，两次主动发言之间随机冷却 |
| 思考模式 | 全部场景 `thinking: enabled` + `reasoning_effort: low` |
| 决策协议 | 模型输出 `NO_REPLY` 表示不回复，其他内容视为回复 |
| 图片识别 | 图片 URL 直传多模态；失败自动回退纯文本重试；引用消息里的图片也会被收集 |
| 引用处理 | 引用内容格式化为 `[引用 某某：原文]`；引用机器人自己的消息视为必回 |
| 时间感知 | 系统提示注入当前时间（北京时间），历史消息带 `[MM-DD HH:MM]` 时间戳 |
| Markdown 清理 | 发送前去掉 `**`、`#`、代码围栏等标记，链接转 `文字 (url)` |
| 消息去重 | `messages.event_id` 唯一约束，QQ 重推事件不会重复回复 |
| Token 缓存 | access_token 存 D1，冷启动不再每次都请求 QQ |

## 可调参数（src/config.js）

| 常量 | 当前值 | 作用 |
|---|---|---|
| `CONTEXT_WINDOW_MS` | 24 小时 | 聊天上下文时间窗口 |
| `CONTEXT_MAX_MESSAGES` | 100 | 上下文最多条数 |
| `CONTEXT_MAX_CHARS` | 60000 | 上下文最大字符数 |
| `MAX_REPLY_CHARS` | 1800 | 单条回复最大长度 |
| `MAX_REPLY_PARTS` | 3 | 分条发送上限 |
| `PART_GAP_MIN_MS` / `MAX` | 400 / 1200 | 分条之间的间隔 |
| `DEBOUNCE_MENTION_MIN_MS` / `MAX` | 3000 / 5000 | @ 消息防抖窗口 |
| `DEBOUNCE_GROUP_MIN_MS` / `MAX` | 6000 / 9000 | 普通消息防抖窗口 |
| `AUTONOMOUS_COOLDOWN_MIN_MS` / `MAX` | 15000 / 45000 | 自主发言冷却区间 |
| `INVOCATION_BUDGET_MS` | 28000 | 单次处理总预算（waitUntil 上限 30s） |
| `SEND_BUDGET_RESERVE_MS` | 8000 | 留给发送的时间 |
| `LLM_TIMEOUT_MS` | 12000 | 单次模型调用上限 |
| `SEND_TIMEOUT_MS` | 8000 | 单条发送超时 |
| `MAX_IMAGES_PER_MESSAGE` | 4 | 单条消息最多识别几张图 |

## 运维与排错

常用日志关键词：

```text
Incoming message:           收到事件（含 wasMentioned / images）
Debounce: deferring        本条让位给更新的消息
Debounce: waited Xms       防抖结束，开始处理
Context loaded: N messages 上下文加载完成
Decision: reply / no reply 自主发言判断结果
Autonomous reply skipped   命中冷却
stage=token loaded from d1 token 命中缓存
stage=llm ok in Xms        模型调用成功
stage=llm vision failed    图片请求失败，回退纯文本
stage=send ok (msg_seq N)  发送成功（N 为第几条）
stage=send http / skipped  发送失败或预算不足
LLM time budget exhausted  模型时间不够（需要调小防抖或关闭思考）
```

常见处理：

- 频繁 `LLM time budget exhausted`：调小 `DEBOUNCE_GROUP_MIN_MS/MAX_MS`，或自主发言改回不思考
- 频繁 `stage=send` 超时：QQ 接口偶发慢，属网络波动；连续出现可考虑 Cloudflare Queue
- 想清空聊天记忆：D1 控制台执行 `DELETE FROM messages; DELETE FROM conversations;`（`settings` 表不要动）

## 已知限制

- 上下文窗口 24 小时，更早的内容会遗忘（每日摘要尚未实现）
- 不支持贴纸、网络搜索
- 图片只在当前消息内识别，历史里只保留 `【图片】` 占位
- QQ 接口偶发响应慢（实测 2~8 秒），已做超时与重试保护
- 单次处理总时长受 Cloudflare `waitUntil` 30 秒限制

## 相关文档

- 人设素材来源：PRTS 明日方舟中文 Wiki（能天使 / 新约能天使 / 拉特兰 / 企鹅物流）
