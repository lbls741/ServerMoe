import { describe, expect, test } from "bun:test";
import {
  decryptString,
  deriveKey,
  encryptString,
  generateSendkey,
  hmacSignHex,
  randomId,
  sha256Hex,
} from "../../src/crypto.ts";

describe("crypto", () => {
  const key = deriveKey("test-secret", Buffer.from("0123456789abcdef").toString("base64"));

  test("encrypt/decrypt roundtrip", () => {
    const enc = encryptString(key, "bot-token-🤖中文");
    expect(enc).not.toContain("bot-token");
    expect(decryptString(key, enc)).toBe("bot-token-🤖中文");
  });

  test("ciphertext is randomized (same input, different output)", () => {
    expect(encryptString(key, "data")).not.toBe(encryptString(key, "data"));
  });

  test("tampered ciphertext fails auth", () => {
    const enc = encryptString(key, "data");
    const raw = Buffer.from(enc, "base64");
    const last = raw.length - 1;
    raw[last] = raw[last]! ^ 0xff;
    expect(() => decryptString(key, raw.toString("base64"))).toThrow();
  });

  test("wrong key fails auth", () => {
    const other = deriveKey("other-secret", Buffer.from("0123456789abcdef").toString("base64"));
    expect(() => decryptString(other, encryptString(key, "data"))).toThrow();
  });

  test("sendkey format (MOE prefix, 16 unambiguous chars)", () => {
    expect(generateSendkey()).toMatch(/^MOE[23456789A-HJ-NP-Za-km-z]{16}$/);
  });

  test("hmac / sha256 / uuid shapes", () => {
    expect(hmacSignHex("s", "body")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(randomId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
