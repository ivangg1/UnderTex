// Auto-update: checks GitHub releases (tauri-plugin-updater), downloads the
// new version in the background and lets the UI offer a restart.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; progress: number | null }
  | { status: "ready"; version: string; notes: string | null }
  /** Reported only for manual checks, so the user gets an answer. */
  | { status: "uptodate"; checkedAt: number }
  | { status: "error"; message: string };

export interface UpdaterCallbacks {
  onState: (state: UpdateState) => void;
}

/** Hours between periodic checks while the app stays open. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Delay after startup before the first check (lets the window settle). */
export const FIRST_CHECK_DELAY_MS = 8_000;

let pendingUpdate: Update | null = null;
let inFlight: Promise<string | null> | null = null;

/**
 * Checks for an update and, when one exists, downloads and stages it.
 * Resolves to the staged version or `null`. Never throws: errors are reported
 * through `onState`.
 */
export function checkAndStageUpdate(callbacks: UpdaterCallbacks, opts: { manual?: boolean } = {}): Promise<string | null> {
  // A staged update is already waiting: just show it again.
  if (pendingUpdate) {
    callbacks.onState({ status: "ready", version: pendingUpdate.version, notes: pendingUpdate.body ?? null });
    return Promise.resolve(pendingUpdate.version);
  }
  // Never run two checks/downloads at once (manual click during the periodic check).
  if (inFlight) return inFlight;
  inFlight = runCheck(callbacks, opts.manual ?? false).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCheck(callbacks: UpdaterCallbacks, manual: boolean): Promise<string | null> {
  callbacks.onState({ status: "checking" });
  try {
    const update = await check();
    if (!update) {
      callbacks.onState(manual ? { status: "uptodate", checkedAt: Date.now() } : { status: "idle" });
      return null;
    }
    let total: number | null = null;
    let received = 0;
    callbacks.onState({ status: "downloading", version: update.version, progress: null });
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        callbacks.onState({
          status: "downloading",
          version: update.version,
          progress: total ? Math.min(1, received / total) : null,
        });
      }
    });
    pendingUpdate = update;
    callbacks.onState({ status: "ready", version: update.version, notes: update.body ?? null });
    return update.version;
  } catch (err) {
    callbacks.onState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Installs the staged update and relaunches. Caller flushes unsaved work first. */
export async function installStagedUpdateAndRelaunch(): Promise<void> {
  if (!pendingUpdate) return;
  await pendingUpdate.install();
  await relaunch();
}
