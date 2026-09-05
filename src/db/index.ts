// 平台接缝：bun:sqlite 仅允许出现在本文件（见 dev-plan §1）。
// 自部署（Bun）入口；Workers 用 db/d1.ts 的 openD1。统一类型与建表见 db/client.ts。

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";
import type { Db } from "./client.ts";

export type { Db } from "./client.ts";
export { ensureSchema, SCHEMA_DDL } from "./client.ts";

const clients = new WeakMap<Db, Database>();

export function openDb(dbPath: string, migrationsFolder: string = `${import.meta.dir}/migrations`): Db {
  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  const db = drizzle(sqlite, { schema });
  clients.set(db, sqlite);
  migrate(db, { migrationsFolder });
  return db;
}

export function closeDb(db: Db): void {
  clients.get(db)?.close();
}
