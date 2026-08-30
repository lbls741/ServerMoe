// 出站 markdown 预过滤，移植官方 StreamingMarkdownFilter 的规则（M0 审计 §4）：
// - 保留：**粗体**、行内代码、围栏、表格、水平线、> 引用、H1-H4、包裹非 CJK 的斜体标记
// - 剥离：包裹 CJK 的斜体/粗斜体标记（微信渲染差）、H5/H6 标记
// - 有意偏离官方：图片 ![alt](url) 官方整段丢弃，我们转为「🔗 alt：url」文本行，
//   避免 ServerChan desp 中的图片信息静默丢失。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

export function filterForWechat(src: string): string {
  let inFence = false;
  const lines = src.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    let out = line;
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => (alt ? `🔗 ${alt}：${url}` : `🔗 ${url}`));
    out = out.replace(/^#{5,6}[ \t]+/gm, "");
    out = out.replace(/\*\*\*([^*\n]+?)\*\*\*/g, (m, inner: string) => (CJK.test(inner) ? inner : m));
    out = out.replace(/(?<![*\S])\*([^*\n]+?)\*(?!\*)/g, (m, inner: string) => (CJK.test(inner) ? inner : m));
    out = out.replace(/(?<![_\S])_([^_\n]+?)_(?!_)/g, (m, inner: string) => (CJK.test(inner) ? inner : m));
    return out;
  });
  return lines.join("\n");
}
