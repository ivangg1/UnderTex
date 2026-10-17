// Recently opened project folders (localStorage), newest first.

export const RECENTS_KEY = "latex_recent_projects";
export const MAX_RECENTS = 8;

export interface RecentProject {
  path: string;
  mainFile: string;
  openedAt: number;
}

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readRecents(store: Storage | null = storage()): RecentProject[] {
  if (!store) return [];
  try {
    const raw = store.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentProject =>
        typeof r === "object" && r !== null && typeof (r as RecentProject).path === "string"
    );
  } catch {
    return [];
  }
}

/** Moves `project` to the front (dedup by path), caps the list, persists it and returns it. */
export function addRecent(
  project: Omit<RecentProject, "openedAt">,
  now: number = Date.now(),
  store: Storage | null = storage()
): RecentProject[] {
  const rest = readRecents(store).filter((r) => r.path !== project.path);
  const next = [{ ...project, openedAt: now }, ...rest].slice(0, MAX_RECENTS);
  try {
    store?.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode errors
  }
  return next;
}

export function removeRecent(path: string, store: Storage | null = storage()): RecentProject[] {
  const next = readRecents(store).filter((r) => r.path !== path);
  try {
    store?.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
