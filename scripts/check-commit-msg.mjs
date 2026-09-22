#!/usr/bin/env node
// 提交信息校验器：规则见 AGENTS.md 的「Git 提交规范」。
// 既作为 commit-msg 钩子的实现，也可被单元测试直接导入。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const COMMIT_TAGS = [
  "功能",
  "修复",
  "重构",
  "文档",
  "测试",
  "构建",
  "性能",
  "维护",
];

const SKIP_PREFIXES = ["Merge ", "Revert ", "fixup! ", "squash! "];

export function validateCommitMessage(raw) {
  const lines = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.startsWith("#"));

  const cleaned = lines.join("\n").trim();

  if (!cleaned) {
    return { ok: false, reason: "提交信息为空" };
  }

  const [headerLine, ...rest] = cleaned.split("\n");
  const header = headerLine.trim();

  if (SKIP_PREFIXES.some((prefix) => header.startsWith(prefix))) {
    return { ok: true, skipped: true, header };
  }

  const tagPattern = new RegExp(
    `^\\[(${COMMIT_TAGS.join("|")})\\]\\s+\\S+`,
  );

  if (!tagPattern.test(header)) {
    const tags = COMMIT_TAGS.map((tag) => `[${tag}]`).join("、");
    return {
      ok: false,
      reason: `标题必须形如「[标签] 一句话说明」，可用标签：${tags}`,
    };
  }

  const body = rest.join("\n").trim();

  if (!body) {
    return {
      ok: false,
      reason: "正文不能为空，请说明更改目的、影响和验证方式",
    };
  }

  return { ok: true, header, body };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const messageFile = process.argv[2];

  if (!messageFile) {
    console.error("用法：node scripts/check-commit-msg.mjs <commit-msg-file>");
    process.exit(2);
  }

  const result = validateCommitMessage(
    readFileSync(messageFile, "utf8"),
  );

  if (!result.ok) {
    console.error(`提交信息不符合规范：${result.reason}`);
    console.error("");
    console.error("示例：");
    console.error("[修复] 修复多气泡发送失败后历史未落库的问题");
    console.error("");
    console.error("目的：失败的气泡不应被记入上下文，否则会造成事实偏差。");
    console.error("影响：仅调整 sending 与落库时机，接口不变。");
    console.error("验证：npm test 中的发送失败场景回归测试通过。");
    process.exit(1);
  }

  process.exit(0);
}
