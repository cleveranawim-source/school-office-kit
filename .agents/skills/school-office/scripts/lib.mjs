// plan.mjs · memo.mjs · gate.mjs 공통 부분. 의존성 없음(Node 18+).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 키트 저장소 뿌리: AGENTS.md 와 kit/docs 가 함께 있는 가장 가까운 위쪽 폴더. 못 찾으면 null. */
export function findKitRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "AGENTS.md")) && existsSync(join(dir, "kit", "docs"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function loadCatalog() {
  const raw = JSON.parse(readFileSync(join(SKILL_DIR, "references", "modules.json"), "utf8"));
  const byId = new Map(raw.modules.map((m) => [m.id, m]));
  return { ...raw, byId };
}

/** 함정 노트에서 번호 → 한 줄(「N. ★★★ **증상** → …」)을 읽는다. 파일이 없으면 빈 Map. */
export function loadPitfalls(root) {
  const map = new Map();
  if (!root) return map;
  const file = join(root, "kit", "docs", "06-함정노트.md");
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^(\d+)\.\s+(★+.*)$/);
    if (m) map.set(Number(m[1]), m[2].trim());
  }
  return map;
}

/** school-profile.md 의 「4. 가장 덜고 싶은 불편」 절에서 채워진 줄만. */
export function loadPains(root) {
  if (!root) return [];
  const file = join(root, "school-profile.md");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const sec = text.split(/\n(?=## )/).find((s) => /^## 4\b/.test(s));
  if (!sec) return [];
  return sec
    .split("\n")
    .slice(1)
    .map((l) => l.replace(/^\s*(\d+\.|[-*])\s*/, "").trim())
    .filter((l) => l && !l.startsWith(">"));
}

/** --이름 값 / --이름=값 / --플래그 / 나머지는 positional. */
export function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && VALUE_FLAGS.has(a.slice(2))) {
      opts[a.slice(2)] = argv[++i];
    } else {
      opts[a.slice(2)] = true;
    }
  }
  return { opts, rest };
}
const VALUE_FLAGS = new Set(["skip", "stage", "title", "out", "new", "root", "modules"]);

export function splitList(v) {
  if (!v || v === true) return [];
  return String(v)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function unknownIds(ids, catalog) {
  return ids.filter((id) => !catalog.byId.has(id));
}

export function idHelp(catalog) {
  const rows = catalog.modules.map((m) => `  ${m.id.padEnd(11)} ${m.tier} · ${m.difficulty.padEnd(4)} ${m.name}`);
  return ["모듈 id 목록:", ...rows].join("\n");
}

export function today() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
}
