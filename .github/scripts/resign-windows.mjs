#!/usr/bin/env node
// After SignPath has Authenticode-signed the Windows installers, their bytes
// changed, so the updater signatures (.sig, minisign) made by tauri-action no
// longer match. This script, run in the release workflow:
//   1. signs each signed installer again with the updater key (tauri signer),
//   2. rewrites the matching "signature" fields in latest.json.
// Usage: node resign-windows.mjs <dir with signed installers> <latest.json>
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [dir, latestPath] = process.argv.slice(2);
if (!dir || !latestPath) {
  console.error("usage: resign-windows.mjs <signed-dir> <latest.json>");
  process.exit(1);
}

const installers = readdirSync(dir).filter((f) => /\.(exe|msi)$/i.test(f));
if (installers.length === 0) throw new Error(`No signed installers in ${dir}`);

const latest = JSON.parse(readFileSync(latestPath, "utf8"));
for (const file of installers) {
  const path = join(dir, file);
  // Uses TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD from the env.
  execFileSync("npx", ["--yes", "@tauri-apps/cli@2", "signer", "sign", path], { stdio: "inherit", shell: process.platform === "win32" });
  const signature = readFileSync(`${path}.sig`, "utf8").trim();
  let patched = 0;
  for (const entry of Object.values(latest.platforms ?? {})) {
    if (decodeURIComponent(basename(new URL(entry.url).pathname)) === file) {
      entry.signature = signature;
      patched++;
    }
  }
  console.log(`${file}: updater signature regenerated, ${patched} latest.json entr${patched === 1 ? "y" : "ies"} patched`);
}
writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n");
