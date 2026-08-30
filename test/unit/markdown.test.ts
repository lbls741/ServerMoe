import { describe, expect, test } from "bun:test";
import { filterForWechat } from "../../src/channels/wechat/markdown.ts";

describe("filterForWechat（官方 markdown-filter 规则移植）", () => {
  test("粗体标记永远保留", () => {
    expect(filterForWechat("**构建成功**")).toBe("**构建成功**");
    expect(filterForWechat("**bold text**")).toBe("**bold text**");
  });

  test("包裹 CJK 的斜体剥离标记", () => {
    expect(filterForWechat("*斜体内容*")).toBe("斜体内容");
    expect(filterForWechat("_下划斜体_")).toBe("下划斜体");
    expect(filterForWechat("***粗斜体***")).toBe("粗斜体");
  });

  test("包裹非 CJK 的斜体保留标记", () => {
    expect(filterForWechat("*italic*")).toBe("*italic*");
    expect(filterForWechat("_em_")).toBe("_em_");
  });

  test("H5/H6 剥离标记，H1-H4 保留", () => {
    expect(filterForWechat("##### 小标题")).toBe("小标题");
    expect(filterForWechat("###### 小标题")).toBe("小标题");
    expect(filterForWechat("#### 四级标题")).toBe("#### 四级标题");
    expect(filterForWechat("# 一级")).toBe("# 一级");
  });

  test("图片转文本链接行（有意偏离官方：不静默丢弃）", () => {
    expect(filterForWechat("![截图](https://example.com/a.png)")).toBe("🔗 截图：https://example.com/a.png");
    expect(filterForWechat("![](https://example.com/b.png)")).toBe("🔗 https://example.com/b.png");
  });

  test("代码围栏内不做任何转换", () => {
    const src = "```\n*斜体* 和 ![img](https://x.com/i.png)\n##### 伪标题\n```";
    expect(filterForWechat(src)).toBe(src);
  });

  test("表格/水平线/引用原样保留", () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n> 引用";
    expect(filterForWechat(src)).toBe(src);
  });
});
