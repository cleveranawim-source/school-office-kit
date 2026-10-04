#!/usr/bin/env node
// 설계 메모 뼈대 만들기: 그 단계 모듈의 함정 노트 본문·관문을 메모에 그대로 옮긴다.
//
//   node memo.mjs nep --stage 5 --title "업무 요청"            # 화면에 출력
//   node memo.mjs nep --stage 5 --out docs/design/05-nep.md     # 파일로(있으면 멈춤, --force 로 덮어씀)
//   node memo.mjs --new "방과후 신청" --stage 7                  # 카탈로그에 없는 새 모듈
//
// 뼈대일 뿐이다. 빈칸(화면·데이터·권한)은 에이전트가 이 학교에 맞게 채우고 선생님께 확인받는다.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findKitRoot, idHelp, loadCatalog, loadPains, loadPitfalls, parseArgs, splitList, today, unknownIds } from "./lib.mjs";

const catalog = loadCatalog();
const { opts, rest } = parseArgs(process.argv.slice(2));
const ids = rest.flatMap((r) => splitList(r));
const isNew = typeof opts.new === "string";

if (opts.help || (!ids.length && !isNew)) {
  console.log("사용법: node memo.mjs <모듈 id …> [--stage N] [--title 이름] [--out 파일] [--force]\n       node memo.mjs --new \"새 모듈 이름\" [--stage N]\n");
  console.log(idHelp(catalog));
  process.exit(opts.help ? 0 : 2);
}
const bad = unknownIds(ids, catalog);
if (bad.length) {
  console.error(`모르는 모듈 id: ${bad.join(", ")} — 카탈로그에 없는 모듈이면 --new "이름"을 쓰세요.\n\n${idHelp(catalog)}`);
  process.exit(2);
}

const root = findKitRoot();
const pitfalls = loadPitfalls(root);
const pains = loadPains(root);
const mods = ids.map((id) => catalog.byId.get(id));
const title = opts.title || (isNew ? opts.new : mods.map((m) => m.name).join(" · "));
const stage = opts.stage ? `${opts.stage}단계 — ` : "";

// 새 모듈이면 거의 모든 학교에 통하는 기본 함정만.
const pitNums = isNew ? [12, 20, 22, 26, 31, 36, 37] : [...new Set(mods.flatMap((m) => m.pitfalls))].sort((a, b) => a - b);
const checks = isNew ? [] : [...new Set(mods.flatMap((m) => m.checks))];
const uses = new Set(mods.flatMap((m) => m.uses));
const docs = [...new Set(mods.map((m) => m.doc))];

const L = [];
L.push(`# 설계 메모 — ${stage}${title}`, "");
L.push(`> 만든 날: ${today()} · 상태: **초안** → 선생님 확인 → 구현 중 → 관문 통과`);
L.push(`> 모듈: ${isNew ? `(새 모듈) ${opts.new}` : mods.map((m) => `${m.name}(\`${m.id}\`, ${m.tier}·${m.difficulty})`).join(", ")}`);
L.push(`> 참고 문서: ${[...docs, "kit/docs/05-보안기준선.md"].join(", ") || "kit/docs/02-모듈카탈로그.md"}`, "");

L.push("## 1. 덜어 줄 불편", "");
if (!isNew) for (const m of mods) L.push(`- 카탈로그: ${m.pain}`);
if (pains.length) {
  L.push("- 이 학교 선생님 말씀(school-profile.md 4절) — 이번 단계와 이어지는 것만 남기고 지운다:");
  for (const p of pains) L.push(`  - 「${p}」`);
} else {
  L.push("- (school-profile.md 4절이 비어 있음 — 인터뷰에서 받은 불편을 적는다)");
}
L.push("");

L.push("## 2. 화면", "", "> 누가, 어디서(휴대폰/PC), 무엇을 누르는지. 휴대폰 폭 390px 기준으로 먼저 쓴다.", "", "| 화면 | 누가 | 하는 일 |", "|---|---|---|", "| | | |", "");

L.push("## 3. 데이터와 권한", "", "> 표마다 한 줄. 「누가 읽나」가 곧 RLS 정책이고 RLS 테스트의 목록이 된다.", "");
L.push("| 표 | 누가 읽나 | 누가 쓰나 | 얼마나 두나(보존) | 학생 정보 |", "|---|---|---|---|---|", "| | | | | 있음/없음 |", "");
L.push("- 「로그인한 누구나」는 `using (true)` 가 아니라 활성 교직원 확인 함수로.", "- 쓰기 정책이 없으면 서버(시크릿 키)만 쓴다는 뜻 — 그 이유를 한 줄로.", "");

L.push("## 4. 학교마다 다른 것", "");
if (isNew) L.push("- (이 학교에서 쓰는 도구·서식·관행)");
for (const m of mods) L.push(`- ${m.name}: ${m.school_specific}`);
L.push("- 선생님께 받을 것(파일·주소·담당자):", "");

L.push("## 5. 크론·알림·AI", "");
if (!uses.size) L.push("- 없음");
if (uses.has("cron")) L.push("- 크론: 식은 **UTC**(서울 시각을 주석으로), Bearer 비밀 확인, 두 번 불려도 한 번(보내기 전 선점), 결과를 설정 표에. 하루 한 번보다 잦으면 pg_cron.");
if (uses.has("push")) L.push("- 알림: 시험 잠금으로 먼저 1명에게, 활성 계정만, 미리보기 배포에서는 실제 교직원에게 안 감.");
if (uses.has("ai")) L.push("- AI: 도구는 교사 세션(RLS)으로 읽기, 실행은 확인 카드, 학생 이름은 보내지 않기(kit/docs/07-AI도우미.md).");
L.push("");

L.push("## 6. 이번 단계의 함정 (kit/docs/06-함정노트.md 에서 옮김)", "", "> 구현하면서 하나씩 지운다. 해당 없으면 「해당 없음」이라고 적는다.", "");
for (const n of pitNums) {
  const text = pitfalls.get(n);
  L.push(text ? `- [ ] **${n}.** ${text}` : `- [ ] 함정 ${n} (본문을 못 찾음 — kit/docs/06-함정노트.md 확인)`);
}
L.push("");

L.push("## 7. 관문", "", "자동: `node .agents/skills/school-office/scripts/gate.mjs" + (ids.length ? ` --modules ${ids.join(",")}` : "") + "` 에 ❌ 없음", "");
for (const c of [...checks, ...catalog.common_checks]) L.push(`- [ ] ${c}`);
L.push("");

L.push("## 8. 선생님께 확인할 것", "", "> 「이대로 만들까요?」 전에 여기 적은 것만 묻는다(한 번에 세 개까지).", "", "1. ", "");
L.push("## 9. 하지 않을 것 (범위 밖)", "", "- ", "");

const text = L.join("\n");
if (opts.out) {
  const base = root || process.cwd();
  const file = resolve(base, opts.out);
  if (existsSync(file) && !opts.force) {
    console.error(`이미 있습니다: ${file}\n덮어쓰려면 --force 를 붙이세요(선생님과 고친 내용이 사라집니다).`);
    process.exit(1);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text + "\n");
  console.log(`설계 메모를 만들었습니다: ${file}`);
  if (!root) console.log("참고: 키트 저장소 밖이라 함정 노트 본문·선생님 불편이 빠졌을 수 있습니다.");
} else {
  console.log(text);
}
