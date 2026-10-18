#!/usr/bin/env node
// 관문 검사: 코드만 보고 알 수 있는 보안·함정을 자동으로 찾는다. 네트워크·DB에 접속하지 않는다.
//
//   node gate.mjs                         # 저장소 전체
//   node gate.mjs --modules nep,push      # + 그 모듈의 「손으로 확인할 것」 목록
//   node gate.mjs --root ../다른-저장소   # 다른 폴더 검사
//   node gate.mjs --json
//
// ❌ 막힘이 하나라도 있으면 종료 코드 1. 찾은 비밀 값 자체는 절대 출력하지 않는다(위치와 종류만).
// 기준 문서: kit/docs/05-보안기준선.md(절 이름은 「05 B절」처럼 적는다), kit/docs/06-함정노트.md(「함정 20」처럼 번호).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { findKitRoot, loadCatalog, parseArgs, splitList, today, unknownIds } from "./lib.mjs";

const { opts } = parseArgs(process.argv.slice(2));
const root = resolve(opts.root || findKitRoot() || process.cwd());
const catalog = loadCatalog();
const modIds = splitList(opts.modules);
const badIds = unknownIds(modIds, catalog);
if (badIds.length) {
  console.error(`모르는 모듈 id: ${badIds.join(", ")}`);
  process.exit(2);
}

const results = [];
const add = (level, area, msg, where = [], hint = "") => results.push({ level, area, msg, where, hint });

// ───────────── 파일 목록 ─────────────
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".vercel", "dist", "build", "out", "coverage", ".turbo", ".cache"]);
const SCAN_SKIP = [".agents/skills/", ".claude/skills/", "kit/", ".claude/"]; // 키트 자신·작업 사본은 비밀 검사에서 뺀다
const LOCKS = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

let isGit = false;
let files = [];
try {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdio: ["ignore", "pipe", "ignore"] });
  files = out.toString("utf8").split("\0").filter(Boolean);
  isGit = true;
} catch {
  files = walk(root);
}
const tracked = isGit ? new Set(gitTracked()) : null;

