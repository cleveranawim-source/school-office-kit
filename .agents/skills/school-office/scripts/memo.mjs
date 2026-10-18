#!/usr/bin/env node
// 설계 메모 뼈대 만들기: 그 단계 모듈의 함정 노트 본문·관문을 메모에 그대로 옮긴다.
//
//   node memo.mjs nep --stage 5 --title "넵"                   # 화면에 출력
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
const pitNums = isNew ? [12, 20, 22, 26, 31, 36, 37, 92, 93, 114] : [...new Set(mods.flatMap((m) => m.pitfalls))].sort((a, b) => a - b);
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

L.push("## 5. 크론·알림·AI·함께 손볼 곳", "");
if (!uses.size) L.push("- 크론·알림·AI 호출: 없음");
if (uses.has("cron")) L.push("- 크론: 식은 **UTC**(서울 시각을 주석으로), Bearer 비밀 확인, 두 번 불려도 한 번(보내기 전 선점), 결과를 설정 표에. 하루 한 번보다 잦으면 pg_cron, 1분마다면 이미 있는 1분 틱에 얹는다(kit/docs/04-뼈대설계.md 5절).");
if (uses.has("push")) L.push("- 알림: 시험 잠금으로 먼저 1명에게, 활성 계정만, 미리보기 배포에서는 실제 교직원에게 안 감.");
if (uses.has("ai")) L.push("- AI 호출(이 모듈이 직접 부른다면): 실패하거나 늦어도 본 기능은 AI 없이 돌게 하고, 학생 이름은 보내지 않는다. 모델 급(대화·매일 도는 일·무거운 질문)을 정한다(kit/docs/07-AI도우미.md 7·11절).");
// touches: 이 모듈을 만들 때 함께 고칠, 이미 있는 모듈. 아직 없는 모듈은 건너뛴다.
// 힌트는 「만드는 모듈>손볼 모듈」 짝이 TOUCH_HINT_BY 에 있으면 그것을, 없으면 손볼 모듈의 기본 힌트를 쓴다.
const TOUCH_HINT = {
  home: "홈에 카드나 숫자 칸을 더한다(숫자는 눌러서 나오는 화면과 같은 함수로)",
  today: "현황판에 칸을 더한다(사유·이름은 싣지 않는다)",
  calendar: "내 일정에 나에게만 겹쳐 보이게 한다(학사일정 표에는 넣지 않는다)",
  ai: "AI 도우미에 읽기 도구나 확인 카드를 더한다(교사 세션으로 읽고, 카드 단추는 이 기능 화면과 같은 검사 함수로)",
  notices: "공지 화면에 이 모듈의 결과를 잇는다",
  push: "아침·점심 알림에 이 모듈의 줄을 더한다(여러 사람이 보는 요약에는 사유를 싣지 않는다)",
  dayplan: "그날 시간표에 이 모듈의 결과를 얹는다(시간표·홈·진도표가 함께 바뀐다)",
  timetable: "시간표 칸에 표시를 더한다",
  board: "교실 칠판 쪽지·띠를 더한다(이름표는 서버만, 학생이 본다)",
};
const TOUCH_HINT_BY = {
  "push>notices": "공지를 올리면 전체 푸시가 가게 잇는다(시험 잠금으로 먼저 1명)",
  "dayplan>timetable": "시간표 화면이 그날 시간표 함수를 쓰게 바꾼다(수업 시간과 겹치는 일정은 칸에 띠로)",
  "dayplan>home": "홈 「수업 N시간」·오늘 시간표 카드가 그날 시간표 함수를 쓰게 바꾼다",
  "today>notices": "공지 메뉴를 현황판 맨 위 「공지판」으로 옮긴다(고정 + 올린 지 하루 안, 관리자는 거기서 공지 쓰기)",
  "today>home": "홈의 공지 칸을 「오늘 알림」 한 칸으로 합치고, 숫자 칸 「현황판」은 현황판과 같은 함수로 센다",
  "nep>home": "홈에 「처리할 넵 N건」·오늘 마감 넵을 더한다(숫자는 넵 목록과 같은 함수로)",
  "nep>today": "현황판에 「내 넵」 칸(넵 마감 + 넵 속 일정)을 더한다 — 보낸 분과 배달된 받는 분에게만",
  "nep>push": "아침·점심 알림 「내 줄」에 오늘 마감 넵을 더한다",
  "nep>ai": "AI 넵 읽기 도구와 넵 초안 확인 카드를 더한다(카드는 넵 보내기 흐름 하나를 그대로 부르고, AI가 바로 보내지 않는다)",
  "weekly>today": "현황판 「특별 일정」에 발행된 소식의 날짜별 항목을 붙인다(같은 일정은 한 번만)",
  "weekly>dayplan": "그날 시간표의 수업 칸·홈 오늘 시간표에 발행된 소식 항목을 띠로 붙인다",
  "swap>dayplan": "그날 시간표에 수락이 끝난 교체를 얹는다(기다리는 교체는 얹지 않는다 — 시간표·홈·진도표가 함께 바뀐다)",
  "swap>today": "현황판 「바뀐 수업」 칸을 채운다 — 반·교시·과목만, 사유·선생님 이름은 뷰에서도 뺀다",
  "swap>home": "홈에 맡아 준 수업과 내 교체 사유를 보인다(사유는 본인 것만)",
  "swap>calendar": "내 교체 사유·맡은 수업을 내 일정에만 겹쳐 보인다(학사일정 표에는 넣지 않는다)",
  "swap>board": "교실 칠판 아침 쪽지 「오늘 바뀐 수업」을 더한다(수락이 끝난 것만, 이름표는 서버만)",
  "swap>ai": "AI 교체 계산 도구가 교체 화면과 같은 함수를 부르게 한다",
  "lostfound>board": "학생용 보기를 켤 때만 교실 칠판에 분실물 띠를 더한다(허용한 칸만)",
  "lostfound>ai": "AI 「함에 넣어 줘」 확인 카드를 더한다(넣기 화면과 같은 칸 검사)",
  "sports>home": "홈에 오늘 경기·결과 카드를 더한다(반 이름만, 학생 이름 없이)",
  "sports>today": "현황판에 오늘 경기·결과 카드를 더한다(반 이름만)",
};
const touchHints = new Map(); // 손볼 모듈 id → 힌트(처음 나온 짝을 쓴다)
for (const m of mods)
  for (const t of m.touches || [])
    if (!ids.includes(t) && !touchHints.has(t)) touchHints.set(t, TOUCH_HINT_BY[`${m.id}>${t}`] ?? TOUCH_HINT[t] ?? "이 모듈의 결과를 그 화면에도 보인다");
const touchedBy = catalog.modules.filter((m) => !ids.includes(m.id) && (m.touches || []).some((t) => ids.includes(t)));
if (touchHints.size) {
  L.push("- 함께 손볼 곳(이미 만든 것만 — 없으면 「해당 없음」):");
  for (const [t, hint] of touchHints) L.push(`  - [ ] ${catalog.byId.get(t)?.name ?? t}: ${hint}`);
}
if (touchedBy.length) L.push(`- 이 모듈에 줄·칸·도구를 더하는 모듈: ${touchedBy.map((m) => m.name).join(", ")} — 이미 만들었으면 지금 잇고, 아직이면 그 모듈을 만들 때 잇는다(자리만 비워 둔다).`);
L.push("");

L.push("## 6. 이번 단계의 함정 (kit/docs/06-함정노트.md 에서 옮김)", "", "> 구현하면서 하나씩 지운다. 해당 없으면 「해당 없음」이라고 적는다.", "");
if (!pitNums.length) L.push("- (카탈로그에 이 모듈 함정이 없다 — 7절 공통 관문을 지키고, 비슷한 모듈의 함정을 훑어본다)");
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
