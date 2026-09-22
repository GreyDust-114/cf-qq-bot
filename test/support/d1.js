// 测试用 D1 adapter：内存 node:sqlite + 生产 migration 的真实 schema。

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_SQL = readFileSync(
  new URL("../../db/migrations/0001_init.sql", import.meta.url),
  "utf8",
);

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