function gitTracked() {
  try {
    return execFileSync("git", ["-C", root, "ls-files", "-z"], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(relative(root, p).split("\\").join("/"));
  }
  return acc;
}
const cache = new Map();
function text(rel) {
  if (cache.has(rel)) return cache.get(rel);
  let t = null;
  try {
    const p = join(root, rel);
    const st = statSync(p);
    if (st.size <= 1_500_000) {
      const buf = readFileSync(p);
      if (!buf.subarray(0, 8000).includes(0)) t = buf.toString("utf8");
    }
  } catch {}
  cache.set(rel, t);
  return t;
}
const has = (rel) => existsSync(join(root, rel));
const isCode = (f) => CODE_EXT.has(extname(f));
const isTest = (f) => /(^|\/)(tests?|__tests__|e2e|evals?)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
const inApp = (f) => /^(src\/)?(app|lib|components|pages|utils|hooks|server)\//.test(f);
const scanFiles = files.filter((f) => !SCAN_SKIP.some((p) => f.startsWith(p)) && !LOCKS.has(basename(f)) && !SKIP_DIRS.has(f.split("/")[0]));
const codeFiles = scanFiles.filter(isCode);
const appCode = codeFiles.filter((f) => inApp(f) && !isTest(f));
const lineOf = (t, idx) => t.slice(0, idx).split("\n").length;
const firstExisting = (...names) => names.find((n) => has(n) && statSync(join(root, n)).isFile()) || null;
const proxyFile = firstExisting("proxy.ts", "proxy.js", "src/proxy.ts", "src/proxy.js");
const middlewareFile = firstExisting("middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js");
const gateFile = proxyFile || middlewareFile;

const hasApp = has("package.json");
if (!isGit) add("warn", "git", "git 저장소가 아닙니다 — 커밋된 파일 대신 폴더 전체를 검사했습니다.", [], "`git init` 후 첫 커밋 전에 다시 돌리세요.");

// ───────────── A. 비밀 값 ─────────────
{
  const gi = text(".gitignore");
  if (!gi) add("fail", "비밀 값", ".gitignore 가 없습니다.", [], "`.env*`(견본 `.env.example` 은 예외), `out/` 을 넣으세요.");
  else if (!gi.split("\n").some((l) => /^\s*[^#]*\.env|^\s*\*\.local\b/.test(l))) add("fail", "비밀 값", ".gitignore 에 .env 파일이 빠져 있습니다.", [".gitignore"], "`.env*` 와 `!.env.example` 두 줄을 넣으세요.");
  else add("pass", "비밀 값", ".gitignore 에 .env");

  const envTracked = (tracked ? [...tracked] : files).filter((f) => /^\.env(\..+)?$/.test(basename(f)) && !/\.(example|sample|template)$/.test(f));
  if (envTracked.length) add("fail", "비밀 값", tracked ? ".env 파일이 git 에 올라가 있습니다." : ".env 파일이 있습니다(git 이 아니라 올라갔는지는 모름).", envTracked, "`git rm --cached <파일>` 로 빼고, 이미 푸시했다면 그 안의 키를 모두 새로 발급하세요.");
  else add("pass", "비밀 값", "git 에 .env 없음");

  const PATTERNS = [
    ["Supabase 시크릿 키", /sb_secret_[A-Za-z0-9_-]{16,}/],
    ["Anthropic API 키", /sk-ant-[A-Za-z0-9_-]{20,}/],
    ["OpenAI API 키", /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
    ["개인 키(PEM)", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["구글 OAuth 클라이언트 비밀", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
    ["구글 refresh token", /\b1\/\/0[A-Za-z0-9_-]{30,}/],
    ["GitHub 토큰", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ];
  const FAKE = /test|fake|dummy|example|sample|xxxx|placeholder|your[-_]?key/i; // 테스트용 가짜 키는 비밀이 아니다
  const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
  // 구글 열쇠 JSON(authorized_user·서비스 계정)처럼 「"이름": "값"」으로 적힌 비밀.
  const JSON_SECRET = /"(client_secret|refresh_token|private_key)"\s*:\s*"([^"]{12,})"/;
  // 이름이 비밀처럼 보이는 환경변수에 값이 적혀 있는가(`*_KEY` 포함). 공개용 키 이름은 뺀다.
  const ASSIGN = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|PRIVATE|PASSWORD|TOKEN|_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^"'\s#,]+)/;
  const PUBLIC_NAME = /PUBLIC|PUBLISHABLE|ANON/;
  const PLACEHOLDER = /^(process\.|import\.|\$|<|\{|\[|your|xxx|change|example|placeholder|todo|\.\.\.|none|null|undefined|true|false)/i;
  const CONFIG_EXT = new Set([".toml", ".yaml", ".yml", ".json", ".sh", ".ini", ".cfg", ".conf", ".txt", ".md", ""]);
  const found = [];
  const exampleVals = [];
  for (const f of scanFiles) {
    const t = text(f);
    if (!t) continue;
    const lines = t.split("\n");
    const isEnvLike = basename(f).startsWith(".env") || CONFIG_EXT.has(extname(f));
    const isExample = /\.(example|sample|template)$/.test(f);
    lines.forEach((line, i) => {
      for (const [kind, re] of PATTERNS) {
        const m = line.match(re);
        if (m && !FAKE.test(m[0])) return found.push(`${f}:${i + 1} (${kind})`);
      }
      for (const m of line.matchAll(JWT)) {
        try {
          const payload = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
          if (/"role"\s*:\s*"service_role"/.test(payload)) return found.push(`${f}:${i + 1} (Supabase service_role 키)`);
        } catch {}
      }
      const j = line.match(JSON_SECRET);
      if (j && !FAKE.test(j[2]) && !PLACEHOLDER.test(j[2])) return (isExample ? exampleVals : found).push(`${f}:${i + 1} (JSON ${j[1]})`);
      if (isEnvLike) {
        const a = line.match(ASSIGN);
        if (a && !PUBLIC_NAME.test(a[1]) && a[2].length >= 12 && !PLACEHOLDER.test(a[2]) && !FAKE.test(a[2])) (isExample ? exampleVals : found).push(`${f}:${i + 1} (${a[1]} 에 값)`);
      }
    });
  }
  if (found.length) add("fail", "비밀 값", "코드·문서에 비밀 값으로 보이는 것이 있습니다(값은 출력하지 않음).", found, "그 자리에서 지우고 `.env.local` 로 옮기세요(구글 열쇠 JSON 같은 파일은 저장소 밖에). 이미 커밋·푸시했다면 그 키를 새로 발급(회전)해야 합니다 — 기록에 남아 있습니다.");
  else add("pass", "비밀 값", "코드에 비밀 값 없음");
  if (exampleVals.length) add("warn", "비밀 값", "환경변수 견본에 실제 값처럼 보이는 것이 있습니다.", exampleVals, "견본은 이름만 두고 값은 비우세요.");
}

if (!hasApp) {
  add("info", "단계", "아직 앱 코드(package.json)가 없습니다 — 0단계 검사(비밀 값)만 했습니다.");
} else {
  // ───────────── B. 키 다루기 ─────────────
  {
    const pub = new Map();
    for (const f of [...codeFiles, ".env.example"].filter((f) => text(f))) {
      for (const m of text(f).matchAll(/NEXT_PUBLIC_([A-Z0-9_]+)/g)) {
        const n = m[1];
        const bad = /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD/.test(n) || (/KEY|TOKEN/.test(n) && !/PUBLISHABLE|PUBLIC|ANON|VAPID_PUBLIC|SITE_KEY|MEASUREMENT/.test(n));
        if (bad && !pub.has(n)) pub.set(n, `${f}:${lineOf(text(f), m.index)} (NEXT_PUBLIC_${n})`);
      }
    }
    if (pub.size) add("fail", "키 다루기", "비밀로 보이는 환경변수에 NEXT_PUBLIC_ 이 붙어 있습니다 — 브라우저로 그대로 나갑니다.", [...pub.values()], "이름에서 NEXT_PUBLIC_ 을 빼고 서버에서만 읽으세요. 이미 배포했다면 키를 새로 발급하세요.");
    else add("pass", "키 다루기", "NEXT_PUBLIC_ 에 비밀 없음");

    const clientUse = [];
    const noServerOnly = [];
    for (const f of appCode) {
      const t = text(f);
      if (!t || !/SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|service_role/.test(t)) continue;
      if (/^\s*["']use client["']/m.test(t.slice(0, 300))) clientUse.push(f);
      else if (!/["']server-only["']/.test(t)) noServerOnly.push(f);
    }
    if (clientUse.length) add("fail", "키 다루기", "브라우저 코드(\"use client\")에서 시크릿 키를 씁니다.", clientUse, "시크릿 키는 서버 액션·API·크론에서만.");
    if (noServerOnly.length) add("warn", "키 다루기", "시크릿 키를 쓰는 파일에 `import \"server-only\"` 가 없습니다.", noServerOnly, "맨 위에 `import \"server-only\";` 를 넣으면 실수로 브라우저 코드에 섞였을 때 빌드가 막아 줍니다.");
    if (!clientUse.length && !noServerOnly.length) add("pass", "키 다루기", "시크릿 키는 서버 전용 파일에서만");
  }

  // ───────────── C. 데이터베이스 ─────────────
  const migDir = ["supabase/migrations", "migrations", "db/migrations"].find((d) => has(d));
  if (migDir) checkMigrations(migDir);
  else add("info", "데이터베이스", "마이그레이션 폴더(supabase/migrations)가 없어 권한 검사를 건너뛰었습니다.");

  {
    const toml = text("supabase/config.toml");
    if (toml) {
      let sec = "";
      for (const line of toml.split("\n")) {
        const h = line.match(/^\s*\[([^\]]+)\]/);
        if (h) sec = h[1].trim();
        else if (sec === "auth" && /^\s*enable_signup\s*=\s*true/.test(line)) {
          add("info", "데이터베이스", "로컬 설정(supabase/config.toml)은 공개 가입 허용입니다. 운영은 대시보드 설정을 따르므로 손으로 확인하세요.", ["supabase/config.toml"]);
          break;
        }
      }
    }
  }

  // ───────────── D. 서버 코드 ─────────────
  checkServerCode();

  // ───────────── E. 배포·크론·헤더 ─────────────
  {
    const vj = text("vercel.json");
    let vercel = null;
    try {
      vercel = vj ? JSON.parse(vj) : null;
    } catch {
      add("fail", "배포", "vercel.json 을 읽을 수 없습니다(JSON 오류).", ["vercel.json"]);
    }
    if (!vercel || !(vercel.regions || []).includes("icn1")) add("warn", "배포", "Vercel 함수 지역이 서울(icn1)로 정해져 있지 않습니다.", vj ? ["vercel.json"] : [], "vercel.json 에 `\"regions\": [\"icn1\"]` (함정 34).");
    else add("pass", "배포", "Vercel 서울 지역");
    const frequent = (vercel?.crons || []).filter((c) => {
      const [mi, hr] = String(c.schedule || "").trim().split(/\s+/);
      return !/^\d+$/.test(mi || "") || !/^\d+$/.test(hr || "");
    });
    if (frequent.length) add("warn", "배포", "Vercel 크론에 하루 한 번보다 잦은 일정이 있습니다 — 무료(Hobby) 요금제에서는 배포가 실패합니다.", frequent.map((c) => `${c.path} ${c.schedule}`), "잦은 일은 Supabase pg_cron 으로(함정 14, kit/docs/04-뼈대설계.md 크론).");

    const cronRoutes = codeFiles.filter((f) => /^(src\/)?app\/api\/cron\/.+\/route\.[cm]?[jt]sx?$/.test(f));
    const unguarded = [];
    const noEmptyCheck = [];
    for (const f of cronRoutes) {
      const g = findUp(f, (t) => /CRON_SECRET/.test(t), 2);
      if (!g) unguarded.push(f);
      else if (!/!\s*(?:process\.env\.CRON_SECRET|[A-Za-z_]*[sS]ecret[A-Za-z_]*)\b(?!\s*\()/.test(text(g) || "")) noEmptyCheck.push(g === f ? f : `${f} (${g})`);
    }
    if (unguarded.length) add("warn", "배포", "크론 주소에서 CRON_SECRET 확인이 안 보입니다.", unguarded, "공통 껍데기에서 `Authorization: Bearer` 를 확인하고, 비밀이 비어 있으면 거부(함정 28, 04 크론).");
    if (noEmptyCheck.length) add("warn", "배포", "크론 비밀이 비어 있을 때 거부하는 줄이 안 보입니다 — 비밀이 없으면 `Bearer undefined` 로 누구나 통과합니다.", [...new Set(noEmptyCheck)], "`if (!secret || !secretEquals(auth, `Bearer ${secret}`)) return 401` 모양으로(함정 28, 05 C절).");
    if (cronRoutes.length && !unguarded.length && !noEmptyCheck.length) add("pass", "배포", `크론 주소 ${cronRoutes.length}곳 비밀 확인`);

    // 보안 헤더·CSP
    const nc = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"].find(has);
    const nct = nc ? text(nc) || "" : "";
    const headerSrc = [nc, gateFile, "vercel.json", ...appCode.filter((f) => /(^|\/)(security|headers?|csp)[^/]*\.[cm]?[jt]sx?$|\/security\//.test(f))].filter(Boolean);
    const headerText = headerSrc.map((f) => text(f) || "").join("\n");
    if (nc || gateFile) {
      const need = [
        ["X-Content-Type-Options", /X-Content-Type-Options/i],
        ["Referrer-Policy", /Referrer-Policy/i],
        ["Permissions-Policy", /Permissions-Policy/i],
        ["X-Frame-Options 또는 frame-ancestors", /X-Frame-Options|frame-ancestors/i],
      ].filter(([, re]) => !re.test(headerText));
      if (need.length) add("warn", "헤더", "빠진 보안 헤더가 있습니다.", need.map(([n]) => n), "kit/docs/05-보안기준선.md C절. 교실 칠판처럼 다른 기기가 감싸야 하는 경로만 감싸기 막기에서 뺍니다.");
      else add("pass", "헤더", "기본 보안 헤더");
      if (!/content-security-policy/i.test(headerText)) add("warn", "헤더", "스크립트 출처를 묶는 CSP 가 보이지 않습니다.", headerSrc.slice(0, 2), "proxy 에서 요청마다 nonce 를 만들어 Report-Only 로 시작하고, 위반이 없으면 막는 쪽으로 바꿉니다(05 C절, 04 proxy).");
      else add("pass", "헤더", "CSP");
      if (/key\s*:\s*["'`]Content-Security-Policy["'`]/i.test(nct) && gateFile && /nonce/i.test(text(gateFile) || ""))
        add("warn", "헤더", "next.config 에도 CSP 헤더가 있고 proxy 가 nonce 를 붙입니다 — 배포 환경에서 앞의 값이 요청 헤더를 덮어써 nonce 가 사라질 수 있습니다.", [nc], "CSP 는 proxy 한 곳에서만 붙이세요(05 C절).");
    }
    if (nc && has("templates") && codeFiles.some((f) => /templates\//.test(text(f) || "")) && !/outputFileTracingIncludes/.test(nct))
      add("warn", "배포", "실행 중에 templates/ 파일을 읽는데 outputFileTracingIncludes 가 없습니다 — 운영에서만 파일이 없을 수 있습니다.", [nc], "함정 32.");

    const used = new Map();
    const IGNORE = /^(NODE_ENV|CI|PORT|NEXT_RUNTIME|TZ|HOME|PATH|VERCEL.*|npm_.*)$/;
    for (const f of codeFiles.filter((f) => !isTest(f))) {
      const t = text(f);
      if (!t) continue;
      for (const m of t.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g)) {
        const n = m[1] || m[2];
        if (!IGNORE.test(n) && !used.has(n)) used.set(n, f);
      }
    }
    const ex = text(".env.example");
    if (!ex && used.size) add("warn", "배포", ".env.example(환경변수 이름 견본)이 없습니다.", [], `코드가 쓰는 이름 ${used.size}개를 값 없이 적어 두세요 — 다음 사람이 무엇을 받아야 하는지 압니다.`);
    else if (ex) {
      const listed = new Set([...ex.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]));
      const missing = [...used.keys()].filter((n) => !listed.has(n));
      if (missing.length) add("warn", "배포", ".env.example 에 빠진 환경변수 이름이 있습니다.", missing.map((n) => `${n} (${used.get(n)})`), "이름만 추가하세요(값은 비움).");
      else add("pass", "배포", ".env.example 이 코드와 맞음");
    }
  }

  // ───────────── F. 함정 패턴 ─────────────
  {
    const utc = [];
    const fixedBottom = [];
    // 「YYYY-MM-DDT00:00:00Z」로 만든 날짜를 UTC로 더하고 빼는 것은 날짜 산술이라 맞다 — 바로 위 몇 줄에 그런 표시가 있으면 뺀다.
    const ARITH = /T00:00:00(?:\.000)?Z|Date\.UTC\(|setUTC\w+\(|getUTC\w+\(/;
    for (const f of appCode) {
      const t = text(f);
      if (!t) continue;
      const lines = t.split("\n");
      for (const m of t.matchAll(/toISOString\(\)\s*\.\s*(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)|toISOString\(\)\s*\.\s*split\(\s*["']T["']\s*\)\s*\[\s*0\s*\]/g)) {
        const ln = lineOf(t, m.index);
        if (lines.slice(Math.max(0, ln - 6), ln).some((l) => ARITH.test(l))) continue;
        utc.push(`${f}:${ln}`);
      }
    }
    for (const f of scanFiles.filter((f) => /^(src\/)?(app|components)\//.test(f) && /\.(tsx|jsx|css)$/.test(f))) {
      const t = text(f);
      if (!t) continue;
      for (const m of t.matchAll(/["'`][^"'`\n]*\bfixed\b[^"'`\n]*\bbottom-0\b[^"'`\n]*["'`]|["'`][^"'`\n]*\bbottom-0\b[^"'`\n]*\bfixed\b[^"'`\n]*["'`]/g)) fixedBottom.push(`${f}:${lineOf(t, m.index)}`);
    }
    if (utc.length) add("warn", "함정", "UTC 날짜를 「오늘」로 쓰는 코드로 보입니다 — 서울 자정~오전 9시에 하루 어긋납니다.", utc, "서울 기준 날짜 함수 하나를 쓰세요(함정 12). 날짜 산술용이면 무시해도 됩니다.");
    if (fixedBottom.length) add("warn", "함정", "화면 아래에 고정(fixed bottom-0)된 요소가 있습니다 — 하단 탭·막대라면 아이폰에서 흔들립니다.", fixedBottom, "하단 탭은 본문 끝의 sticky bottom-0 으로(함정 1). 알림 토스트·모달이면 무시해도 됩니다.");
    if (!utc.length && !fixedBottom.length) add("pass", "함정", "UTC 날짜·하단 fixed 패턴 없음");
  }
}

/** 파일 f 또는 그 파일이 들여오는 우리 코드(깊이 depth까지)에서 test 를 만족하는 첫 파일. */
function findUp(f, test, depth = 1, seen = new Set()) {
  if (seen.has(f)) return null;
  seen.add(f);
  const t = text(f) || "";
  if (test(t)) return f;
  if (depth <= 0) return null;
  for (const m of t.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = m[1];
    let base = null;
    if (spec.startsWith("@/")) base = (has("src") && !has("lib") ? "src/" : "") + spec.slice(2);
    else if (spec.startsWith(".")) base = relative(root, resolve(root, f, "..", spec)).split("\\").join("/");
    if (!base) continue;
    for (const cand of [base, ...[".ts", ".tsx", ".js", ".mjs"].map((e) => base + e), ...["/index.ts", "/index.js"].map((e) => base + e)]) {
      if (has(cand) && statSync(join(root, cand)).isFile()) {
        const hit = findUp(cand, test, depth - 1, seen);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function checkServerCode() {
  // Next 16 부터 길목 파일 이름이 proxy.ts 다.
  let nextMajor = null;
  try {
    const pkg = JSON.parse(text("package.json") || "{}");
    const v = (pkg.dependencies || {}).next || (pkg.devDependencies || {}).next || "";
    const m = String(v).match(/(\d+)\./);
    if (m) nextMajor = Number(m[1]);
  } catch {}
  if (nextMajor !== null) {
    if (!gateFile) add("warn", "서버 코드", "로그인 확인·세션 갱신을 하는 길목 파일(proxy.ts)이 없습니다.", [], "kit/docs/04-뼈대설계.md proxy 절. 공개 경로는 목록 한 곳에(함정 43).");
    else if (nextMajor >= 16 && middlewareFile && !proxyFile) add("warn", "서버 코드", "Next 16 이상인데 middleware 파일을 씁니다 — 16부터 이름이 proxy.ts 로 바뀌었습니다.", [middlewareFile], "설치된 버전의 공식 문서를 먼저 보세요(함정 41).");
  }

  const SESSION = /\b(?:getSession\w*|require[A-Z]\w*|getCurrent(?:User|Profile)\w*)\s*\(/;
  const SECRET_CHECK = /secretEquals|timingSafeEqual|CRON_SECRET/;
  const isAuthPath = (f) => /(^|\/)\(auth\)\/|(^|\/)(login|signin|sign-in|logout|signout)(\/|$)/.test(f);

  // 서버 액션 파일("use server")은 첫머리에서 세션을 확인한다.
  const actionNoSession = [];
  for (const f of appCode) {
    const t = text(f);
    if (!t || !/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*["']use server["']/.test(t)) continue;
    if (isAuthPath(f)) continue;
    if (!findUp(f, (x) => SESSION.test(x), 1)) actionNoSession.push(f);
  }
  // route.ts 도 세션이나 비밀·열쇠를 확인한다. 크론은 따로 본다. 주소에 [token]·[key] 가 있는 공개 경로는 그 열쇠를 직접 확인해야 한다(05 E절).
  const routeNoSession = [];
  for (const f of appCode.filter((f) => /^(src\/)?app\/.+\/route\.[cm]?[jt]sx?$/.test(f) && !/\/api\/cron\//.test(f))) {
    if (/\[(?:token|key|secret|code)\]/.test(f) || /csp-report/.test(f) || isAuthPath(f)) continue;
    if (!findUp(f, (x) => SESSION.test(x) || SECRET_CHECK.test(x), 1)) routeNoSession.push(f);
  }
  const noSession = [...actionNoSession, ...routeNoSession];
  if (noSession.length) add("warn", "서버 코드", "세션 확인 함수를 부르지 않는 서버 액션·API 가 있습니다.", noSession, "첫 줄에 세션 확인(getSessionProfile·requireProfile 등)을. 로그인 없이 여는 길이면 그 열쇠를 secretEquals 로 확인하고 progress.md 에 이유를(04 3절, 05 C절).");
  else add("pass", "서버 코드", "서버 액션·API 세션 확인");

  // 비밀 값을 === 로 비교하지 않는다.
  const SECRET_READ = String.raw`process\.env\.[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)\b|headers\.get\(\s*["'](?:authorization|x-[\w-]*(?:key|secret|token)[\w-]*)["']\s*\)|searchParams\.get\(\s*["'](?:key|token|secret)["']\s*\)`;
  const SECRETISH = new RegExp(String.raw`(?:===|!==)\s*(?:${SECRET_READ}|` + "`Bearer\\s" + String.raw`)|(?:${SECRET_READ}|` + "`Bearer\\s[^`]*`" + String.raw`)\s*(?:===|!==)\s*(?!undefined\b|null\b|""|''|` + "``" + ")", "i");
  const eqSecret = [];
  for (const f of [...appCode, gateFile].filter(Boolean)) {
    const t = text(f);
    if (!t) continue;
    t.split("\n").forEach((l, i) => {
      if (SECRETISH.test(l) && !/(?:===|!==)\s*(?:undefined|null)\b|typeof\s/.test(l)) eqSecret.push(`${f}:${i + 1}`);
    });
  }
  if (eqSecret.length) add("warn", "서버 코드", "비밀 값(크론 비밀·봇 키·열쇠)을 === 로 비교하는 것으로 보입니다 — 걸리는 시간으로 한 글자씩 맞혀 볼 수 있습니다.", eqSecret, "길이·내용과 상관없이 같은 시간에 비교하는 함수 하나(secretEquals: SHA-256 뒤 timingSafeEqual, 하나라도 비면 false)로(05 C절).");
  else add("pass", "서버 코드", "비밀 값 비교");

  // 저장소 경로를 startsWith 만으로 거르지 않는다.
  const STORAGE_OP = /createSigned(?:Upload)?Urls?\(|\.download\(|\.move\(|\.copy\(|\.remove\(\s*\[/;
  const SAFE_FN = /\b(?:is)?[Ss]afe\w*Path\s*\(/;
  const prefixOnly = [];
  for (const f of appCode) {
    const t = text(f);
    if (!t || !/\.storage\b/.test(t) || SAFE_FN.test(t)) continue;
    const lines = t.split("\n");
    lines.forEach((l, i) => {
      if (!/\.startsWith\(/.test(l)) return;
      if (lines.slice(Math.max(0, i - 2), i + 3).some((x) => STORAGE_OP.test(x))) prefixOnly.push(`${f}:${i + 1}`);
    });
  }
  if (prefixOnly.length) add("warn", "파일", "저장소 경로를 startsWith 로만 거르고 서명·내려받기·옮기기·지우기를 합니다 — `../`·`%2e%2e` 로 다른 버킷 파일에 닿습니다.", prefixOnly, "경로 검사 함수 하나(접두사 + `..`·빈 마디·`%`·`\\`·`?`·`#`·제어 문자 거부)를 지나게 하고, DB check 로도 막습니다(05 D절).");
}

// ───────────── 마이그레이션 읽기 ─────────────
/** 주석을 지우고, 「$…$」 본문 안의 ; 에 끊기지 않게 문장으로 나눈다. */
function splitSql(src) {
  const bodies = [];
  const masked = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, (m) => {
      bodies.push(m.replace(/--[^\n]*/g, " "));
      return `\u0001${bodies.length - 1}\u0001`;
    })
    .replace(/--[^\n]*/g, " ");
  return masked.split(";").map((s) => s.replace(/\u0001(\d+)\u0001/g, (_, i) => bodies[Number(i)]));
}
function stripBodies(s) {
  return s.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ");
}
function norm(s) {
  return s.replace(/"/g, "").trim().replace(/^public\./i, "").toLowerCase();
}
function isPublicName(raw) {
  return !/\./.test(raw.replace(/"/g, "")) || /^"?public"?\./i.test(raw);
}
/** 「키워드 ( … )」의 괄호 안 글. 없으면 null. */
function parenAfter(s, re) {
  const m = s.match(re);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < s.length && depth > 0; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
  }
  return s.slice(start, i - 1).trim();
}
function rolesOf(s) {
  return s.split(",").map((r) => r.trim().replace(/"/g, "").toLowerCase()).filter(Boolean);
}

function checkMigrations(dir) {
  const MEMBER_FN = /\bis_\w+\s*\(\s*\)/i; // is_member()·is_reader() 같은 「교직원인가」 판별 함수
  const sqlFiles = files.filter((f) => f.startsWith(dir + "/") && f.endsWith(".sql")).sort();
  if (!sqlFiles.length) return add("info", "데이터베이스", `${dir} 에 SQL 파일이 없습니다.`);

  const tables = new Map(); // 이름 → { file, rls, membersBlanket }
  const dropped = new Set();
  const rls = new Set();
  const anonRevoked = new Set();
  let allTablesAnon = false;
  const views = new Map(); // 이름 → { file, invoker, body, anon, auth }
  const fns = new Map(); // 이름 → { file, definer, trigger, anon, auth, grantAuth, grantService }
  let defaultFnAnon = false;
  let defaultFnAuth = false;
  const policies = new Map(); // 「표:이름」 → { table, name, restrictive, roles, using, check }
  const publicBuckets = [];

  for (const file of sqlFiles) {
    for (const s0 of splitSql(text(file) || "")) {
      const s = s0.trim();
      if (!s) continue;
      const head = stripBodies(s);
      let m;

      if ((m = head.match(/^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)/i))) {
        if (isPublicName(m[1]) && !tables.has(norm(m[1]))) tables.set(norm(m[1]), { file, membersBlanket: false });
        continue;
      }
      if ((m = head.match(/^drop\s+table\s+(?:if\s+exists\s+)?([^;]+)$/i))) {
        m[1].replace(/\b(cascade|restrict)\b/gi, "").split(",").forEach((n) => {
          const k = norm(n);
          tables.delete(k);
          dropped.add(k);
          for (const key of [...policies.keys()]) if (key.startsWith(k + ":")) policies.delete(key);
        });
        continue;
      }
      if ((m = head.match(/^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+enable\s+row\s+level\s+security/i))) {
        rls.add(norm(m[1]));
        continue;
      }
      if ((m = head.match(/^create\s+(or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)([\s\S]*)$/i))) {
        if (!isPublicName(m[2])) continue;
        const k = norm(m[2]);
        const invoker = /security_invoker\s*=\s*(?:on|true|1)\b/i.test(m[3]);
        const body = m[3].replace(/^[\s\S]*?\bas\b/i, "");
        const prev = views.get(k);
        // create or replace 는 권한을 그대로 둔다. 새로 만들면(또는 지운 뒤 만들면) Supabase 기본 권한(ALL)으로 돌아간다.
        if (m[1] && prev) Object.assign(prev, { invoker, body });
        else views.set(k, { file, invoker, body, anon: allTablesAnon, auth: false });
        continue;
      }
      if ((m = head.match(/^drop\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?([^;]+)$/i))) {
        m[1].replace(/\b(cascade|restrict)\b/gi, "").split(",").forEach((n) => views.delete(norm(n)));
        continue;
      }
      if ((m = head.match(/^create\s+(or\s+replace\s+)?function\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/i))) {
        if (!isPublicName(m[2])) continue;
        const k = norm(m[2]);
        const definer = /security\s+definer/i.test(head);
        const trigger = /returns\s+(?:event_)?trigger\b/i.test(head);
        const prev = fns.get(k);
        if (prev) Object.assign(prev, { definer, trigger });
        else fns.set(k, { file, definer, trigger, anon: defaultFnAnon, auth: defaultFnAuth, grantAuth: false, grantService: false });
        continue;
      }
      if ((m = head.match(/^drop\s+function\s+(?:if\s+exists\s+)?([\s\S]+)$/i))) {
        for (const n of m[1].matchAll(/((?:"?\w+"?\.)?"?\w+"?)\s*(?:\(|,|$)/g)) fns.delete(norm(n[1]));
        continue;
      }
      if ((m = head.match(/^alter\s+function\s+((?:"?\w+"?\.)?"?\w+"?)[\s\S]*\bsecurity\s+(definer|invoker)/i))) {
        const f = fns.get(norm(m[1]));
        if (f) f.definer = m[2].toLowerCase() === "definer";
        continue;
      }
      if (/^alter\s+default\s+privileges\b/i.test(head)) {
        if (/\brevoke\b[\s\S]*\bon\s+functions\b[\s\S]*\bfrom\b/i.test(head)) {
          const roles = rolesOf(head.replace(/^[\s\S]*\bfrom\b/i, ""));
          if (roles.includes("anon")) defaultFnAnon = true;
          if (roles.includes("authenticated")) defaultFnAuth = true;
        }
        if (/\brevoke\b[\s\S]*\bon\s+tables\b[\s\S]*\bfrom\b[\s\S]*\banon\b/i.test(head)) allTablesAnon = true;
        continue;
      }
      if ((m = head.match(/^(revoke|grant)\s+([\s\S]*?)\bon\s+([\s\S]+?)\s+(from|to)\s+([\s\S]+)$/i))) {
        const isRevoke = m[1].toLowerCase() === "revoke";
        const privs = m[2].toLowerCase();
        const target = m[3];
        const roles = rolesOf(m[5].replace(/\b(cascade|restrict|with\s+grant\s+option)\b/gi, ""));
        const writes = /\b(all|insert|update|delete|truncate)\b/.test(privs);
        if (/^(?:all\s+)?(?:functions|routines)\s+in\s+schema\s+public$/i.test(target.trim()) || /^(?:function|routine|procedure)s?\b/i.test(target.trim())) {
          const all = /\bin\s+schema\s+public\b/i.test(target);
          const names = all ? [...fns.keys()] : [...target.replace(/^(?:function|routine|procedure)s?\s+/i, "").matchAll(/((?:"?\w+"?\.)?"?\w+"?)\s*(?:\(|,|$)/g)].map((x) => norm(x[1]));
          for (const n of names) {
            const f = fns.get(n);
            if (!f) continue;
            if (isRevoke) {
              if (roles.includes("anon")) f.anon = true;
              if (roles.includes("authenticated")) f.auth = true;
            } else {
              if (roles.includes("anon")) f.anon = false;
              if (roles.includes("authenticated")) (f.auth = false), (f.grantAuth = true);
              if (roles.includes("service_role")) f.grantService = true;
            }
          }
          continue;
        }
        if (/^all\s+tables\s+in\s+schema\s+public$/i.test(target.trim())) {
          if (isRevoke && roles.includes("anon")) {
            allTablesAnon = true;
            for (const v of views.values()) v.anon = true;
          }
          if (isRevoke && roles.includes("authenticated") && writes) for (const v of views.values()) v.auth = true;
          continue;
        }
        if (/^(?:schema|sequence|all\s+sequences|type|domain|database|language)\b/i.test(target.trim())) continue;
        for (const n of target.replace(/^table\s+/i, "").split(",")) {
          const k = norm(n);
          if (isRevoke && roles.includes("anon")) anonRevoked.add(k);
          const v = views.get(k);
          if (!v) continue;
          if (isRevoke) {
            if (roles.includes("anon")) v.anon = true;
            if (roles.includes("authenticated") && writes) v.auth = true;
          } else {
            if (roles.includes("anon")) v.anon = false;
            if (roles.includes("authenticated") && writes) v.auth = false;
          }
        }
        continue;
      }
      if ((m = head.match(/^create\s+policy\s+(?:"([^"]+)"|(\S+))\s+on\s+((?:"?\w+"?\.)?"?\w+"?)([\s\S]*)$/i))) {
        const table = norm(m[3]);
        const name = (m[1] || m[2]).toLowerCase();
        const rest = m[4];
        const to = rest.match(/\bto\s+([\s\S]+?)(?=\busing\b|\bwith\s+check\b|$)/i);
        policies.set(`${table}:${name}`, {
          table,
          shown: `${m[3].replace(/"/g, "")} — 정책 「${m[1] || m[2]}」`,
          restrictive: /\bas\s+restrictive\b/i.test(rest),
          roles: to ? rolesOf(to[1]) : ["public"],
          using: parenAfter(rest, /\busing\s*\(/i),
          check: parenAfter(rest, /\bwith\s+check\s*\(/i),
        });
        continue;
      }
      if ((m = head.match(/^alter\s+policy\s+(?:"([^"]+)"|(\S+))\s+on\s+((?:"?\w+"?\.)?"?\w+"?)([\s\S]*)$/i))) {
        const key = `${norm(m[3])}:${(m[1] || m[2]).toLowerCase()}`;
        const p = policies.get(key);
        if (!p) continue;
        const rest = m[4];
        const rn = rest.match(/^\s*rename\s+to\s+(?:"([^"]+)"|(\S+))/i);
        if (rn) {
          policies.delete(key);
          policies.set(`${norm(m[3])}:${(rn[1] || rn[2]).toLowerCase()}`, { ...p, shown: `${m[3].replace(/"/g, "")} — 정책 「${rn[1] || rn[2]}」` });
          continue;
        }
        const to = rest.match(/\bto\s+([\s\S]+?)(?=\busing\b|\bwith\s+check\b|$)/i);
        if (to) p.roles = rolesOf(to[1]);
        const u = parenAfter(rest, /\busing\s*\(/i);
        const c = parenAfter(rest, /\bwith\s+check\s*\(/i);
        if (u !== null) p.using = u;
        if (c !== null) p.check = c;
        continue;
      }
      if ((m = head.match(/^drop\s+policy\s+(?:if\s+exists\s+)?(?:"([^"]+)"|(\S+))\s+on\s+((?:"?\w+"?\.)?"?\w+"?)/i))) {
        policies.delete(`${norm(m[3])}:${(m[1] || m[2]).toLowerCase()}`);
        continue;
      }
      // do 블록으로 모든 표에 「교직원만」 제한 정책을 한꺼번에 거는 경우: 그때 있던 표를 덮은 것으로 본다(not in (…) 은 뺀다).
      if (/^do\b/i.test(s) && /create\s+policy[\s\S]*as\s+restrictive/i.test(s) && MEMBER_FN.test(s)) {
        const except = new Set([...(s.match(/not\s+in\s*\(([^)]*)\)/i)?.[1] || "").matchAll(/'([^']+)'/g)].map((x) => x[1].toLowerCase()));
        for (const [k, t] of tables) if (rls.has(k) && !except.has(k)) t.membersBlanket = true;
        continue;
      }
      if (/^update\s+storage\.buckets\b[\s\S]*\bpublic\s*=\s*true/i.test(head)) publicBuckets.push("update storage.buckets … public = true");
      const ins = head.match(/^insert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*([\s\S]*)/i);
      if (ins) {
        const cols = ins[1].split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase());
        const pi = cols.indexOf("public");
        if (pi >= 0)
          for (const v of ins[2].matchAll(/\(([^()]*)\)/g)) {
            const vals = v[1].split(",").map((x) => x.trim());
            if (/^true$/i.test(vals[pi] || "")) publicBuckets.push(`버킷 ${vals[cols.indexOf("id")] || vals[0]}`);
          }
      }
    }
  }

  // RLS
  const noRls = [...tables.keys()].filter((t) => !rls.has(t));
  if (noRls.length) add("fail", "데이터베이스", "RLS(행 단위 권한)를 켜지 않은 표가 있습니다 — 공개 키만으로 누구나 읽고 쓸 수 있습니다.", noRls, "`alter table <표> enable row level security;` 와 정책, 그리고 RLS 테스트(05 B절).");
  else if (tables.size) add("pass", "데이터베이스", `표 ${tables.size}개 모두 RLS`);

  // 표의 익명 권한
  if (!allTablesAnon) {
    const open = [...tables.keys()].filter((t) => !anonRevoked.has(t));
    if (open.length) add("warn", "데이터베이스", "익명(anon) 권한을 거두지 않은 표가 있습니다. RLS 가 켜져 있고 정책이 모두 `to authenticated` 면 지금은 0행이지만, `to` 를 빠뜨린 정책 하나가 생기면 로그인 전 방문자에게 열립니다.", open, "`revoke all on <표> from anon;` 으로 한 겹 더(05 B절, 함정 20).");
    else if (tables.size) add("pass", "데이터베이스", "표 익명 권한 회수");
  } else add("pass", "데이터베이스", "표 익명 권한 회수(스키마 전체)");

  // 「교직원만」 제한 정책
  const permissive = new Map();
  const restrictiveMember = new Set();
  for (const p of policies.values()) {
    if (p.restrictive) {
      if (MEMBER_FN.test(`${p.using || ""} ${p.check || ""}`)) restrictiveMember.add(p.table);
    } else if (p.roles.some((r) => r === "authenticated" || r === "public")) permissive.set(p.table, true);
  }
  const noMembersOnly = [...tables.entries()]
    .filter(([k, t]) => rls.has(k) && k !== "profiles" && permissive.has(k) && !t.membersBlanket && !restrictiveMember.has(k))
    .map(([k]) => k);
  if (noMembersOnly.length) add("warn", "데이터베이스", "「교직원만」 제한 정책(as restrictive + is_member())이 없는 표가 있습니다 — 쓰기 규칙 하나를 빠뜨리거나 가입만 한·비활성·휴직 계정이 직접 부르면 그대로 열립니다.", noMembersOnly, "`create policy members_only on <표> as restrictive for all to authenticated using (public.is_member()) with check (public.is_member());` 새 표마다(05 B절).");
  else if (permissive.size) add("pass", "데이터베이스", "「교직원만」 제한 정책");

  // using (true)
  const openPolicies = [...policies.values()]
    .filter((p) => !p.restrictive && (/^\s*true\s*$/i.test(p.using || "") || /^\s*true\s*$/i.test(p.check || "")) && !p.roles.includes("service_role"))
    .filter((p) => tables.has(p.table) || !dropped.has(p.table))
    .map((p) => p.shown);
  if (openPolicies.length) add("warn", "데이터베이스", "`using (true)` 정책이 있습니다 — 공개 가입이 켜지면 아무 계정이나 읽게 됩니다.", openPolicies, "「활성 교직원인가」를 확인하는 함수(is_member())로 바꾸세요(05 B절).");
  else if (policies.size) add("pass", "데이터베이스", "using (true) 정책 없음");

  // 뷰
  const viewWrite = [];
  const viewWarn = [];
  for (const [k, v] of views) {
    if (!v.invoker && !v.auth) viewWrite.push(`${k} (${v.file})`);
    if (!v.anon) viewWarn.push(`${k} — anon 권한이 남음`);
    if (!v.invoker && !MEMBER_FN.test(v.body) && !/auth\.uid\(\)/i.test(v.body)) viewWarn.push(`${k} — 소유자 권한인데 뷰 안에 is_member() 같은 조건이 없음`);
  }
  if (viewWrite.length) add("fail", "데이터베이스", "뷰에 로그인한 사용자(authenticated)의 쓰기 권한이 남아 있습니다 — 단순 뷰는 고치기·지우기가 원래 표로 가고, 소유자 권한이라 RLS 도 걸리지 않습니다.", viewWrite, "`revoke all on <뷰> from public, anon, authenticated;` 뒤 `grant select on <뷰> to authenticated;` (05 B절, 함정 20).");
  if (viewWarn.length) add("warn", "데이터베이스", "뷰 권한·조건을 확인하세요 — 뷰는 RLS 를 건너뜁니다.", viewWarn, "anon 은 거두고, 소유자 권한 뷰 안에는 `where public.is_member()` 를(05 B절, 함정 20).");
  if (views.size && !viewWrite.length && !viewWarn.length) add("pass", "데이터베이스", `뷰 ${views.size}개 읽기만·교직원만`);

  // security definer 함수의 실행 권한
  const fnOpen = [];
  for (const [k, f] of fns) {
    if (!f.definer || f.trigger) continue;
    const serverOnly = f.grantService && !f.grantAuth;
    if (!f.anon) fnOpen.push(`${k} — anon 실행 가능`);
    if (serverOnly && !f.auth) fnOpen.push(`${k} — 서버 전용(service_role)으로 보이는데 authenticated 도 실행 가능`);
  }
  if (fnOpen.length) add("warn", "데이터베이스", "security definer 함수의 실행 권한이 남아 있습니다 — Supabase 는 새 함수에 anon·authenticated 실행 권한을 따로 줘서 `from public` 만으로는 거둬지지 않고, PostgREST(/rest/v1/rpc/…)로 누구나 부를 수 있습니다.", fnOpen, "판별 함수는 `revoke execute … from public, anon`, 서버 전용 쓰기 함수는 `from public, anon, authenticated` 뒤 `grant execute … to service_role`(05 B절). 대시보드 Security Advisor 로도 확인하세요.");
  else if ([...fns.values()].some((f) => f.definer && !f.trigger)) add("pass", "데이터베이스", "security definer 함수 실행 권한");

  // search_path
  const definerNoPath = [];
  const allSql = sqlFiles.map((f) => (text(f) || "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")).join("\n;\n");
  const fixedPath = new Set([...allSql.matchAll(/alter\s+function\s+((?:"?\w+"?\.)?"?\w+"?)[^;]*set\s+search_path/gi)].map((m) => norm(m[1])));
  for (const m of allSql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(([\s\S]*?)\$(\w*)\$[\s\S]*?\$\3\$([^;]*)/gi)) {
    const h = m[2] + " " + m[4];
    if (/security\s+definer/i.test(h) && !/search_path/i.test(h) && !fixedPath.has(norm(m[1]))) definerNoPath.push(m[1].replace(/"/g, ""));
  }
  if (definerNoPath.length) add("warn", "데이터베이스", "security definer 함수에 search_path 가 고정돼 있지 않습니다.", [...new Set(definerNoPath)], "`set search_path = public` 을 붙이세요(05 B절).");

  if (publicBuckets.length) add("warn", "데이터베이스", "공개(public) 버킷이 있습니다 — 주소만 알면 누구나 파일을 받습니다.", publicBuckets, "학교 자료는 비공개 버킷 + 짧은 서명 주소로(함정 26). 로고처럼 정말 공개할 것만 공개.");

  if (tables.size && !files.some((f) => /rls/i.test(f) && isCode(f) && isTest(f)))
    add("warn", "데이터베이스", "RLS 테스트 파일이 보이지 않습니다.", [], "표마다 허용·거부를 둘 다 확인하는 테스트(kit/docs/04-뼈대설계.md 테스트 절).");
}

// ───────────── 손으로 확인할 것 ─────────────
const manual = [];
if (hasApp && (has("supabase") || codeFiles.some((f) => /supabase/.test(text(f) || "")))) {
  manual.push("Supabase 대시보드 → Authentication → Sign In / Providers 에서 「Allow new users to sign up」이 꺼져 있다");
  manual.push("Supabase 대시보드 → Advisors → Security Advisor 에 경고가 없다(특히 security definer 함수 실행 권한·RLS 꺼진 표)");
}
for (const id of modIds) for (const c of catalog.byId.get(id).checks) manual.push(`[${catalog.byId.get(id).name}] ${c}`);
if (modIds.length) manual.push(...catalog.common_checks.filter((c) => !/gate\.mjs/.test(c)));

// ───────────── 출력 ─────────────
const fails = results.filter((r) => r.level === "fail");
const warns = results.filter((r) => r.level === "warn");
const passes = results.filter((r) => r.level === "pass");
const infos = results.filter((r) => r.level === "info");

if (opts.json) {
  console.log(JSON.stringify({ root, date: today(), git: isGit, fails, warns, passes, infos, manual }, null, 2));
} else {
  const L = [];
  L.push(`관문 검사 — ${root} (${today()})`);
  L.push(`결과: ❌ 막힘 ${fails.length} · ⚠️ 확인 ${warns.length} · ✅ 통과 ${passes.length}`, "");
  const block = (list, head) => {
    if (!list.length) return;
    L.push(head);
    list.forEach((r, i) => {
      L.push(`  ${i + 1}. [${r.area}] ${r.msg}`);
      if (r.where.length) L.push(`     위치: ${r.where.slice(0, 8).join(", ")}${r.where.length > 8 ? ` 외 ${r.where.length - 8}곳` : ""}`);
      if (r.hint) L.push(`     고치기: ${r.hint}`);
    });
    L.push("");
  };
  block(fails, "❌ 막힘 — 고치기 전에는 다음 단계로 가지 않습니다");
  block(warns, "⚠️ 확인 — 고치거나, 그대로 두는 이유를 progress.md 「결정 기록」에 적습니다");
  if (passes.length) L.push(`✅ 통과: ${passes.map((r) => r.msg).join(" · ")}`, "");
  for (const r of infos) L.push(`ℹ️ ${r.msg}${r.where.length ? ` (${r.where.join(", ")})` : ""}`);
  if (infos.length) L.push("");
  if (manual.length) {
    L.push("손으로 확인할 것 (자동 검사로는 못 봅니다)");
    for (const m of [...new Set(manual)]) L.push(`  - [ ] ${m}`);
  }
  console.log(L.join("\n"));
}
process.exit(fails.length ? 1 : 0);
