#!/usr/bin/env node
// 스킬 정본(.agents/skills, Codex가 읽음)을 Claude Code 자리(.claude/skills)로 복사한다.
// 스킬을 고쳤으면 정본만 고치고 이것을 돌린다. 윈도우에서 git 심볼릭 링크가 깨지기 쉬워 복사 방식이다.
//
//   node kit/scripts/sync-skills.mjs          # 복사
//   node kit/scripts/sync-skills.mjs --check  # 다르면 종료 코드 1(복사하지 않음)
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(root, ".agents", "skills");
const dst = join(root, ".claude", "skills");
const check = process.argv.includes("--check");

const list = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
};

const skills = readdirSync(src).filter((n) => statSync(join(src, n)).isDirectory());
let diff = [];
for (const name of skills) {
  const a = list(join(src, name));
  const b = list(join(dst, name));
  const all = new Set([...a, ...b]);
  for (const f of all) {
    const pa = join(src, name, f);
    const pb = join(dst, name, f);
    if (!existsSync(pa) || !existsSync(pb) || !readFileSync(pa).equals(readFileSync(pb))) diff.push(`${name}/${f}`);
  }
}

if (check) {
  if (diff.length) {
    console.error(`.claude/skills 가 정본과 다릅니다(${diff.length}개): ${diff.slice(0, 10).join(", ")}\n→ node kit/scripts/sync-skills.mjs`);
    process.exit(1);
  }
  console.log("스킬 사본이 정본과 같습니다.");
  process.exit(0);
}

for (const name of skills) {
  rmSync(join(dst, name), { recursive: true, force: true });
  cpSync(join(src, name), join(dst, name), { recursive: true });
}
console.log(`복사함: ${skills.join(", ")} → .claude/skills/ (바뀐 파일 ${diff.length}개)`);
