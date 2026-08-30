// 生成 THIRD-PARTY-NOTICES.md：从 package.json dependencies 出发，
// 遍历 node_modules 中的运行时闭包，收集每个包的名称/版本/许可/主页。
// 用法: bun scripts/list-licenses.mjs [--md]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const rootPkg = JSON.parse(readFileSync("package.json", "utf8"));
const seen = new Map();

function readPkg(dir) {
  const pj = path.join(dir, "package.json");
  if (!existsSync(pj)) return null;
  try {
    return JSON.parse(readFileSync(pj, "utf8"));
  } catch {
    return null;
  }
}

function visit(name) {
  if (seen.has(name)) return;
  const pkgDir = path.join("node_modules", ...name.split("/"));
  const p = readPkg(pkgDir);
  if (!p) {
    seen.set(name, { name, version: "?", license: "NOT FOUND", homepage: "" });
    return;
  }
  seen.set(name, {
    name: p.name ?? name,
    version: p.version ?? "?",
    license: typeof p.license === "string" ? p.license : JSON.stringify(p.license ?? "?"),
    homepage: p.homepage ?? p.repository?.url ?? "",
  });
  for (const dep of Object.keys(p.dependencies ?? {})) visit(dep);
}

for (const dep of Object.keys(rootPkg.dependencies ?? {})) visit(dep);

const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

if (process.argv.includes("--md")) {
  const lines = [
    "# 第三方组件许可声明（THIRD-PARTY-NOTICES）",
    "",
    `本文件列出 ServerMoe 运行时依赖的第三方组件及其许可。`,
    `由 \`scripts/list-licenses.mjs\` 基于锁定版本自动生成（生成日期 ${new Date().toISOString().slice(0, 10)}）。`,
    "",
    "| 组件 | 版本 | 许可 |",
    "|---|---|---|",
    ...rows.map((r) => `| [${r.name}](${r.homepage || "https://www.npmjs.com/package/" + r.name}) | ${r.version} | ${r.license} |`),
    "",
    "以上组件以其自身的许可证条款分发，本仓库按各组件要求保留其版权与许可声明。",
    "npm 包的完整许可文本可在 `node_modules/<组件>/LICENSE` 或其源仓库查阅。",
  ];
  console.log(lines.join("\n"));
} else {
  console.log(JSON.stringify(rows, null, 2));
}
