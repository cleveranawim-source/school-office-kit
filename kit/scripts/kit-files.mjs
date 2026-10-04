// 키트가 관리하는 파일 목록·지문(해시). make-manifest.mjs 와 update-kit.mjs 가 함께 쓴다. 의존성 없음.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** 키트가 통째로 관리하는 폴더. 이 밖의 파일(앱 코드, school-profile.md, progress.md, README …)은 건드리지 않는다. */
export const MANAGED_DIRS = ["kit", ".agents/skills/school-office", ".claude/skills/school-office"];
/** 지문 목록 자신은 목록에 넣지 않는다. */
export const SKIP = new Set(["kit/MANIFEST.json"]);
/** AGENTS.md 는 표시 사이(키트 구역)만 관리한다. */
export const AGENTS_KEY = "AGENTS.md#kit";
const BEGIN = /^<!-- kit:begin\b.*$/m;
const END = /^<!-- kit:end -->\s*$/m;

export function listManaged(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.name === ".DS_Store") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (!SKIP.has(rel) && !rel.endsWith(".kit-new")) out.push(rel);
    }
  };
  for (const d of MANAGED_DIRS) if (existsSync(join(root, d))) walk(d);
  return out.sort();
}

/** 줄바꿈(CRLF/LF) 차이는 같은 것으로 본다 — 윈도우에서 git 이 줄바꿈을 바꿔도 「고친 파일」로 잡히지 않게. */
export function hashBuf(buf) {
  const isText = !buf.subarray(0, 8000).includes(0);
  const data = isText ? Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n")) : buf;
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

export function hashFile(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p) || !statSync(p).isFile()) return null;
  return hashBuf(readFileSync(p));
}

/** AGENTS.md 글에서 키트 구역(표시 줄 포함)을 꺼낸다. 표시가 없으면 null. */
export function agentsBlock(text) {
  if (text == null) return null;
  const t = text.replace(/\r\n/g, "\n");
  const b = t.match(BEGIN);
  const e = t.match(END);
  if (!b || !e || e.index < b.index) return null;
  return t.slice(b.index, e.index + e[0].trimEnd().length);
}

/** 로컬 AGENTS.md 의 키트 구역을 새 구역으로 바꾼다(구역 밖 「우리 학교 규칙」은 그대로). */
export function replaceAgentsBlock(localText, newBlock) {
  const t = localText.replace(/\r\n/g, "\n");
  const old = agentsBlock(t);
  if (old == null) return null;
  return t.replace(old, newBlock);
}

export function hashAgents(root) {
  const p = join(root, "AGENTS.md");
  if (!existsSync(p)) return null;
  const block = agentsBlock(readFileSync(p, "utf8"));
  return block == null ? null : hashBuf(Buffer.from(block));
}

export function buildManifest(root, version) {
  const files = {};
  for (const rel of listManaged(root)) files[rel] = hashFile(root, rel);
  const a = hashAgents(root);
  if (a) files[AGENTS_KEY] = a;
  return { version, files };
}

export function isManagedPath(rel) {
  if (rel === AGENTS_KEY) return true;
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) return false;
  return MANAGED_DIRS.some((d) => rel.startsWith(d + "/"));
}

export const rel = (root, p) => relative(root, p).split("\\").join("/");
