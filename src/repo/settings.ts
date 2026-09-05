import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { settings } from "../db/schema.ts";

export async function getSetting(db: Db, key: string): Promise<string | undefined> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
  return rows[0]?.value;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}
