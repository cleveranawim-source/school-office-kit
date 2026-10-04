#!/usr/bin/env node
// 키트 업데이트 받기: 원본 키트 저장소의 새 판을 가져와, 선생님이 손대지 않은 키트 파일만 바꾼다.
//
//   node kit/scripts/update-kit.mjs            # 미리 보기 — 아무것도 바꾸지 않는다
//   node kit/scripts/update-kit.mjs --apply    # 적용
//   (옵션) --from <저장소 주소나 폴더>  --ref <브랜치>  --allow-dirty
//
// 바꾸는 범위: kit/ · .agents/skills/school-office/ · .claude/skills/school-office/ · AGENTS.md 의 키트 구역.
// 앱 코드, school-profile.md, progress.md, README.md, AGENTS.md 「우리 학교 규칙」은 건드리지 않는다.
// 선생님이 고친 키트 파일은 그대로 두고, 키트 쪽도 바뀌었으면 새 판을 「파일.kit-new」로 옆에 둔다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_KEY, agentsBlock, hashAgents, hashBuf, hashFile, isManagedPath, replaceAgentsBlock } from "./kit-files.mjs";

const DEFAULT_FROM = "https://github.com/cleveranawim-source/school-office-kit.git";
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const apply = args.includes("--apply");
const allowDirty = args.includes("--allow-dirty");
let from = opt("from") || DEFAULT_FROM;
const ref = opt("ref") || "main";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: ["ignore", "pipe", "pipe"] });
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

try {
  git("rev-parse", "--is-inside-work-tree");
} catch {
  fail("git 저장소가 아닙니다. 이 폴더가 키트로 만든 저장소인지 확인하세요.");
}

const dirty = git("status", "--porcelain").toString().trim();
if (dirty && apply && !allowDirty) {
  fail("커밋하지 않은 변경이 있습니다. 먼저 지금 작업을 커밋한 뒤 업데이트하세요(되돌리기 쉽게).\n  git add -A && git commit -m \"키트 업데이트 전 저장\"");
}

