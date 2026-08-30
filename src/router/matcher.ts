// 关键词匹配引擎。优先级 exact > prefix > contains > regex，同级按注册顺序（创建序）。
// 文本对比大小写不敏感（regex 除外，由作者自行控制）。

export type MatchMode = "exact" | "prefix" | "contains" | "regex";

export interface KeywordLike {
  id: number;
  keyword: string;
  matchMode: MatchMode;
}

const PRIORITY: readonly MatchMode[] = ["exact", "prefix", "contains", "regex"];

function matches(k: KeywordLike, text: string): boolean {
  const t = text.trim();
  switch (k.matchMode) {
    case "exact":
      return t.toLowerCase() === k.keyword.toLowerCase();
    case "prefix":
      return t.toLowerCase().startsWith(k.keyword.toLowerCase());
    case "contains":
      return t.toLowerCase().includes(k.keyword.toLowerCase());
    case "regex":
      try {
        return new RegExp(k.keyword).test(t);
      } catch {
        return false; // 非法正则永不命中（注册时也会被拒绝）
      }
  }
}

/** 返回第一个命中的关键词；无命中返回 null。泛型保留调用方的完整行类型。 */
export function matchKeyword<T extends KeywordLike>(text: string, keywords: T[]): T | null {
  for (const mode of PRIORITY) {
    for (const k of keywords) {
      if (k.matchMode !== mode) continue;
      if (matches(k, text)) return k;
    }
  }
  return null;
}

/** 校验正则关键词的 pattern 可编译。 */
export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
