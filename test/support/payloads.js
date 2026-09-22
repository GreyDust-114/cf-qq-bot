// 测试用 QQ webhook payload 构造器。

export function buildC2cPayload({
  id,
  content = "你好",
  userOpenid = "user-openid-1",
  attachments,
  msgElements,
  messageType,
} = {}) {
  return {
    op: 0,
    t: "C2C_MESSAGE_CREATE",
    id: `event-${id}`,
    d: {
      id,
      content,
      author: { user_openid: userOpenid },
      ...(attachments ? { attachments } : {}),
      ...(msgElements ? { msg_elements: msgElements } : {}),
      ...(messageType ? { message_type: messageType } : {}),
    },
  };
}

export function buildGroupPayload({
  id,
  content = "你好",
  groupOpenid = "group-openid-1",
  memberOpenid = "member-openid-1",
  username = "群友甲",
  mentioned = false,
  mentions,
  attachments,
  msgElements,
  messageType,
} = {}) {
  return {
    op: 0,
    t: mentioned ? "GROUP_AT_MESSAGE_CREATE" : "GROUP_MESSAGE_CREATE",
    id: `event-${id}`,
    d: {
      id,
      content,
      group_openid: groupOpenid,
      author: { member_openid: memberOpenid, username },
      ...(mentions ? { mentions } : {}),
      ...(attachments ? { attachments } : {}),
      ...(msgElements ? { msg_elements: msgElements } : {}),
      ...(messageType ? { message_type: messageType } : {}),
    },
  };
}
