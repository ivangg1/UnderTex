#!/usr/bin/env node
// Downloads the Tectonic release binary for a Rust target triple and stores it
// where Tauri expects an `externalBin` sidecar:
//   src-tauri/binaries/tectonic-<triple>[.exe]
// Used by the release workflow so installers ship a LaTeX engine and users do
// not have to install anything. Usage:
//   node scripts/fetch-tectonic.mjs aarch64-apple-darwin
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TECTONIC_VERSION = "0.17.0";

/** Release asset for each target the app is built for. */
export const ASSETS = {
  "aarch64-apple-darwin": "aarch64-apple-darwin.tar.gz",
  "x86_64-apple-darwin": "x86_64-apple-darwin.tar.gz",
  // The msvc build needs the VC++ runtime, which the app itself already requires.
  "x86_64-pc-windows-msvc": "x86_64-pc-windows-msvc.zip",
  // musl: static, runs on any glibc version.
  "x86_64-unknown-linux-gnu": "x86_64-unknown-linux-musl.tar.gz",
  "aarch64-unknown-linux-gnu": "aarch64-unknown-linux-musl.tar.gz",
};

export function assetUrl(triple, version = TECTONIC_VERSION) {
  const asset = ASSETS[triple];
  if (!asset) throw new Error(`No Tectonic build mapped for target "${triple}"`);
  return `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${version}/tectonic-${version}-${asset}`;
}

export function sidecarName(triple) {
  return `tectonic-${triple}${triple.includes("windows") ? ".exe" : ""}`;
}

async function main() {
  const triple = (process.argv[2] ?? "").trim();
  const url = assetUrl(triple);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(root, "src-tauri", "binaries");
  const out = join(outDir, sidecarName(triple));
  mkdirSync(outDir, { recursive: true });

  const work = mkdtempSync(join(tmpdir(), "tectonic-"));
  try {
    const archive = join(work, url.endsWith(".zip") ? "t.zip" : "t.tar.gz");
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // bsdtar (macOS, Windows) and GNU tar extract .tar.gz; bsdtar also reads .zip.
    execFileSync("tar", ["-xf", archive, "-C", work], { stdio: "inherit" });
    const bin = readdirSync(work).find((f) => f === "tectonic" || f === "tectonic.exe");
    if (!bin) throw new Error("tectonic binary not found in the archive");
    copyFileSync(join(work, bin), out);
    if (!triple.includes("windows")) chmodSync(out, 0o755);
    if (!existsSync(out)) throw new Error("copy failed");
    console.log(`Bundled Tectonic ${TECTONIC_VERSION} → ${out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
