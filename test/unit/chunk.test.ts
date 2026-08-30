import { describe, expect, test } from "bun:test";
import { chunkText } from "../../src/channels/wechat/chunk.ts";

describe("chunkText", () => {
  test("短文本不切分、不加序号", () => {
    expect(chunkText("hello", 3000)).toEqual(["hello"]);
  });

  test("多行文本按行边界切分并追加 (i/n)", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line-${i}-${"x".repeat(400)}`).join("\n");
    const chunks = chunkText(text, 1500);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1500 + 8); // 允许 (i/n) 后缀
    }
    expect(chunks[0]).toContain("(1/");
    expect(chunks[chunks.length - 1]).toContain(`(${chunks.length}/${chunks.length})`);
  });

  test("单行超限按字符硬切", () => {
    const chunks = chunkText("a".repeat(7000), 3000);
    expect(chunks).toHaveLength(3);
    // 每块正文 3000/3000/1000，追加 "\n(i/n)" 序号（6 字符）
    expect(chunks[0]!.length).toBe(3000 + 6);
    expect(chunks[2]!.length).toBe(1000 + 6);
  });

  test("limit 内不追加序号", () => {
    expect(chunkText("a".repeat(100), 200)).toEqual(["a".repeat(100)]);
  });
});
