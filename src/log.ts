// 平台接缝纪律（dev-plan §1）：process/env/sqlite 等运行时 API 只允许出现在
// config/log/db 等边缘模块；channels/api/router/web 只能依赖本文件的 Logger 接口。

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(lvl: LogLevel, msg: string, base: Record<string, unknown>, fields?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...base, ...fields });
  if (lvl === "error") console.error(line);
  else if (lvl === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(level: LogLevel = "info", base: Record<string, unknown> = {}): Logger {
  const min = LEVEL_ORDER[level];
  const make = (bindings: Record<string, unknown>): Logger => ({
    debug: (msg, fields) => {
      if (LEVEL_ORDER.debug >= min) emit("debug", msg, bindings, fields);
    },
    info: (msg, fields) => {
      if (LEVEL_ORDER.info >= min) emit("info", msg, bindings, fields);
    },
    warn: (msg, fields) => {
      if (LEVEL_ORDER.warn >= min) emit("warn", msg, bindings, fields);
    },
    error: (msg, fields) => {
      if (LEVEL_ORDER.error >= min) emit("error", msg, bindings, fields);
    },
    child: (childBindings) => make({ ...bindings, ...childBindings }),
  });
  return make(base);
}
