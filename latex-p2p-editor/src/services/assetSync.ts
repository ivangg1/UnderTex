// Asset sync: peer-to-peer transfer of the project files a build needs.
//
// Collaboration syncs the root .tex as CRDT text. Images, .bib, .sty and
// \input/\include chapters only exist in the folder of whoever has them, so a
// guest who joins by room ID could not compile. This module shares them through
// the same Y.Doc and WebRTC connections:
//
// * `assets` (Y.Map path → {hash, size, by}): the room's manifest. Every peer
//   publishes the shareable files of its own folder (listed and hashed by Rust).
//   An entry published by a peer that is online is only overwritten when the
//   local file changes during the session, so a guest's stale copy never
//   replaces the host's version.
// * awareness `assets`: hash prefixes this peer can send (folder + room cache).
//   It disappears with the peer, which is how "host offline" is detected.
// * `assetRequests` (Y.Map "<clientID>:<hash>" → {hash, path, next}): a
//   download in progress; `next` acknowledges the chunks received so far.
// * `assetChunks` (Y.Map "<hash>:<index>" → Uint8Array): 16 KiB chunks. The
//   serving peer (lowest clientID among the online peers that have the file)
//   keeps at most WINDOW chunks per file in the map and deletes acknowledged
//   ones, so the document never holds more than a sliding window: each update
//   stays well below WebRTC's message size limit and a late joiner's initial
//   sync stays small.
//
// Received files are verified (SHA-256, in Rust) and stored in a per-room cache
// in the app data dir; the compiler merges that cache under the local folder.
// Nothing is written into the user's project folder.

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { AssetEntry } from "./tauriBridge";

export type { AssetEntry };

export const ASSETS_KEY = "assets";
export const ASSET_REQUESTS_KEY = "assetRequests";
export const ASSET_CHUNKS_KEY = "assetChunks";
/** Transaction origin of every write made by this module. */
export const ASSET_ORIGIN = "assets";

export const ASSET_CHUNK_BYTES = 16 * 1024;
/** Chunks of one file that may sit in the document at the same time. */
export const ASSET_WINDOW = 8;
export const DEFAULT_ASSET_MAX_BYTES = 20 * 1024 * 1024;
/** localStorage key with a user-chosen per-file limit, in MB. */
export const ASSET_MAX_MB_KEY = "latex_asset_max_mb";
/** Length of the hash prefixes advertised in awareness (64 bits). */
export const ADVERTISED_HASH_CHARS = 16;

export interface ManifestEntry {
  hash: string;
  size: number;
  /** clientID of the peer that published this version. */
  by: number;
}

interface RequestEntry {
  hash: string;
  path: string;
  /** Number of contiguous chunks received (= index of the next one wanted). */
  next: number;
}

/** File access needed by the protocol; Tauri commands in the app, in-memory in tests. */
export interface AssetIO {
  listLocal(): Promise<AssetEntry[]>;
  listCache(): Promise<AssetEntry[]>;
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
  storeCache(entry: AssetEntry, bytes: Uint8Array): Promise<AssetEntry>;
  pruneCache(keep: AssetEntry[]): Promise<number>;
}

/**
 * - `local`: in this peer's project folder (always wins).
 * - `cached`: received from a peer, current version.
 * - `downloading`: being received now.
 * - `queued`: a peer has it; waiting for its turn.
 * - `unavailable`: no peer that has it is online.
 * - `tooLarge`: above the per-file transfer limit.
 * - `failed`: the last attempt failed; it is retried shortly.
 */
export type AssetState = "local" | "cached" | "downloading" | "queued" | "unavailable" | "tooLarge" | "failed";

export interface AssetStatusItem {
  path: string;
  size: number;
  state: AssetState;
}

export interface AssetSyncStatus {
  total: number;
  /** `local` + `cached`. */
  synced: number;
  missing: number;
  unavailable: number;
  tooLarge: number;
  downloading: { path: string; size: number; received: number } | null;
  /** Files this peer is currently sending. */
  uploading: number;
  maxBytes: number;
  items: AssetStatusItem[];
}

