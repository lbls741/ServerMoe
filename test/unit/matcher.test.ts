import { describe, expect, test } from "bun:test";
import { isValidRegex, matchKeyword } from "../../src/router/matcher.ts";

const k = (id: number, keyword: string, matchMode: "exact" | "prefix" | "contains" | "regex") => ({ id, keyword, matchMode });

describe("matchKeyword", () => {
  test("exact 精确匹配（大小写不敏感）", () => {
    const kws = [k(1, "deploy", "exact")];
    expect(matchKeyword("deploy", kws)?.id).toBe(1);
    expect(matchKeyword("  Deploy  ", kws)?.id).toBe(1);
    expect(matchKeyword("deploy now", kws)).toBeNull();
  });

  test("prefix 前缀匹配", () => {
    const kws = [k(1, "deploy", "prefix")];
    expect(matchKeyword("deploy all", kws)?.id).toBe(1);
    expect(matchKeyword("redeploy", kws)).toBeNull();
  });

  test("contains 包含匹配", () => {
    const kws = [k(1, "CI", "contains")];
    expect(matchKeyword("trigger CI build", kws)?.id).toBe(1);
    expect(matchKeyword("cicd", kws)?.id).toBe(1);
  });

  test("regex 模式", () => {
    const kws = [k(1, "^run-\\d+$", "regex")];
    expect(matchKeyword("run-42", kws)?.id).toBe(1);
    expect(matchKeyword("run-x", kws)).toBeNull();
  });

  test("非法正则不抛异常且不命中", () => {
    const kws = [k(1, "([bad", "regex")];
    expect(matchKeyword("anything", kws)).toBeNull();
    expect(isValidRegex("([bad")).toBe(false);
    expect(isValidRegex("^ok$")).toBe(true);
  });

  test("优先级 exact > prefix > contains > regex", () => {
    const kws = [
      k(4, "deploy-\\d+", "regex"),
      k(3, "dep", "contains"),
      k(2, "deploy", "prefix"),
      k(1, "deploy", "exact"),
    ];
    expect(matchKeyword("deploy", kws)?.id).toBe(1); // exact 胜出
    expect(matchKeyword("deploy all", kws)?.id).toBe(2); // prefix 次之
    expect(matchKeyword("xdeployx", kws)?.id).toBe(3); // contains
    expect(matchKeyword("deploy-7", kws)?.id).toBe(2); // exact 不命中，prefix「deploy」命中
  });

  test("同级按创建顺序取第一个", () => {
    const kws = [k(7, "run", "prefix"), k(5, "run", "prefix")];
    expect(matchKeyword("run now", kws)?.id).toBe(7);
  });
});
