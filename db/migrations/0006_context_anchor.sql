-- 上下文窗口锚点（BOT-017 P4 修正）。
--
-- 背景：读窗口原先取「最新 N 条」，每来一条新消息窗口起点就前移一条，
-- 历史块从第一个 token 起就与上一次调用不同，DeepSeek 前缀缓存整块失效
-- （生产实测：静态块命中 16,128，历史块 11K 全部未命中）。
--
-- context_anchor_at 固定窗口起点：窗口只向后追加，不随新消息滑动；
-- 只有当条数超过 CONTEXT_MAX_MESSAGES + 松弛量时才整体前移一次锚点，
-- 用一次全量未命中换长期高命中率。

ALTER TABLE conversations ADD COLUMN context_anchor_at INTEGER;
