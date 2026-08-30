import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { settings } from "../db/schema.ts";

export function getSetting(db: Db, key: string): string | undefined {
  const rows = db.select().from(settings).where(eq(settings.key, key)).all();
  return rows[0]?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}
