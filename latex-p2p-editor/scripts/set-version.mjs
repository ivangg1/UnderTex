#!/usr/bin/env node
// Writes one version into every place the app declares it, so a release tag is
// the single source of truth:
//   node scripts/set-version.mjs 0.1.5      (or v0.1.5)
// Updates src-tauri/tauri.conf.json, package.json, package-lock.json and
// src-tauri/Cargo.toml (Cargo.lock follows on the next cargo build).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = (process.argv[2] ?? "").trim().replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(raw)) {
  console.error(`Invalid version "${process.argv[2] ?? ""}" (expected X.Y.Z or vX.Y.Z)`);
  process.exit(1);
}

const editJson = (rel, edit) => {
  const path = join(root, rel);
  const data = JSON.parse(readFileSync(path, "utf8"));
  edit(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

editJson("src-tauri/tauri.conf.json", (c) => (c.version = raw));
editJson("package.json", (p) => (p.version = raw));
editJson("package-lock.json", (l) => {
  l.version = raw;
  if (l.packages?.[""]) l.packages[""].version = raw;
});

const cargoPath = join(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const updated = cargo.replace(/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${raw}"`);
if (updated === cargo && !cargo.includes(`version = "${raw}"`)) {
  console.error("Could not find the [package] version in Cargo.toml");
  process.exit(1);
}
writeFileSync(cargoPath, updated);
console.log(`App version set to ${raw}`);
