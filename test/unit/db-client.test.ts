import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSchema } from "../../src/db/client.ts";
import * as schema from "../../src/db/schema.ts";

describe("ensureSchema（Workers 幂等 DDL）", () => {
  test("全量 DDL 可建表且幂等，保留字列（mail_configs.from）可读写", async () => {
    const db = drizzle(new Database(":memory:"), { schema });
    await ensureSchema(db);
    await ensureSchema(db); // IF NOT EXISTS：重复执行不报错
    await db.insert(schema.mailConfigs).values({ accountId: "acc1", imapEnc: "i", smtpEnc: "s", from: "a@b.c" });
    const rows = await db.select().from(schema.mailConfigs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from).toBe("a@b.c");
  });
});
