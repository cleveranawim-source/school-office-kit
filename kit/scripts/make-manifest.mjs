#!/usr/bin/env node
// [키트 관리자용] 새 판을 낼 때 kit/MANIFEST.json(관리 파일 지문 목록)을 만든다.
// 다른 학교의 update-kit.mjs 가 이 목록으로 「선생님이 고친 파일」과 「키트가 바뀐 파일」을 가른다.
//
//   1) kit/VERSION 올리기   2) kit/CHANGELOG.md 에 바뀐 점 적기
//   3) node kit/scripts/sync-skills.mjs   4) node kit/scripts/make-manifest.mjs   5) 커밋·푸시
//
//   node kit/scripts/make-manifest.mjs --check   # 목록이 지금 파일과 맞는지만(다르면 종료 코드 1)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./kit-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = readFileSync(join(root, "kit", "VERSION"), "utf8").trim();
const next = buildManifest(root, version);
const file = join(root, "kit", "MANIFEST.json");
const text = JSON.stringify(next, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {}
  if (cur !== text) {
    console.error("kit/MANIFEST.json 이 지금 파일과 다릅니다 → node kit/scripts/make-manifest.mjs");
    process.exit(1);
  }
  console.log(`지문 목록이 맞습니다 (판 ${version}, 파일 ${Object.keys(next.files).length}개).`);
  process.exit(0);
}

writeFileSync(file, text);
console.log(`kit/MANIFEST.json 을 만들었습니다 — 판 ${version}, 관리 파일 ${Object.keys(next.files).length}개.`);
