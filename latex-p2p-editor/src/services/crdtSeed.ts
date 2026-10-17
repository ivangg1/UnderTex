// Deterministic CRDT seeding.
//
// The classic Yjs pitfall: two peers that each insert the same initial text into
// their own empty Y.Doc produce two *different* insert operations (different
// clientIDs), so the first sync merges them into a document with the content
// duplicated. This happens whenever `.texcollab/crdt_state.bin` has not reached
// a peer yet (cloud sync lag) but `main.tex` has.
//
// Seeding through a throw-away doc whose clientID is derived from the text makes
// identical seeds produce byte-identical operations: Yjs deduplicates structs by
// (clientID, clock), so two peers seeding the same text converge to a single copy.
// Different texts hash to different clientIDs and are merged as two independent
// inserts (visible, never corrupt).

import * as Y from "yjs";

/** Yjs text key shared by the editor binding and persistence. */
export const TEXT_KEY = "codemirror";

/** FNV-1a 32-bit hash over the UTF-16 code units of `input`. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Stable clientID for seeding `text`. Yjs clientIDs are uint32; 0 is avoided so a
 * seed can never collide with a doc whose random id happens to be 0 after a reset.
 */
export function seedClientID(text: string): number {
  const hash = fnv1a32(text);
  return hash === 0 ? 1 : hash;
}

/**
 * Inserts `text` into `doc` (under `TEXT_KEY`) as a deterministic operation.
 * Returns the binary update that was applied so callers can persist or forward it.
 * No-op (returns an empty update) when `text` is empty.
 */
export function seedDocFromText(doc: Y.Doc, text: string): Uint8Array {
  return seedTextUnderKey(doc, TEXT_KEY, text);
}

/**
 * Like [`seedDocFromText`] for any top-level Y.Text (one per project file).
 * The clientID also hashes the key for every key but `TEXT_KEY` (kept as is so
 * peers on older versions still converge): struct IDs are global to the doc, so
 * two files with the same initial content must not produce the same IDs.
 */
export function seedTextUnderKey(doc: Y.Doc, key: string, text: string): Uint8Array {
  if (text.length === 0) {
    return new Uint8Array(0);
  }
  const seed = new Y.Doc();
  seed.clientID = seedClientID(key === TEXT_KEY ? text : `${key}\u0000${text}`);
  seed.getText(key).insert(0, text);
  const update = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  Y.applyUpdate(doc, update, "seed");
  return update;
}

/**
 * True when the Y.Text never held any content (no items, not even deleted
 * ones). A text emptied by a user is not pristine: seeding it again would
 * resurrect deleted content (and with deterministic IDs, silently do nothing).
 */
export function isPristineText(ytext: Y.Text): boolean {
  return ytext._start === null;
}