export const EMPTY_ASSET_STATUS: AssetSyncStatus = {
  total: 0,
  synced: 0,
  missing: 0,
  unavailable: 0,
  tooLarge: 0,
  downloading: null,
  uploading: 0,
  maxBytes: DEFAULT_ASSET_MAX_BYTES,
  items: [],
};

/** Per-file transfer limit: user setting (MB, localStorage) or the 20 MB default. */
export function readAssetMaxBytes(): number {
  try {
    const raw = Number(globalThis.localStorage?.getItem(ASSET_MAX_MB_KEY));
    if (Number.isFinite(raw) && raw > 0) return Math.round(raw * 1024 * 1024);
  } catch {
    // storage unavailable
  }
  return DEFAULT_ASSET_MAX_BYTES;
}

/** True when a transaction only touched the asset maps (no reason to rewrite main.tex). */
export function isAssetOnlyTransaction(doc: Y.Doc, tr: Y.Transaction): boolean {
  if (tr.changed.size === 0) return false;
  const assetTypes = new Set<unknown>([
    doc.getMap(ASSETS_KEY),
    doc.getMap(ASSET_REQUESTS_KEY),
    doc.getMap(ASSET_CHUNKS_KEY),
  ]);
  for (const type of tr.changed.keys()) {
    if (!assetTypes.has(type)) return false;
  }
  return true;
}

export const chunkCount = (size: number) => Math.ceil(size / ASSET_CHUNK_BYTES);
const chunkKey = (hash: string, index: number) => `${hash}:${index}`;
const prefix = (hash: string) => hash.slice(0, ADVERTISED_HASH_CHARS);

interface Download {
  path: string;
  hash: string;
  size: number;
  total: number;
  parts: Uint8Array[];
  next: number;
  storing: boolean;
  lastProgress: number;
}

export interface AssetSyncOptions {
  doc: Y.Doc;
  awareness: Awareness;
  io: AssetIO;
  maxBytes?: number;
  /** Rescan of the project folder. Default 4000 ms. */
  scanIntervalMs?: number;
  /** A download without progress for this long is restarted. Default 30000 ms. */
  stallMs?: number;
  /** Delay before retrying a failed file. Default 10000 ms. */
  retryMs?: number;
  onChange?: (status: AssetSyncStatus) => void;
}

export class AssetSync {
  public status: AssetSyncStatus;

  private readonly doc: Y.Doc;
  private readonly awareness: Awareness;
  private readonly io: AssetIO;
  private readonly maxBytes: number;
  private readonly scanIntervalMs: number;
  private readonly stallMs: number;
  private readonly retryMs: number;
  private readonly onChange?: (status: AssetSyncStatus) => void;
  private readonly manifest: Y.Map<ManifestEntry>;
  private readonly requests: Y.Map<RequestEntry>;
  private readonly chunks: Y.Map<Uint8Array>;

