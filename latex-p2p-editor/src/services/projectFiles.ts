// Helpers over the project file tree: flattening for quick open, merging the
// files peers share in a room into the local tree, fuzzy file search and
// mapping compiler diagnostics back to project files.

import type { ProjectNode } from "./tauriBridge";

/** A tree node; `remote` marks a file that only exists in the room (shared by a peer). */
export type TreeNode = Omit<ProjectNode, "children"> & { remote?: boolean; children?: TreeNode[] };

/** Every file path of the tree (depth first, in tree order). */
export function flattenFiles(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.is_dir) walk(node.children ?? []);
      else out.push(node.path);
    }
  };
  walk(nodes);
  return out;
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) =>
    a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
}

/**
 * Adds the files shared in the room that this folder does not have (a guest in
 * a temporary workspace sees the host's chapters), creating folders as needed.
 * The input tree is not modified.
 */
export function mergeSharedFiles(nodes: TreeNode[], shared: string[]): TreeNode[] {
  const clone = (list: TreeNode[]): TreeNode[] =>
    list.map((n) => (n.is_dir ? { ...n, children: clone(n.children ?? []) } : { ...n }));
  const root = clone(nodes);
  const existing = new Set(flattenFiles(root));
  let changed = false;
  for (const path of shared) {
    if (!path || existing.has(path)) continue;
    const parts = path.split("/");
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let dir = level.find((n) => n.is_dir && n.path === dirPath);
      if (!dir) {
        dir = { name: parts[i], path: dirPath, is_dir: true, children: [], remote: true };
        level.push(dir);
      }
      dir.children = dir.children ?? [];
      level = dir.children;
    }
    level.push({ name: parts[parts.length - 1], path, is_dir: false, remote: true });
    existing.add(path);
    changed = true;
  }
  if (!changed) return root;
  const sortAll = (list: TreeNode[]): TreeNode[] => {
    for (const n of list) if (n.is_dir && n.children) sortAll(n.children);
    return sortNodes(list);
  };
  return sortAll(root);
}

/** Whether `path` (a file or folder) is `target` or contains it. */
export function isSameOrInside(path: string, target: string): boolean {
  return target === path || target.startsWith(`${path}/`);
}

/** `target` with the `from` prefix (file or folder) replaced by `to`. */
export function renamePath(target: string, from: string, to: string): string {
  if (target === from) return to;
  return target.startsWith(`${from}/`) ? `${to}${target.slice(from.length)}` : target;
}

// ─── Fuzzy file search (quick open) ─────────────────────────────────

/**
 * Subsequence match of `query` in `candidate`, case-insensitive. Higher is
 * better; `null` when not every query character appears in order. Rewards
 * matches in the file name, at word starts (after `/`, `_`, `-`, `.`) and
 * consecutive runs; shorter paths win ties.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const c = candidate.toLowerCase();
  const nameStart = c.lastIndexOf("/") + 1;
  // Greedy matching from each possible first character; keep the best.
  let best: number | null = null;
  for (let start = c.indexOf(q[0]); start !== -1; start = c.indexOf(q[0], start + 1)) {
    const s = scoreFrom(q, c, start, nameStart);
    if (s !== null && (best === null || s > best)) best = s;
  }
  if (best === null) return null;
  if (c.slice(nameStart).startsWith(q)) best += 10;
  return best - candidate.length * 0.01;
}

function scoreFrom(q: string, c: string, start: number, nameStart: number): number | null {
  let score = 0;
  let ci = start;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = c.indexOf(q[qi], ci);
    if (found === -1) return null;
    const prev = found > 0 ? c[found - 1] : "/";
    let s = 1;
    if (found === ci && qi > 0) {
      run++;
      s += 2 * run;
    } else {
      run = 0;
    }
    if ("/_-. ".includes(prev)) s += 3;
    if (found >= nameStart) s += 2;
    score += s;
    ci = found + 1;
  }
  return score;
}

/** Best matches for `query` among `paths`, best first. */
export function rankFiles(query: string, paths: string[], limit = 50): string[] {
  if (!query.trim()) return paths.slice(0, limit);
  return paths
    .map((p) => ({ p, s: fuzzyScore(query, p) }))
    .filter((x): x is { p: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map((x) => x.p);
}

// ─── Diagnostics → project files ────────────────────────────────────

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Project file a compiler diagnostic refers to. Engines print paths relative to
 * the root file's directory (where they run), sometimes as `./x.tex` or as an
 * absolute path inside the build cache. Returns `null` when no known file matches
 * (e.g. a system package such as `article.cls`). No file means the root file.
 */
export function resolveDiagnosticFile(file: string | undefined, rootFile: string, knownFiles: string[]): string | null {
  if (!file) return rootFile;
  const known = new Set(knownFiles);
  known.add(rootFile);
  const slash = rootFile.lastIndexOf("/");
  const rootDir = slash === -1 ? "" : rootFile.slice(0, slash + 1);
  const raw = file.replace(/\\/g, "/");
  if (!raw.startsWith("/") && !/^[a-z]:\//i.test(raw)) {
    for (const candidate of [normalize(rootDir + raw), normalize(raw)]) {
      if (known.has(candidate)) return candidate;
    }
  }
  // Absolute (build cache) or unusual prefix: the longest known path it ends with.
  let best: string | null = null;
  for (const k of known) {
    if ((raw === k || raw.endsWith(`/${k}`)) && (!best || k.length > best.length)) best = k;
  }
  return best;
}
