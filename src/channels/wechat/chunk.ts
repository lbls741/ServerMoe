/**
 * 长文本按行边界分块。微信对超长消息会截断（社区实测保守值 ~1800，
 * 官方宿主用 4000），故在行边界切分并追加 (i/n) 序号；单行超限时按字符硬切。
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length <= limit) {
      cur = candidate;
      continue;
    }
    if (cur) {
      chunks.push(cur);
      cur = "";
    }
    if (line.length <= limit) {
      cur = line;
      continue;
    }
    for (let i = 0; i < line.length; i += limit) {
      chunks.push(line.slice(i, i + limit));
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length <= 1) return chunks;
  return chunks.map((c, i) => `${c}\n(${i + 1}/${chunks.length})`);
}
