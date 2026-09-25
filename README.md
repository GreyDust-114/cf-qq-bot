# qq-ai-bot

运行在 **Cloudflare Workers** 上的 QQ 官方群聊 AI 机器人。

项目使用 Durable Objects 串行协调每个会话，以 D1 保存对话事实和逐气泡 outbox，并通过 DeepSeek 生成回复、QQ OpenAPI 发送消息。整个服务为 Serverless 架构，不需要自建服务器或常驻进程。

> [!NOTE]
> `src/prompts.js` 是提示词的唯一编辑入口，当前包含一份完整的**实验 / 测试提示词示例**，集中了人设、四条路由的系统提示、系统提示碎片与兜底话术。提示词不是稳定 API；后续生产调优不保证全部同步到公开仓库。

> [!NOTE]
> 本项目使用 AI 编程工具辅助设计、实现、测试与文档整理，并由人工确认产品行为、生产变更和最终提交。

## 核心能力

- QQ Webhook 验签与 op:13 回调验证
- 按 `conversationId` 寻址的 Durable Object 会话协调器
- alarm 驱动的消息防抖、批次、revision / lease 过时结果拦截
- 90 秒活跃续聊：原发言者无需重复 @
- 短气泡分条、自然发送间隔与新消息中止旧分条
- D1 对话记忆、冷却状态与逐气泡 outbox
- `pending / sent / failed / uncertain` 可靠发送状态
- 图片消息、多模态失败回退与正文格式清理

## 架构概览

```text
QQ 官方 Bot
   │ HTTPS Webhook
   ▼
Cloudflare Worker
   ├─ 验签 / 消息解析
   └─ conversationId 路由
          ▼
Durable Object: ConversationHub
   ├─ alarm / batch / revision / lease
   ├─ DeepSeek API
   ├─ QQ OpenAPI
   └─ D1: messages / conversations / settings / outbox
```

详细设计见 [架构文档](docs/architecture.md)。

## 快速开始

要求：Node.js、Cloudflare 账号、QQ 官方机器人、DeepSeek API Key。

```powershell
npm install
Copy-Item wrangler.toml.example wrangler.toml   # 填入自己的 D1 / AppID / 灰度群
Copy-Item .dev.vars.example .dev.vars           # 填入本地机密
npx wrangler d1 migrations apply qq-ai-bot-db --local
npm run dev
```

在 `.dev.vars` 中填写本地机密；生产机密使用 `wrangler secret`，不要提交真实密钥。真实的 `wrangler.toml` 含环境专属标识，已被 gitignore，公开仓库只保留 `wrangler.toml.example`。

## 部署

```powershell
npx wrangler login
Copy-Item wrangler.toml.example wrangler.toml   # 首次：填入 D1 / AppID / 灰度群
npx wrangler d1 migrations apply qq-ai-bot-db --remote
npm run deploy
```

部署前需要在本地 `wrangler.toml` 配置 D1、QQ AppID、模型和灰度群。完整步骤见 [部署文档](docs/deployment.md)。

## 仓库范围

公开仓库保留主要源码、D1 migrations、Cloudflare 配置和正式文档。

维护者本地的测试、测试 adapter、工程 Runtime、审查截图、Git hooks、辅助脚本、`.dev.vars` 与含真实环境标识的 `wrangler.toml` 不进入 GitHub 当前文件树；这些文件仍可在维护者工作区中使用，`npm test`、`npm run verify` 等脚本因此只在维护者工作区可用。

## 文档

- [架构与数据职责](docs/architecture.md)
- [部署、迁移与回滚](docs/deployment.md)
- [环境变量与可调参数](docs/configuration.md)
- [聊天行为与提示词协议](docs/behavior.md)
- [运维、日志与排错](docs/operations.md)
- [生产灰度验收记录（2026-09-23）](docs/gray-acceptance-2026-09-23.md)
- [生产灰度验收记录（2026-09-25）](docs/gray-acceptance-2026-09-25.md)

## AI 辅助开发与参考项目

本项目使用 AI 工具参与需求梳理、代码实现、测试设计、生产观测分析和文档维护。所有远程迁移、生产部署和产品取舍均由项目维护者确认。

架构与群聊交互设计参考 / 受启发于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)。本项目使用 QQ 官方 Bot + Cloudflare Serverless 架构，与该项目的本地常驻进程和第三方 QQ 协议路线不同，也与其不存在隶属关系。

## License

见 [LICENSE](LICENSE)。
