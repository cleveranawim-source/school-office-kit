#!/usr/bin/env node
// 관문 검사: 코드만 보고 알 수 있는 보안·함정을 자동으로 찾는다. 네트워크·DB에 접속하지 않는다.
//
//   node gate.mjs                         # 저장소 전체
//   node gate.mjs --modules nep,push      # + 그 모듈의 「손으로 확인할 것」 목록
//   node gate.mjs --root ../다른-저장소   # 다른 폴더 검사
//   node gate.mjs --json
//
// ❌ 막힘이 하나라도 있으면 종료 코드 1. 찾은 비밀 값 자체는 절대 출력하지 않는다(위치와 종류만).
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
  ];
  const FAKE = /test|fake|dummy|example|sample|xxxx|placeholder|your[-_]?key/i; // 테스트용 가짜 키는 비밀이 아니다
  const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
  const ASSIGN = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|PRIVATE|PASSWORD|API_KEY|TOKEN)[A-Z0-9_]*)\s*[=:]\s*["']?([^"'\s#,]+)/;
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
      if (isEnvLike) {
        const a = line.match(ASSIGN);
        if (a && a[2].length >= 12 && !PLACEHOLDER.test(a[2])) (isExample ? exampleVals : found).push(`${f}:${i + 1} (${a[1]} 에 값)`);
      }
    });
  }
  if (found.length) add("fail", "비밀 값", "코드·문서에 비밀 값으로 보이는 것이 있습니다(값은 출력하지 않음).", found, "그 자리에서 지우고 `.env.local` 로 옮기세요. 이미 커밋·푸시했다면 그 키를 새로 발급(회전)해야 합니다 — 기록에 남아 있습니다.");
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

  // ───────────── D. 배포·크론 ─────────────
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
    const unguarded = cronRoutes.filter((f) => !guarded(f));
    if (unguarded.length) add("warn", "배포", "크론 주소에서 CRON_SECRET 확인이 안 보입니다.", unguarded, "공통 껍데기에서 `Authorization: Bearer` 를 확인하고, 비밀이 비어 있으면 거부(함정 28).");
    else if (cronRoutes.length) add("pass", "배포", `크론 주소 ${cronRoutes.length}곳 비밀 확인`);

    const nc = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"].find(has);
    const nct = nc ? text(nc) : "";
    if (nc && !/X-Frame-Options|frame-ancestors|Content-Security-Policy/i.test(nct)) add("warn", "배포", "보안 헤더(X-Frame-Options 또는 CSP frame-ancestors 등)가 없습니다.", [nc], "kit/docs/05-보안기준선.md C절. 앱 안 보기 화면·키오스크 경로는 예외를 따로 둡니다.");
    else if (nc) add("pass", "배포", "보안 헤더");
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

  // ───────────── E. 함정 패턴 ─────────────
  {
    const utc = [];
    const fixedBottom = [];
    for (const f of appCode) {
      const t = text(f);
      if (!t) continue;
      for (const m of t.matchAll(/toISOString\(\)\s*\.\s*(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)|toISOString\(\)\s*\.\s*split\(\s*["']T["']\s*\)\s*\[\s*0\s*\]/g)) utc.push(`${f}:${lineOf(t, m.index)}`);
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

function guarded(f, depth = 0) {
  const t = text(f) || "";
  if (/CRON_SECRET/.test(t)) return true;
  if (depth > 1) return false;
  for (const m of t.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = m[1];
    let base = null;
    if (spec.startsWith("@/")) base = (has("src") && !has("lib") ? "src/" : "") + spec.slice(2);
    else if (spec.startsWith(".")) base = relative(root, resolve(root, f, "..", spec)).split("\\").join("/");
    if (!base) continue;
    for (const cand of [base, ...[".ts", ".tsx", ".js", ".mjs"].map((e) => base + e), ...["/index.ts", "/index.js"].map((e) => base + e)]) {
      if (has(cand) && statSync(join(root, cand)).isFile() && guarded(cand, depth + 1)) return true;
    }
  }
  return false;
}

function checkMigrations(dir) {
  const sqlFiles = files.filter((f) => f.startsWith(dir + "/") && f.endsWith(".sql")).sort();
  if (!sqlFiles.length) return add("info", "데이터베이스", `${dir} 에 SQL 파일이 없습니다.`);
  const sql = sqlFiles.map((f) => (text(f) || "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")).join("\n;\n");
  const norm = (s) => s.replace(/"/g, "").trim().replace(/^public\./i, "").toLowerCase();
  const dropped = new Set();

  const tables = new Map(); // 이름 → 처음 만든 파일
  const views = new Set();
  for (const m of sql.matchAll(/create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) if (!m[1] || m[1].toLowerCase() === "public") tables.set(m[2].toLowerCase(), true);
  for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?([^;]+);/gi))
    m[1].replace(/\b(cascade|restrict)\b/gi, "").split(",").forEach((n) => {
      tables.delete(norm(n));
      dropped.add(norm(n));
    });
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) if (!m[1] || m[1].toLowerCase() === "public") views.add(m[2].toLowerCase());
  for (const m of sql.matchAll(/drop\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?([^;]+);/gi)) m[1].replace(/\b(cascade|restrict)\b/gi, "").split(",").forEach((n) => views.delete(norm(n)));

  const rls = new Set([...sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s+enable\s+row\s+level\s+security/gi)].map((m) => m[1].toLowerCase()));
  const noRls = [...tables.keys()].filter((t) => !rls.has(t));
  if (noRls.length) add("fail", "데이터베이스", "RLS(행 단위 권한)를 켜지 않은 표가 있습니다 — 공개 키만으로 누구나 읽고 쓸 수 있습니다.", noRls, "`alter table <표> enable row level security;` 와 정책, 그리고 RLS 테스트(kit/docs/05-보안기준선.md B).");
  else if (tables.size) add("pass", "데이터베이스", `표 ${tables.size}개 모두 RLS`);

  const stmts = sql.split(";");
  let allRevoked = false;
  const revoked = new Set();
  for (const s of stmts) {
    if (/^\s*alter\s+default\s+privileges[\s\S]*revoke[\s\S]*\bfrom\b[\s\S]*\banon\b/i.test(s)) allRevoked = true;
    if (!/^\s*revoke\b/i.test(s) || !/\bfrom\b[\s\S]*\banon\b/i.test(s)) continue;
    if (/\bon\s+all\s+tables\s+in\s+schema\s+public\b/i.test(s)) allRevoked = true;
    const on = s.match(/\bon\s+(?:table\s+)?([\s\S]+?)\s+from\b/i);
    if (on) on[1].split(",").forEach((n) => revoked.add(norm(n)));
  }
  if (!allRevoked) {
    const open = [...tables.keys(), ...views].filter((t) => !revoked.has(t));
    if (open.length) add("warn", "데이터베이스", "익명(anon) 권한을 회수하지 않은 표·뷰가 있습니다 — 특히 뷰는 RLS를 건너뛰어 로그인 전 방문자가 읽을 수 있습니다.", open, "`revoke all on <표> from anon;` (함정 20). 뷰는 반드시.");
    else if (tables.size) add("pass", "데이터베이스", "익명 권한 회수");
  } else add("pass", "데이터베이스", "익명 권한 회수(스키마 전체)");

  const policies = new Map();
  for (const s of stmts) {
    const c = s.match(/^\s*create\s+policy\s+(?:"([^"]+)"|(\S+))\s+on\s+((?:"?\w+"?\.)?"?\w+"?)([\s\S]*)$/i);
    if (c) {
      const key = `${norm(c[3])}:${(c[1] || c[2]).toLowerCase()}`;
      const body = c[4];
      const open = /using\s*\(\s*true\s*\)|with\s+check\s*\(\s*true\s*\)/i.test(body) && !/\bto\s+service_role\b/i.test(body);
      policies.set(key, open ? `${c[3].replace(/"/g, "")} — 정책 「${c[1] || c[2]}」` : null);
      continue;
    }
    const d = s.match(/^\s*drop\s+policy\s+(?:if\s+exists\s+)?(?:"([^"]+)"|(\S+))\s+on\s+((?:"?\w+"?\.)?"?\w+"?)/i);
    if (d) policies.delete(`${norm(d[3])}:${(d[1] || d[2]).toLowerCase()}`);
  }
  const openPolicies = [...policies.entries()].filter(([k, v]) => v && !(dropped.has(k.split(":")[0]) && !tables.has(k.split(":")[0]))).map(([, v]) => v);
  if (openPolicies.length) add("warn", "데이터베이스", "`using (true)` 정책이 있습니다 — 공개 가입이 켜지면 아무 계정이나 읽게 됩니다.", openPolicies, "「활성 교직원인가」를 확인하는 함수(is_member())로 바꾸세요(kit/docs/05-보안기준선.md B).");
  else if (policies.size) add("pass", "데이터베이스", "using (true) 정책 없음");

  const fixedPath = new Set([...sql.matchAll(/alter\s+function\s+((?:"?\w+"?\.)?"?\w+"?)[^;]*set\s+search_path/gi)].map((m) => norm(m[1])));
  const definerNoPath = [];
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(([\s\S]*?)\$(\w*)\$[\s\S]*?\$\3\$([^;]*)/gi)) {
    const head = m[2] + " " + m[4];
    if (/security\s+definer/i.test(head) && !/search_path/i.test(head) && !fixedPath.has(norm(m[1]))) definerNoPath.push(m[1].replace(/"/g, ""));
  }
  if (definerNoPath.length) add("warn", "데이터베이스", "security definer 함수에 search_path 가 고정돼 있지 않습니다.", [...new Set(definerNoPath)], "`set search_path = public` 을 붙이고 `revoke … from public` 하세요.");

  const publicBuckets = [];
  for (const s of stmts) {
    if (/^\s*update\s+storage\.buckets\b[\s\S]*\bpublic\s*=\s*true/i.test(s)) publicBuckets.push("update storage.buckets … public = true");
    const ins = s.match(/insert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*([\s\S]*)/i);
    if (!ins) continue;
    const cols = ins[1].split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase());
    const pi = cols.indexOf("public");
    if (pi < 0) continue;
    for (const v of ins[2].matchAll(/\(([^()]*)\)/g)) {
      const vals = v[1].split(",").map((x) => x.trim());
      if (/^true$/i.test(vals[pi] || "")) publicBuckets.push(`버킷 ${vals[cols.indexOf("id")] || vals[0]}`);
    }
  }
  if (publicBuckets.length) add("warn", "데이터베이스", "공개(public) 버킷이 있습니다 — 주소만 알면 누구나 파일을 받습니다.", publicBuckets, "학교 자료는 비공개 버킷 + 짧은 서명 주소로(함정 26). 로고처럼 정말 공개할 것만 공개.");

  if (tables.size && !files.some((f) => /rls/i.test(f) && isCode(f) && isTest(f)))
    add("warn", "데이터베이스", "RLS 테스트 파일이 보이지 않습니다.", [], "표마다 허용·거부를 둘 다 확인하는 테스트(kit/docs/04-뼈대설계.md 5절).");
}

// ───────────── 손으로 확인할 것 ─────────────
const manual = [];
if (hasApp && (has("supabase") || codeFiles.some((f) => /supabase/.test(text(f) || ""))))
  manual.push("Supabase 대시보드 → Authentication → Sign In / Providers 에서 「Allow new users to sign up」이 꺼져 있다");
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