  private local = new Map<string, AssetEntry>();
  private cache = new Map<string, AssetEntry>();
  /** Local hashes of the previous scan (null before the first one). */
  private previousLocal: Map<string, string> | null = null;
  private download: Download | null = null;
  private readonly reading = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private serving = new Set<string>();
  private advertised = "";
  private started = false;
  private destroyed = false;
  private scanning: Promise<void> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AssetSyncOptions) {
    this.doc = options.doc;
    this.awareness = options.awareness;
    this.io = options.io;
    this.maxBytes = options.maxBytes ?? DEFAULT_ASSET_MAX_BYTES;
    this.scanIntervalMs = options.scanIntervalMs ?? 4000;
    this.stallMs = options.stallMs ?? 30000;
    this.retryMs = options.retryMs ?? 10000;
    this.onChange = options.onChange;
    this.manifest = this.doc.getMap<ManifestEntry>(ASSETS_KEY);
    this.requests = this.doc.getMap<RequestEntry>(ASSET_REQUESTS_KEY);
    this.chunks = this.doc.getMap<Uint8Array>(ASSET_CHUNKS_KEY);
    this.status = { ...EMPTY_ASSET_STATUS, maxBytes: this.maxBytes };
  }

  /**
   * Starts publishing and downloading. Call it once the peer holds the room's
   * state (synced, or alone), so the manifest it compares against is current.
   */
  public start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.manifest.observe(this.schedulePump);
    this.requests.observe(this.schedulePump);
    this.chunks.observe(this.schedulePump);
    this.awareness.on("change", this.schedulePump);
    this.scanTimer = setInterval(() => void this.rescan(), this.scanIntervalMs);
    void this.rescan();
  }

  /** Re-reads the folder and the cache now (e.g. after a build reported a missing file). */
  public rescan(): Promise<void> {
    if (this.destroyed || !this.started) return Promise.resolve();
    if (!this.scanning) {
      this.scanning = this.scan().finally(() => {
        this.scanning = null;
      });
    }
    return this.scanning;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.scanTimer = null;
    this.pumpTimer = null;
    if (this.started) {
      this.manifest.unobserve(this.schedulePump);
      this.requests.unobserve(this.schedulePump);
      this.chunks.unobserve(this.schedulePump);
      this.awareness.off("change", this.schedulePump);
    }
    try {
      if (this.download) this.requests.delete(this.requestKey(this.download.hash));
      if (this.awareness.getLocalState()?.assets) this.awareness.setLocalStateField("assets", undefined);
    } catch {
      // document already destroyed
    }
    this.download = null;
  }

  // ─── Scan, publish, advertise, prune ──────────────────────────────

  private async scan(): Promise<void> {
    let local: AssetEntry[];
    let cached: AssetEntry[];
    try {
      [local, cached] = await Promise.all([this.io.listLocal(), this.io.listCache()]);
    } catch (err) {
      console.error("AssetSync: scan failed:", err);
      return;
    }
    if (this.destroyed) return;
    this.local = new Map(local.map((e) => [e.path, e]));
    this.cache = new Map(cached.map((e) => [e.path, e]));
    this.publish();
    this.advertise();
    this.checkStall();
    await this.prune();
    this.pump();
  }

  private online(): Set<number> {
    return new Set(this.awareness.getStates().keys());
  }

  private publish(): void {
    const me = this.doc.clientID;
    const online = this.online();
    const previous = this.previousLocal;
    this.doc.transact(() => {
      this.local.forEach((entry, path) => {
        const current = this.manifest.get(path);
        const changedHere = previous !== null && previous.get(path) !== entry.hash;
        const ownerAway = current !== undefined && current.by !== me && !online.has(current.by);
        // New path; or a different version that is ours, whose publisher is gone
        // (e.g. a persisted manifest from an earlier session) or that the user just
        // changed here. Identical copies of an absent publisher's file are adopted
        // too, so the room keeps a live owner for them.
        const publish =
          !current ||
          (current.hash !== entry.hash && (current.by === me || ownerAway || changedHere)) ||
          (current.hash === entry.hash && ownerAway);
        if (publish) {
          this.manifest.set(path, { hash: entry.hash, size: entry.size, by: me });
        }
      });
      if (previous) {
        this.manifest.forEach((entry, path) => {
          const deletedHere = previous.get(path) === entry.hash && !this.local.has(path);
          if (deletedHere && (entry.by === me || !online.has(entry.by))) {
            this.manifest.delete(path);
          }
        });
      }
    }, ASSET_ORIGIN);
    this.previousLocal = new Map(Array.from(this.local, ([path, e]) => [path, e.hash]));
  }

  /** Path this peer can read `hash` from (project folder first, then the cache). */
  private pathForHash(hash: string): AssetEntry | null {
    for (const entry of this.local.values()) if (entry.hash === hash) return entry;
    for (const entry of this.cache.values()) {
      // A cached file shadowed by a local one with the same path cannot be read back.
      if (entry.hash === hash && !this.local.has(entry.path)) return entry;
    }
    return null;
  }

  private advertise(): void {
    const hashes = new Set<string>();
    this.local.forEach((e) => {
      if (e.size <= this.maxBytes) hashes.add(prefix(e.hash));
    });
    this.cache.forEach((e) => {
      if (!this.local.has(e.path)) hashes.add(prefix(e.hash));
    });
    const list = Array.from(hashes).sort();
    const key = list.join(",");
    if (key !== this.advertised) {
      this.advertised = key;
      this.awareness.setLocalStateField("assets", list);
    }
  }

  /** Drops cached files the room no longer has, older versions and local overrides. */
  private async prune(): Promise<void> {
    const keep: AssetEntry[] = [];
    let stale = 0;
    this.cache.forEach((entry, path) => {
      const wanted = this.manifest.get(path);
      if (wanted && wanted.hash === entry.hash && !this.local.has(path)) keep.push(entry);
      else stale++;
    });
    if (stale === 0) return;
    try {
      await this.io.pruneCache(keep);
      this.cache = new Map(keep.map((e) => [e.path, e]));
    } catch (err) {
      console.error("AssetSync: prune failed:", err);
    }
  }

  // ─── Transfer ─────────────────────────────────────────────────────

  private readonly schedulePump = (): void => {
    if (this.destroyed || this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, 0);
  };

  private requestKey(hash: string, clientID = this.doc.clientID): string {
    return `${clientID}:${hash}`;
  }

  /** Online peers other than `except` that advertise `hash`, lowest clientID first. */
  private providers(hash: string, except: number): number[] {
    const p = prefix(hash);
    const ids: number[] = [];
    this.awareness.getStates().forEach((state, clientID) => {
      const list = (state as { assets?: unknown }).assets;
      if (clientID !== except && Array.isArray(list) && list.includes(p)) ids.push(clientID);
    });
    return ids.sort((a, b) => a - b);
  }

  /** Files of the manifest this peer still needs. */
  private wanted(): Array<[string, ManifestEntry]> {
    const out: Array<[string, ManifestEntry]> = [];
    this.manifest.forEach((entry, path) => {
      if (this.local.has(path) || this.cache.get(path)?.hash === entry.hash) return;
      if (entry.size > this.maxBytes) return;
      out.push([path, entry]);
    });
    return out.sort((a, b) => a[1].size - b[1].size || a[0].localeCompare(b[0]));
  }

  private pump(): void {
    if (this.destroyed || !this.started) return;
    const online = this.online();
    this.doc.transact(() => {
      this.housekeeping(online);
      this.pumpDownload();
      this.pumpServing(online);
    }, ASSET_ORIGIN);
    this.emitStatus();
  }

  /**
   * Requests of peers that left and chunks nobody waits for are deleted, by the
   * lowest online clientID only (fewer concurrent deletes). A requester whose
   * request was removed by mistake (its awareness had not arrived yet) simply
   * writes it again on its next pump.
   */
  private housekeeping(online: Set<number>): void {
    if (Math.min(...online) !== this.doc.clientID) return;
    const liveHashes = new Set<string>();
    this.requests.forEach((req, key) => {
      const requester = Number(key.slice(0, key.indexOf(":")));
      if (!online.has(requester)) this.requests.delete(key);
      else liveHashes.add(req.hash);
    });
    this.chunks.forEach((_bytes, key) => {
      if (!liveHashes.has(key.slice(0, key.lastIndexOf(":")))) this.chunks.delete(key);
    });
  }

  private pumpDownload(): void {
    const me = this.doc.clientID;
    let dl = this.download;
    if (dl && !dl.storing) {
      const current = this.manifest.get(dl.path);
      const gone = !current || current.hash !== dl.hash || this.local.has(dl.path);
      // The sender left and nobody else has the file: report it unavailable.
      const orphaned = dl.total > 0 && this.providers(dl.hash, me).length === 0;
      if (gone || orphaned) {
        this.requests.delete(this.requestKey(dl.hash));
        this.download = dl = null;
      }
    }
    if (!dl) {
      const now = Date.now();
      for (const [path, entry] of this.wanted()) {
        if ((this.retryAfter.get(entry.hash) ?? 0) > now) continue;
        if (entry.size > 0 && this.providers(entry.hash, me).length === 0) continue;
        dl = {
          path,
          hash: entry.hash,
          size: entry.size,
          total: chunkCount(entry.size),
          parts: [],
          next: 0,
          storing: false,
          lastProgress: now,
        };
        this.download = dl;
        if (dl.total > 0) this.requests.set(this.requestKey(dl.hash), { hash: dl.hash, path, next: 0 });
        break;
      }
    }
    if (!dl || dl.storing) return;
    if (dl.total > 0 && !this.requests.has(this.requestKey(dl.hash))) {
      this.requests.set(this.requestKey(dl.hash), { hash: dl.hash, path: dl.path, next: dl.next });
    }

    const before = dl.next;
    let bytes: Uint8Array | undefined;
    while (dl.next < dl.total && (bytes = this.chunks.get(chunkKey(dl.hash, dl.next))) instanceof Uint8Array) {
      dl.parts[dl.next] = bytes;
      dl.next++;
    }
    if (dl.next !== before) {
      dl.lastProgress = Date.now();
      if (dl.next < dl.total) this.requests.set(this.requestKey(dl.hash), { hash: dl.hash, path: dl.path, next: dl.next });
    }
    if (dl.next >= dl.total) {
      this.requests.delete(this.requestKey(dl.hash));
      void this.finishDownload(dl);
    }
  }

  private async finishDownload(dl: Download): Promise<void> {
    dl.storing = true;
    const bytes = new Uint8Array(dl.size);
    let offset = 0;
    for (const part of dl.parts) {
      bytes.set(part.subarray(0, Math.min(part.length, dl.size - offset)), offset);
      offset += part.length;
    }
    try {
      if (offset !== dl.size) throw new Error(`size mismatch: got ${offset} of ${dl.size} bytes`);
      const stored = await this.io.storeCache({ path: dl.path, size: dl.size, hash: dl.hash }, bytes);
      if (this.destroyed) return;
      this.cache.set(stored.path, stored);
      this.retryAfter.delete(dl.hash);
      this.advertise();
    } catch (err) {
      console.error(`AssetSync: could not store ${dl.path}:`, err);
      this.retryAfter.set(dl.hash, Date.now() + this.retryMs);
    }
    if (this.destroyed) return;
    if (this.download === dl) this.download = null;
    this.schedulePump();
  }

  private checkStall(): void {
    const dl = this.download;
    if (!dl || dl.storing || Date.now() - dl.lastProgress < this.stallMs) return;
    this.doc.transact(() => this.requests.delete(this.requestKey(dl.hash)), ASSET_ORIGIN);
    this.retryAfter.set(dl.hash, Date.now() + this.retryMs);
    this.download = null;
  }

  private pumpServing(online: Set<number>): void {
    const me = this.doc.clientID;
    const byHash = new Map<string, number>(); // hash → lowest `next` among live requests
    this.requests.forEach((req, key) => {
      const requester = Number(key.slice(0, key.indexOf(":")));
      if (requester === me || !online.has(requester)) return;
      if (this.providers(req.hash, requester)[0] !== me) return;
      byHash.set(req.hash, Math.min(byHash.get(req.hash) ?? Infinity, req.next));
    });
    this.serving = new Set(byHash.keys());
    byHash.forEach((next, hash) => {
      const source = this.pathForHash(hash);
      if (!source || source.size > this.maxBytes) return;
      const total = chunkCount(source.size);
      this.chunks.forEach((_bytes, key) => {
        if (key.startsWith(`${hash}:`) && Number(key.slice(hash.length + 1)) < next) this.chunks.delete(key);
      });
      for (let i = next; i < Math.min(total, next + ASSET_WINDOW); i++) {
        const key = chunkKey(hash, i);
        if (this.chunks.has(key) || this.reading.has(key)) continue;
        this.reading.add(key);
        this.io
          .readChunk(source.path, i * ASSET_CHUNK_BYTES, ASSET_CHUNK_BYTES)
          .then((bytes) => {
            if (this.destroyed) return;
            // Still wanted? (the requester may have finished or left meanwhile)
            let needed = false;
            this.requests.forEach((req) => {
              if (req.hash === hash && req.next <= i) needed = true;
            });
            if (needed) this.doc.transact(() => this.chunks.set(key, bytes), ASSET_ORIGIN);
          })
          .catch((err) => console.error(`AssetSync: could not read ${source.path}:`, err))
          .finally(() => {
            this.reading.delete(key);
          });
      }
    });
  }

  // ─── Status ───────────────────────────────────────────────────────

  private emitStatus(): void {
    const me = this.doc.clientID;
    const now = Date.now();
    const dl = this.download;
    const items: AssetStatusItem[] = [];
    this.manifest.forEach((entry, path) => {
      let state: AssetState;
      if (this.local.has(path)) state = "local";
      else if (this.cache.get(path)?.hash === entry.hash) state = "cached";
      else if (entry.size > this.maxBytes) state = "tooLarge";
      else if (dl && dl.path === path && dl.hash === entry.hash) state = "downloading";
      else if ((this.retryAfter.get(entry.hash) ?? 0) > now) state = "failed";
      else if (this.providers(entry.hash, me).length > 0) state = "queued";
      else state = "unavailable";
      items.push({ path, size: entry.size, state });
    });
    items.sort((a, b) => a.path.localeCompare(b.path));
    const count = (...states: AssetState[]) => items.filter((i) => states.includes(i.state)).length;
    const synced = count("local", "cached");
    const next: AssetSyncStatus = {
      total: items.length,
      synced,
      missing: items.length - synced,
      unavailable: count("unavailable"),
      tooLarge: count("tooLarge"),
      downloading: dl
        ? { path: dl.path, size: dl.size, received: Math.min(dl.size, dl.next * ASSET_CHUNK_BYTES) }
        : null,
      uploading: this.serving.size,
      maxBytes: this.maxBytes,
      items,
    };
    if (JSON.stringify(next) !== JSON.stringify(this.status)) {
      this.status = next;
      this.onChange?.(next);
    }
  }
}

