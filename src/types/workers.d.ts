// Cloudflare Workers 运行时类型的最小 ambient 声明（src/entries/worker.ts 与 openD1 使用）。
// 只声明本项目实际触达的面；不引入 @cloudflare/workers-types 以免与 @types/bun 的全局声明冲突。
// wrangler/esbuild 运行时以 workerd 实际 API 为准，类型仅服务 tsc。

declare interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
  dump(): Promise<ArrayBuffer>;
}

declare interface DurableObjectStorageAlarm {
  setAlarm(timestamp: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

declare interface DurableObjectState {
  waitUntil(promise: Promise<unknown>): void;
  storage: DurableObjectStorageAlarm & {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    deleteAll(): Promise<void>;
  };
  /** DO 内置 SQLite（SQLite-backed 类）。本项目 DO 存储用量刻意保持最小，仅调试时使用。 */
  container?: unknown;
  id: { toString(): string; name?: string };
}

declare interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
  name?: string;
}

declare interface DurableObjectNamespace {
  newUniqueId(options?: { jurisdiction?: string }): DurableObjectId;
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
    setAlarm(timestamp: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
  };
  jurisdiction(jurisdiction: string): DurableObjectNamespace;
}

/** Workers 模块的 scheduled 处理器入参（Cron Trigger）。 */
declare interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
  readonly type: string;
  noRetry(): void;
}
