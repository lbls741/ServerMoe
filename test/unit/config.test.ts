import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";

describe("loadConfig", () => {
  test("defaults", () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.dataDir).toBe("data");
    expect(cfg.dbPath).toBe("data/gateway.db");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.textChunkLimit).toBe(3000);
  });

  test("env overrides", () => {
    const cfg = loadConfig({ MOE_PORT: "9000", MOE_DATA_DIR: "/tmp/x", MOE_LOG_LEVEL: "debug" });
    expect(cfg.port).toBe(9000);
    expect(cfg.dbPath).toBe("/tmp/x/gateway.db");
    expect(cfg.logLevel).toBe("debug");
  });

  test("旧 SSC_ 前缀兼容（已部署环境平滑迁移）", () => {
    const cfg = loadConfig({ SSC_PORT: "9100", SSC_DATA_DIR: "/tmp/legacy" });
    expect(cfg.port).toBe(9100);
    expect(cfg.dbPath).toBe("/tmp/legacy/gateway.db");
  });

  test("MOE_ 优先于 SSC_", () => {
    const cfg = loadConfig({ MOE_PORT: "9001", SSC_PORT: "9002" });
    expect(cfg.port).toBe(9001);
  });

  test("invalid values rejected", () => {
    expect(() => loadConfig({ SSC_PORT: "not-a-number" })).toThrow();
    expect(() => loadConfig({ SSC_LOG_LEVEL: "verbose" })).toThrow();
  });
});
