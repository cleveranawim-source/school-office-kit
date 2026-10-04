#!/usr/bin/env node
// 단계 계획 짜기: 학교가 고른 모듈(중요한 순서)을 받아, 선행 조건을 채우고 단계 순서를 정한다.
//
//   node plan.mjs nep board ai            # 고른 모듈, 앞에 쓴 것이 더 급함
//   node plan.mjs nep --skip home         # 핵심 모듈 중 뺄 것
//   node plan.mjs --list                  # 모듈 id 목록
//   node plan.mjs nep --json              # 기계가 읽는 결과
//
// 결과(마크다운)를 progress.md 「단계 계획」에 붙여 넣고 선생님께 확인받는다.
import { findKitRoot, idHelp, loadCatalog, parseArgs, splitList, today, unknownIds } from "./lib.mjs";

const catalog = loadCatalog();
const { opts, rest } = parseArgs(process.argv.slice(2));

if (opts.list || opts.help) {
  console.log(idHelp(catalog));
  if (opts.help) console.log("\n사용법: node plan.mjs <고른 모듈 id …(급한 순)> [--skip id,id] [--json]");
  process.exit(0);
}

const chosen = rest.flatMap((r) => splitList(r));
const skip = new Set(splitList(opts.skip));
const bad = unknownIds([...chosen, ...skip], catalog);
if (bad.length) {
  console.error(`모르는 모듈 id: ${bad.join(", ")}\n\n${idHelp(catalog)}`);
  process.exit(2);
}
if (skip.has("foundation") || skip.has("auth") || skip.has("admin")) {
  console.error("뼈대(foundation·auth·admin)는 뺄 수 없습니다.");
  process.exit(2);
}

const notes = [];
const baseIds = new Set(catalog.stages.flatMap((s) => s.modules));
const placed = new Set(); // 단계에 이미 들어간 모듈

// 1) 고른 모듈이 기대는 모듈 모두(재귀). 뺀 핵심 모듈이 필요하면 되살린다.
const needed = new Set();
function addNeeds(id, because) {
  for (const r of catalog.byId.get(id).requires) {
    if (skip.has(r)) {
      skip.delete(r);
      notes.push(`되살림: ${name(r)} — 빼셨지만 ${name(because)}에 필요합니다.`);
    }
    if (!needed.has(r)) {
      needed.add(r);
      if (!baseIds.has(r) && !chosen.includes(r)) notes.push(`자동 추가: ${name(r)} — ${name(because)}에 먼저 있어야 합니다.`);
      addNeeds(r, because);
    }
  }
}
for (const id of chosen) addNeeds(id, id);
for (const s of skip) notes.push(`뺌: ${name(s)}`);

// 2) 기본 단계(1~4). 뺀 것은 빼고, 비면 단계를 없앤다.
const stages = [];
for (const s of catalog.stages) {
  const mods = s.modules.filter((m) => !skip.has(m));
  if (!mods.length) continue;
  stages.push({ name: s.name, modules: mods });
  mods.forEach((m) => placed.add(m));
}
const coreCount = stages.length;

// 3) 나머지: 고른 순서를 지키되 requires·after 를 먼저 둔다.
const pending = [...new Set([...chosen, ...needed])].filter((id) => !placed.has(id));
const pendingSet = new Set(pending);
const order = [];
const visiting = new Set();
function place(id) {
  if (placed.has(id) || !pendingSet.has(id)) return;
  if (visiting.has(id)) return; // 순환 방지(after 끼리)
  visiting.add(id);
  const m = catalog.byId.get(id);
  for (const r of [...m.requires, ...(m.after || [])]) {
    const pulled = !placed.has(r) && pendingSet.has(r) && chosen.includes(r) && chosen.includes(id) && chosen.indexOf(r) > chosen.indexOf(id);
    place(r);
    if (pulled) notes.push(`순서 조정: 「${name(r)}」 → 「${name(id)}」 — 뒤의 것이 앞의 것을 쓰므로 앞의 것을 먼저 만듭니다.`);
  }
  visiting.delete(id);
  if (!placed.has(id)) {
    placed.add(id);
    order.push(id);
  }
}
// 고른 순서대로, 자동 추가된 것은 필요한 자리에서 끌려 나온다.
for (const id of [...chosen, ...pending]) place(id);

