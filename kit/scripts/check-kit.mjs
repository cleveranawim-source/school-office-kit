#!/usr/bin/env node
// [키트 관리자용] 키트 안의 번호·이름 참조가 서로 맞는지 본다. make-manifest.mjs 가 먼저 돌린다.
// 함정 번호는 영구 ID라, 문서·모듈 목록·스크립트가 없는 번호를 가리키면 설계 메모에서 조용히 빠진다.
//
//   node kit/scripts/check-kit.mjs     # 문제가 있으면 목록을 보이고 종료 코드 1
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skill = join(root, ".agents", "skills", "school-office");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const problems = [];

// 1. 함정 노트: 번호 → 절, 겹치는 번호
const pitfallFile = "kit/docs/06-함정노트.md";
const pitfallText = read(pitfallFile);
const sectionOf = new Map();
let section = null;
for (const line of pitfallText.split("\n")) {
  const h = line.match(/^## (\d+)\./);
  if (h) section = Number(h[1]);
  else if (/^## /.test(line)) section = null;
  const m = line.match(/^(\d+)\.\s+★/);
  if (!m) continue;
  const n = Number(m[1]);
  if (sectionOf.has(n)) problems.push(`${pitfallFile}: 함정 ${n}번이 두 번 있다`);
  sectionOf.set(n, section);
}
if (!sectionOf.size) problems.push(`${pitfallFile}: 「N. ★」 줄을 하나도 못 읽었다`);
const known = (n, where) => {
  if (!sectionOf.has(n)) problems.push(`${where}: 없는 함정 ${n}번을 가리킨다`);
};

// 2. 머리 표 「단계 → 읽을 절」: 8(70·71~74, 78) 처럼 괄호 안 번호는 그 절에 있어야 한다
const head = pitfallText.split(/\n## 1\./)[0];
for (const row of head.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).slice(1)) {
  const cell = row.split("|")[2] ?? "";
  for (const [, sec, inner] of cell.matchAll(/(\d+)\(([^)]*)\)/g)) {
    for (const part of inner.split(/[·,]\s*/)) {
      const r = part.trim().match(/^(\d+)(?:~(\d+))?$/);
      if (!r) continue;
      const a = Number(r[1]);
      const b = r[2] ? Number(r[2]) : a;
      for (let n = a; n <= b; n++) {
        known(n, `${pitfallFile} 머리 표`);
        if (sectionOf.has(n) && sectionOf.get(n) !== Number(sec))
          problems.push(`${pitfallFile} 머리 표: ${n}번은 ${sec}절이 아니라 ${sectionOf.get(n)}절에 있다`);
      }
    }
  }
}

// 3. 「맨 먼저 챙길 …」 목록 끝의 (번호)
const first = pitfallText.split(/\n## 맨 먼저/)[1] ?? "";
for (const [, inner] of first.matchAll(/\(([\d,~\s]+)\)\s*$/gm)) {
  for (const part of inner.split(",")) {
    const r = part.trim().match(/^(\d+)(?:~(\d+))?$/);
    if (r) for (let n = Number(r[1]); n <= Number(r[2] ?? r[1]); n++) known(n, `${pitfallFile} 맨 먼저 목록`);
  }
}

// 4. 모듈 목록: 함정 번호, requires·uses, 단계, 문서 경로
const catalogFile = ".agents/skills/school-office/references/modules.json";
const catalog = JSON.parse(read(catalogFile));
// uses 는 모듈이 아니라 쓰는 기반(memo.mjs 가 이것마다 주의 줄을 넣는다)
const USES = new Set(["ai", "cron", "push"]);
const ids = new Set();
for (const m of catalog.modules) {
  if (ids.has(m.id)) problems.push(`${catalogFile}: 모듈 id 「${m.id}」가 두 번 있다`);
  ids.add(m.id);
}
for (const m of catalog.modules) {
  for (const n of m.pitfalls ?? []) known(n, `${catalogFile} ${m.id}`);
  for (const r of [...(m.requires ?? []), ...(m.after ?? []), ...(m.touches ?? [])])
    if (!ids.has(r)) problems.push(`${catalogFile} ${m.id}: 없는 모듈 「${r}」를 가리킨다`);
  for (const u of m.uses ?? [])
    if (!USES.has(u)) problems.push(`${catalogFile} ${m.id}: uses 「${u}」는 memo.mjs 가 모른다(${[...USES].join("·")})`);
  if (m.doc && !existsSync(join(root, m.doc.split("#")[0]))) problems.push(`${catalogFile} ${m.id}: 문서 ${m.doc} 가 없다`);
}
for (const s of catalog.stages ?? [])
  for (const id of s.modules) if (!ids.has(id)) problems.push(`${catalogFile} 단계 ${s.n}: 없는 모듈 「${id}」`);

// 5. 스크립트 안의 함정 번호: memo.mjs 기본 목록, gate.mjs 「함정 N」
const memo = readFileSync(join(skill, "scripts", "memo.mjs"), "utf8");
const defaults = memo.match(/isNew \? \[([\d,\s]+)\]/);
if (defaults) for (const n of defaults[1].split(",")) known(Number(n), "memo.mjs 새 모듈 기본 목록");
const gate = readFileSync(join(skill, "scripts", "gate.mjs"), "utf8");
for (const [, n] of gate.matchAll(/함정\s*(\d+)/g)) known(Number(n), "gate.mjs");

// 6. 다른 문서의 「함정 N」·「06 … N번」
for (const rel of ["AGENTS.md", ".agents/skills/school-office/SKILL.md"]) {
  if (!existsSync(join(root, rel))) continue;
  for (const [, n] of read(rel).matchAll(/함정\s*(\d+)\s*번?/g)) known(Number(n), rel);
}

if (problems.length) {
  console.error(`키트 참조 검사: 문제 ${problems.length}개`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`키트 참조 검사 통과 — 함정 ${sectionOf.size}개, 모듈 ${ids.size}개.`);
