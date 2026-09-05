// 平台接缝：Cloudflare D1 驱动只允许出现在本文件。
// schema/迁移形态由 db/client.ts 的 SCHEMA_DDL（幂等建表）保证，与自部署的 drizzle migrate 一致。

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";
import type { Db } from "./client.ts";

export function openD1(client: D1Database): Db {
  // drizzle 的 D1 类与本项目的统一 Db 类型（公共基类）结构兼容
  return drizzle(client, { schema }) as unknown as Db;
}
