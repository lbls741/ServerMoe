// 平台接缝：node:crypto 仅允许出现在本文件（见 dev-plan §1）。
// 其余模块统一通过此处的加密/哈希/HMAC/随机接口工作，保证未来可平移到 WebCrypto。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const AES_ALGO = "aes-256-gcm";
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

export function deriveKey(secret: string, saltB64: string): Buffer {
  return scryptSync(secret, Buffer.from(saltB64, "base64"), 32);
}

/** AES-256-GCM，输出 base64(iv || tag || ciphertext)。 */
export function encryptString(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptString(key: Buffer, encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const ct = raw.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function hmacSignHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** sendkey 形如 Server酱（前缀 + 随机串），无易混淆字符。 */
const KEY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function generateSendkey(): string {
  const bytes = randomBytes(16);
  let out = "SSC";
  for (const b of bytes) out += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function randomId(): string {
  return randomUUID();
}

/** X-WECHAT-UIN 头：随机 uint32 的十进制字符串再 base64（官方语义，无鉴权意义）。 */
export function randomWechatUinB64(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

/** 常量时间比较，用于 token/key 校验。 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
