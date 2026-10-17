// Minimal-edit replacement of a Y.Text and line diffs for the history view.
//
// Restoring a version by "delete everything, insert everything" would move
// every remote cursor to the top and bloat the CRDT. Applying a line diff keeps
// untouched regions intact.

import { diffLines, type Change } from "diff";
import type * as Y from "yjs";

export interface DiffHunkLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Line-level diff from `before` to `after`, flattened to one entry per line. */
export function lineDiff(before: string, after: string): DiffHunkLine[] {
  const out: DiffHunkLine[] = [];
  for (const part of diffLines(before, after)) {
    const kind: DiffHunkLine["kind"] = part.added ? "added" : part.removed ? "removed" : "same";
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop(); // trailing newline
    for (const text of lines) out.push({ kind, text });
  }
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: DiffHunkLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "added") added++;
    else if (l.kind === "removed") removed++;
  }
  return { added, removed };
}

/**
 * Edits `ytext` in place so that it ends up equal to `next`, using line-level
 * diff operations inside a single transaction. Returns the number of
 * operations applied (0 when the texts were already equal).
 */
export function applyTextDiff(ytext: Y.Text, next: string, origin: unknown = "restore"): number {
  const current = ytext.toString();
  if (current === next) return 0;
  const changes: Change[] = diffLines(current, next);
  let ops = 0;
  ytext.doc?.transact(() => {
    let index = 0;
    for (const change of changes) {
      if (change.removed) {
        ytext.delete(index, change.value.length);
        ops++;
      } else if (change.added) {
        ytext.insert(index, change.value);
        index += change.value.length;
        ops++;
      } else {
        index += change.value.length;
      }
    }
  }, origin);
  return ops;
}