// 체험학습은 결석 접수와 한 단계로 묶는다(같은 봇).
const extra = [];
for (const id of order) {
  if (id === "trip" && extra.length && extra[extra.length - 1].modules.includes("absence")) {
    extra[extra.length - 1].modules.push("trip");
    extra[extra.length - 1].name += " + 체험학습";
    continue;
  }
  extra.push({ name: catalog.byId.get(id).name, modules: [id] });
}

const all = [...stages.map((s, i) => ({ ...s, n: i + 1 })), ...extra.map((s, i) => ({ ...s, n: coreCount + i + 1 }))];

for (const s of all) {
  const mods = s.modules.map((id) => catalog.byId.get(id));
  s.difficulty = maxDifficulty(mods.map((m) => m.difficulty));
  s.pitfalls = [...new Set(mods.flatMap((m) => m.pitfalls))].sort((a, b) => a - b);
  s.memo = `node .agents/skills/school-office/scripts/memo.mjs ${s.modules.join(" ")} --stage ${s.n} --title "${s.name}"`;
}

const ai = all.some((s) => s.modules.includes("ai"));
if (ai) notes.push("AI 도우미: 비용 주체·월 한도를 0단계에서 정했는지 확인하세요(kit/docs/00-준비물.md).");
if (all.some((s) => s.modules.includes("board"))) notes.push("교실 칠판: 시작 전에 학교 정보 담당과 교실 PC·보안점검 기준을 상의하세요.");
if (all.some((s) => s.modules.some((m) => ["absence", "trip", "record"].includes(m))))
  notes.push("학생 정보를 다루는 모듈이 있습니다: kit/docs/05-보안기준선.md G절(개인정보 줄이기)을 설계 메모에 옮기세요.");

if (opts.json) {
  console.log(JSON.stringify({ date: today(), chosen, stages: all, firstRelease: coreCount, notes }, null, 2));
  process.exit(0);
}

const out = [];
out.push(`## 단계 계획 (plan.mjs, ${today()})`, "");
out.push(`고른 모듈(급한 순): ${chosen.length ? chosen.map(name).join(" → ") : "(아직 없음 — 핵심만)"}`, "");
out.push("| 단계 | 내용 | 모듈 | 난이도 | 상태 | 관문 통과일 |", "|---|---|---|---|---|---|");
out.push("| 0 | 준비 | 계정·합의·비용 한도 | — | | |");
for (const s of all) {
  out.push(`| ${s.n} | ${s.name} | ${s.modules.map(name).join(", ")} | ${s.difficulty} | | |`);
  if (s.n === coreCount) out.push("| ★ | 첫 공개 | 시범 사용자 1주 → 교직원 전체 | — | | |");
}
out.push("");
if (notes.length) out.push("### 계획 메모", "", ...notes.map((n) => `- ${n}`), "");
out.push("### 단계마다 설계 메모 시작하기", "");
for (const s of all) out.push(`- ${s.n}단계: \`${s.memo}\``);
if (!findKitRoot()) out.push("", "> 참고: 키트 저장소(AGENTS.md + kit/docs) 밖에서 실행했습니다. 메모에 함정 노트 본문이 안 들어갈 수 있습니다.");
console.log(out.join("\n"));

function name(id) {
  return catalog.byId.get(id)?.name ?? id;
}
function maxDifficulty(list) {
  const rank = (d) => (d.includes("상") ? 3 : d.includes("중") ? 2 : 1);
  const top = Math.max(...list.map(rank));
  return top === 3 ? "상" : top === 2 ? "중" : "하";
}
