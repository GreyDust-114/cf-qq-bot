// High-confidence checks for model-internal instructions accidentally emitted
// as user-facing text. This intentionally avoids keyword-only matching.
const INTERNAL_CONTROL_PATTERNS = [
  {
    rule: "turn-instruction",
    pattern:
      /^(?:本轮|这轮|本次)(?:回复|回答|输出)?(?:应|要|需要|必须|只需|只能|请).{0,16}(?:回复|回答|输出|说|短句|一句|JSON)/u,
  },
  {
    rule: "reply-style-instruction",
    pattern:
      /^(?:请|不要|别|必须|应该|需要|记得|注意)(?:回复时|回答时|输出时)?(?:展开|回复|回答|输出|提及|说).{0,10}(?:太长|简短|一句|短句|这个话题|刚才)/u,
  },
  {
    rule: "response-routing-note",
    pattern: /^(?:响应|回应)到.{1,24}(?:的事|话题|内容)(?:上|里)/u,
  },
];

export function inspectReplyCandidate(candidate) {
  const text = String(candidate ?? "").trim();

  if (!text) {
    return null;
  }

  // Also catch a leaked instruction appended after a complete user-facing
  // sentence, while avoiding broad keyword matching inside quotes or clauses.
  const clauses = text.split(/(?<=[。！？!?；;])/u).map((part) => part.trim());

  for (const clause of clauses) {
    for (const { rule, pattern } of INTERNAL_CONTROL_PATTERNS) {
      if (pattern.test(clause)) {
        return rule;
      }
    }
  }

  return null;
}
