# 生产灰度验收记录（2026-09-23）

## 范围

- Worker：`qq-ai-bot`
- 生产版本：`f8021375-cfa0-4f66-8f77-c15e80262903`
- 灰度群：由 `ALLOWED_GROUP_OPENID` 限定
- 观测窗口：2026-09-23 01:02:49～06:26:13 UTC（约 5.4 小时）
- 数据来源：Workers Observability、远程 D1 `messages` / `outbox`

本记录只保存聚合数据，不包含真实消息正文。

## 验收结论

| 验收项 | 证据 | 结论 |
|---|---|---|
| 原发言者未 @ 续句稳定回复 | `active` 路由 37 批：33 replied、4 stale，0 silent / cooldown | 通过；stale 均由更新消息抢占 |
| 正文不泄漏内部时间前缀 | 99 条已发气泡中时间前缀 0 | 通过 |
| 气泡自然且无明显乱序 | 1 条 56 批、2 条 21 批、3 条 4 批、4 条 0 批；无换行/悬空分隔标点 | 通过 |
| 发送可观测且可追踪 | outbox 110 行；sent 99 / pending 11 / failed 0 / uncertain 0；发送与 assistant / QQ id 关联缺失均为 0 | 通过 |
| 文档、迁移与 Runtime 一致 | Wrangler、D1 migrations 0001～0003、README 与 Runtime 已复核 | 通过 |

## 消息形态

### 机器人气泡

| 指标 | 平均 | 中位数 | P90 | 最大值 |
|---|---:|---:|---:|---:|
| 单条气泡字数 | 8.5 | 8 | 12 | 13 |
| 单轮回复总字数 | 11.6 | 11 | 18 | 27 |

条数分布（81 个有 outbox 的批次）：

- 1 条：56（69.1%）
- 2 条：21（25.9%）
- 3 条：4（4.9%）
- 4 条：0

### 人类参考样本

最近 200 条群友消息：单条中位数 7 字；按 90 秒、同发言者计算的一轮消息总长中位数 12 字。样本主要来自两位群友，因此只作为长度护栏参考，不用于硬性规定句号、`~` 或语气词风格。

## 路由与回复结果

| 路由 | replied | silent | stale | cooldown |
|---|---:|---:|---:|---:|
| active | 33 | 0 | 4 | 0 |
| mention | 11 | 0 | 1 | 0 |
| autonomous | 27 | 13 | 2 | 2 |

- active / mention 没有 silent 或 cooldown；stale 代表生成期间来了更新消息，由新 revision 接管。
- autonomous 保留模型判断与插话冷却，静默比例符合设计。

## 发送与 outbox

- outbox：110 行 / 81 批；sent 99、pending 11、failed 0、uncertain 0。
- assistant 记录数与 sent outbox 行数一致；没有缺少 assistant_message_id 或 qq_message_id 的 sent 行。
- 未观察到重复 QQ 消息 id。
- 11 条 pending 分布于 9 个批次：8 个批次 outcome=stale，1 个批次为已发送 part 1 后被更新消息打断、剩余 part pending；没有卡死批次。
- 时间前缀、气泡内换行、气泡边界悬空逗号/分号均为 0。
- `plain-text-fallback` 较常见（模型未强制 JSON），由解析层稳定处理；观测窗口内没有 `trimmed-total`、failed 或 uncertain 告警。

## 性能

| 阶段 | 中位数 | P90 | 最大值 |
|---|---:|---:|---:|
| LLM | 1334 ms | 1891 ms | 2369 ms |
| QQ 发送 | 1260 ms | 2180 ms | 3777 ms |

均低于当前 28 秒批次预算。

## 运维判定

需要告警或人工检查的情况：

1. `stage=outbox failed` / `uncertain` 出现；
2. sent outbox 缺 `assistant_message_id` 或 `qq_message_id`；
3. 正文时间前缀、气泡内换行或悬空分隔标点重新出现；
4. pending 批次没有对应的 `batch done: stale/replied`，且年龄超过 `PROCESSING_STALE_MS`；
5. `trimmed-total` 持续高频，说明模型长期忽略总字数提示；
6. `recovering stale batch` 持续出现，说明处理耗时或实例稳定性异常。

## 回滚

```powershell
npx wrangler rollback
```

回滚前确认目标版本与灰度群配置。D1 migration 只向前保留：代码回滚不删除 `active_*` 或 `outbox` 字段/表；需要撤销结构时新增补偿迁移，不修改历史迁移。