// ─── Explaining "file not found" build errors ──────────────────────

const MISSING_FILE_PATTERNS = [
  /Unable to load picture or PDF file '([^']+)'/g,
  /File `([^']+)' not found/g,
  /I can't find file `([^']+)'/g,
  /I couldn't open (?:database )?file ([^\s]+)/g,
  /could not find (?:the )?file [`'"]?([^`'"\s]+)/gi,
];

/** File names a LaTeX log reports as missing, in order of appearance. */
export function missingFilesInLog(logs: string): string[] {
  const found: string[] = [];
  for (const re of MISSING_FILE_PATTERNS) {
    for (const match of logs.matchAll(re)) {
      const name = match[1].replace(/^\.\//, "").replace(/[.,;:]+$/, "");
      if (name && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

function matchesAsset(path: string, name: string): boolean {
  if (path === name) return true;
  const stem = path.replace(/\.[^./]+$/, "");
  return stem === name || path.endsWith(`/${name}`) || stem.endsWith(`/${name}`);
}

export interface MissingAssetHint {
  path: string;
  state: Extract<AssetState, "downloading" | "queued" | "unavailable" | "tooLarge" | "failed">;
}

/**
 * When a build failed because a file is missing that the room shares but this
 * peer does not have yet, says which file and why (still downloading, nobody
 * online has it, too large). Returns null for genuinely missing files.
 */
export function explainMissingAsset(logs: string, status: AssetSyncStatus): MissingAssetHint | null {
  for (const name of missingFilesInLog(logs)) {
    const item = status.items.find((i) => matchesAsset(i.path, name));
    if (item && item.state !== "local" && item.state !== "cached") {
      return { path: item.path, state: item.state };
    }
  }
  return null;
}
