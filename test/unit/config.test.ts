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
    const cfg = loadConfig({ SSC_PORT: "9000", SSC_DATA_DIR: "/tmp/x", SSC_LOG_LEVEL: "debug" });
    expect(cfg.port).toBe(9000);
    expect(cfg.dbPath).toBe("/tmp/x/gateway.db");
    expect(cfg.logLevel).toBe("debug");
  });

  test("invalid values rejected", () => {
    expect(() => loadConfig({ SSC_PORT: "not-a-number" })).toThrow();
    expect(() => loadConfig({ SSC_LOG_LEVEL: "verbose" })).toThrow();
  });
});
