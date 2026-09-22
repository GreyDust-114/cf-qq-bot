// 测试用 D1 adapter：内存 node:sqlite + 全部生产 migration 的真实 schema。

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = new URL("../../db/migrations/", import.meta.url);

const SCHEMA_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) =>
    readFileSync(new URL(file, MIGRATIONS_DIR), "utf8"),
  )
  .join("\n");

export function createSqliteD1() {
  const database = new DatabaseSync(":memory:");

  database.exec(SCHEMA_SQL);

  function statement(sql) {
    let params = [];

    const bound = {
      bind(...values) {
        params = values;
        return bound;
      },
      async first() {
        const row = database.prepare(sql).get(...params);
        return row === undefined ? null : row;
      },
      async all() {
        return {
          success: true,
          results: database.prepare(sql).all(...params),
        };
      },
      async run() {
        const result = database.prepare(sql).run(...params);

        return {
          success: true,
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid),
          },
        };
      },
    };

    return bound;
  }

  return {
    database,
    prepare: statement,
  };
}

export async function listMessages(env, conversationId) {
  const { results } = await env.DB.prepare(
    `SELECT role, content, event_id
     FROM messages
     WHERE conversation_id = ?
     ORDER BY id`,
  )
    .bind(conversationId)
    .all();

  return results;
}

export async function listOutbox(env, conversationId) {
  const { results } = await env.DB.prepare(
    `SELECT batch_id, revision, part_index, msg_seq, status, attempts,
            trigger_event_id, qq_message_id, assistant_message_id, error
     FROM outbox
     WHERE conversation_id = ?
     ORDER BY part_index`,
  )
    .bind(conversationId)
    .all();

  return results;
}