// 원본 가져오기 — 폴더 경로면 file:// 로
if (existsSync(from) && !/^[a-z]+:\/\//.test(from)) from = "file://" + resolve(from);
try {
  git("fetch", "--quiet", "--depth", "1", from, ref);
} catch (e) {
  fail(`원본 키트를 가져오지 못했습니다(${from} ${ref}). 인터넷 연결이나 주소를 확인하세요.\n${String(e.stderr || e.message).trim().split("\n").slice(-2).join("\n")}`);
}
const remoteSha = git("rev-parse", "FETCH_HEAD").toString().trim();
const show = (path) => {
  try {
    return git("show", `${remoteSha}:${path}`);
  } catch {
    return null;
  }
};

const remoteManifestBuf = show("kit/MANIFEST.json");
if (!remoteManifestBuf) fail("원본 키트에 kit/MANIFEST.json 이 없습니다 — 업데이트를 지원하지 않는 판입니다.");
const remote = JSON.parse(remoteManifestBuf.toString("utf8"));
let local = { version: "(모름)", files: {} };
try {
  local = JSON.parse(readFileSync(join(root, "kit", "MANIFEST.json"), "utf8"));
} catch {}
const remoteAgentsText = show("AGENTS.md")?.toString("utf8") ?? null;
const remoteBlock = agentsBlock(remoteAgentsText);

// 파일마다 판정
const keys = [...new Set([...Object.keys(local.files || {}), ...Object.keys(remote.files || {})])].filter(isManagedPath).sort();
const plan = { add: [], update: [], remove: [], keep: [], conflict: [] };
for (const k of keys) {
  const base = local.files?.[k] ?? null;
  const theirs = remote.files?.[k] ?? null;
  const mine = k === AGENTS_KEY ? hashAgents(root) : hashFile(root, k);
  if (mine === theirs) continue; // 이미 같음
  const untouched = mine === base;
  if (untouched) {
    if (theirs == null) plan.remove.push(k);
    else if (mine == null) plan.add.push(k);
    else plan.update.push(k);
  } else if (theirs === base || theirs == null) {
    plan.keep.push(k); // 선생님이 고쳤고 키트는 그대로(또는 키트에서 빠짐) — 선생님 것을 둔다
  } else {
    plan.conflict.push(k); // 둘 다 바뀜 — 새 판을 .kit-new 로
  }
}

// 바뀐 점(CHANGELOG)
const changelog = show("kit/CHANGELOG.md")?.toString("utf8") ?? "";
const newer = [];
for (const sec of changelog.split(/\n(?=## )/).filter((s) => s.startsWith("## "))) {
  const v = sec.match(/^## \[?([^\]\s]+)/)?.[1];
  if (!v || v === local.version) break;
  newer.push(sec.trim());
}

const name = (k) => (k === AGENTS_KEY ? "AGENTS.md (키트 구역)" : k);
const L = [];
L.push(`키트 업데이트 ${apply ? "적용" : "미리 보기"} — 지금 판 ${local.version} → 새 판 ${remote.version}`);
const total = plan.add.length + plan.update.length + plan.remove.length + plan.conflict.length;
if (!total) {
  L.push("", "이미 최신입니다. 바꿀 것이 없습니다.");
  if (plan.keep.length) L.push(`(선생님이 고친 키트 파일 ${plan.keep.length}개는 그대로 둡니다: ${plan.keep.map(name).join(", ")})`);
  console.log(L.join("\n"));
  process.exit(0);
}
if (newer.length) L.push("", "■ 새 판에서 바뀐 점", ...newer.map((s) => s.replace(/^/gm, "  ")));
const list = (head, arr, note = "") => {
  if (!arr.length) return;
  L.push("", `${head} (${arr.length})${note}`);
  arr.slice(0, 40).forEach((k) => L.push(`  - ${name(k)}`));
  if (arr.length > 40) L.push(`  … 외 ${arr.length - 40}개`);
};
list("＋ 새로 생김", plan.add);
list("↻ 새 판으로 바뀜", plan.update);
list("－ 키트에서 빠짐(지움)", plan.remove);
list("= 선생님이 고친 파일 — 그대로 둠", plan.keep, " · 키트 쪽은 바뀌지 않았습니다");
list("⚠ 둘 다 바뀜 — 새 판을 「.kit-new」로 옆에 둠", plan.conflict, " · 선생님이 고친 내용을 살려 합쳐야 합니다");

if (!apply) {
  if (dirty) L.push("", "※ 커밋하지 않은 변경이 있습니다. 적용 전에 먼저 커밋하세요.");
  L.push("", "적용하려면: node kit/scripts/update-kit.mjs --apply");
  console.log(L.join("\n"));
  process.exit(0);
}

// 적용
const write = (k, buf) => {
  const p = join(root, k);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
};
for (const k of [...plan.add, ...plan.update]) {
  if (k === AGENTS_KEY) {
    const p = join(root, "AGENTS.md");
    const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
    const next = cur == null ? remoteAgentsText : replaceAgentsBlock(cur, remoteBlock);
    writeFileSync(p, next ?? remoteAgentsText);
    continue;
  }
  const buf = show(k);
  if (buf && hashBuf(buf) === remote.files[k]) write(k, buf);
  else fail(`원본에서 ${k} 를 제대로 읽지 못했습니다. 아무것도 커밋하지 말고 다시 시도하세요(git checkout -- . 로 되돌릴 수 있음).`);
}
for (const k of plan.remove) {
  if (k === AGENTS_KEY) continue; // 구역을 지우지는 않는다
  rmSync(join(root, k), { force: true });
}
for (const k of plan.conflict) {
  if (k === AGENTS_KEY) {
    if (remoteBlock) writeFileSync(join(root, "AGENTS.md.kit-new"), remoteBlock + "\n");
    continue;
  }
  const buf = show(k);
  if (buf) write(k + ".kit-new", buf);
}
writeFileSync(join(root, "kit", "MANIFEST.json"), remoteManifestBuf);

L.push("", "적용했습니다. 다음 순서:");
L.push("  1. git diff 로 바뀐 것을 훑어봅니다.");
if (plan.conflict.length) L.push("  2. 「.kit-new」 파일마다 지금 파일과 비교해, 선생님이 고친 내용을 살려 합친 뒤 .kit-new 는 지웁니다.");
L.push(`  ${plan.conflict.length ? 3 : 2}. node .agents/skills/school-office/scripts/gate.mjs 로 관문 검사를 다시 돌립니다.`);
L.push(`  ${plan.conflict.length ? 4 : 3}. 커밋: git add -A && git commit -m "키트 업데이트 ${local.version} → ${remote.version}"`);
console.log(L.join("\n"));
