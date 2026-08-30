// 平台接缝：bun:sqlite 仅允许出现在本文件（见 dev-plan §1）。
// 回退 Node 时只需把驱动换成 drizzle-orm/better-sqlite3，schema 与迁移不变。

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

export type Db = BunSQLiteDatabase<typeof schema>;

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
