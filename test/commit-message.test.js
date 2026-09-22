import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMIT_TAGS,
  validateCommitMessage,
} from "../scripts/check-commit-msg.mjs";

test("接受带标签和正文的提交信息", () => {
  const result = validateCommitMessage(
    "[功能] 增加会话活跃状态\n\n目的：让续聊不需要重复 @。\n验证：派生测试通过。",
  );

  assert.equal(result.ok, true);
  assert.equal(result.header, "[功能] 增加会话活跃状态");
  assert.match(result.body, /目的/);
});

test("接受全部预定义标签", () => {
  for (const tag of COMMIT_TAGS) {
    const result = validateCommitMessage(
      `[${tag}] 示例改动\n\n目的：验证标签白名单。`,
    );

    assert.equal(result.ok, true, `标签 [${tag}] 应被接受`);
  }
});

test("兼容 CRLF 换行", () => {
  const result = validateCommitMessage(
    "[修复] 修复发送失败落库\r\n\r\n目的：保持上下文准确。",
  );

  assert.equal(result.ok, true);
});

test("拒绝缺少标签的标题", () => {
  const result = validateCommitMessage(
    "修复发送失败落库\n\n目的：保持上下文准确。",
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /标题必须形如/);
});

test("拒绝未知标签", () => {
  const result = validateCommitMessage(
    "[优化] 调整发送节奏\n\n目的：让回复更自然。",
  );

  assert.equal(result.ok, false);
});

test("拒绝空标题", () => {
  const result = validateCommitMessage("[功能]   \n\n目的：……");

  assert.equal(result.ok, false);
});

test("拒绝缺少正文的提交信息", () => {
  const result = validateCommitMessage("[文档] 更新 README");

  assert.equal(result.ok, false);
  assert.match(result.reason, /正文不能为空/);
});

test("模板注释不算正文，会被忽略", () => {
  const result = validateCommitMessage(
    "[测试] 补充边界用例\n\n# 目的：\n# 影响：\n# 验证：",
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /正文不能为空/);
});

test("跳过合并与 fixup 提交", () => {
  for (const message of [
    "Merge branch 'main' into feature",
    "Revert \"[功能] 增加会话活跃状态\"",
    "fixup! [功能] 增加会话活跃状态",
    "squash! [功能] 增加会话活跃状态",
  ]) {
    const result = validateCommitMessage(message);

    assert.equal(result.ok, true, `应跳过：${message}`);
    assert.equal(result.skipped, true);
  }
});

test("拒绝空提交信息", () => {
  assert.equal(validateCommitMessage("").ok, false);
  assert.equal(validateCommitMessage("   \n\n").ok, false);
  assert.equal(validateCommitMessage("# 只有注释").ok, false);
});
