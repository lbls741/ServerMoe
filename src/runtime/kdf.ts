// Workers 端 masterKey 派生（WebCrypto）。自部署（Bun）保持 crypto.ts 的 scryptSync 不变
// （既有 data 卷的派生结果不能变），两平台的密钥互不迁移——换部署形态即重新扫码绑定。
//
// CPU 策略（Workers 免费版 10ms/请求）：
// - 用户显式提供的 MOE_SECRET（可能低熵）：PBKDF2-SHA256 10 万迭代（subtle 上限），
//   派生结果按 (secret, salt) 缓存在模块级——每个 isolate 只付一次成本；
// - 自动生成的 secret（32 字节高熵 hex）：直接 SHA-256(secret‖salt)，高熵原料无需慢哈希。

import { Buffer } from "node:buffer";

const PBKDF2_ITERATIONS = 100_000;

const keyCache = new Map<string, Buffer>();

export async function deriveKeyWorkers(secret: string, saltB64: string, generated: boolean): Promise<Buffer> {
  const cacheKey = `${generated ? "g" : "u"}:${saltB64}:${secret}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;

  const salt = Uint8Array.from(atob(saltB64), (ch) => ch.charCodeAt(0));
  let bits: ArrayBuffer;
  if (generated) {
    const material = new TextEncoder().encode(secret);
    const merged = new Uint8Array(material.length + salt.length);
    merged.set(material);
    merged.set(salt, material.length);
    bits = await crypto.subtle.digest("SHA-256", merged);
  } else {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
    bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, base, 256);
  }
  const key = Buffer.from(bits);
  if (keyCache.size > 8) keyCache.clear();
  keyCache.set(cacheKey, key);
  return key;
}
