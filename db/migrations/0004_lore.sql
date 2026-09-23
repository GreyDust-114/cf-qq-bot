-- 角色资料库：内容由本地语料同步脚本写入（语料本身不进入公开仓库）。
-- Worker 不依赖此表存在：表为空或迁移未执行时按「没有资料」运行。
CREATE TABLE IF NOT EXISTS lore (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
