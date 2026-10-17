// Decides what to tell a guest about the host's cloud folder, and where to get
// the sync client. Pure functions so the policy is unit-tested.

import type { CloudLocation, CloudProvider } from "./tauriBridge";

export type CloudAssist =
  | { kind: "none" }
  /** The host's files live in a cloud the guest has not installed. */
  | { kind: "install"; provider: CloudProvider }
  /** The client is installed; the shared folder has not shown up (yet). */
  | { kind: "locate"; provider: CloudProvider }
  /** The guest already works in a folder synced by the same provider. */
  | { kind: "ready"; provider: CloudProvider };

export interface CloudAssistInput {
  /** Cloud info published by the host in the room (null until received). */
  roomCloud: CloudLocation | null;
  /** Providers with a sync folder on this machine. */
  installedProviders: string[];
  /** Whether the current project is an app-managed workspace (joined without a folder). */
  isWorkspace: boolean;
  /** Where the guest's own project folder lives. */
  localCloud: CloudLocation | null;
}

export function decideCloudAssist(input: CloudAssistInput): CloudAssist {
  const cloud = input.roomCloud;
  if (!cloud || cloud.provider === "local") return { kind: "none" };
  if (!input.isWorkspace) {
    return input.localCloud?.provider === cloud.provider ? { kind: "ready", provider: cloud.provider } : { kind: "none" };
  }
  if (!input.installedProviders.includes(cloud.provider)) return { kind: "install", provider: cloud.provider };
  return { kind: "locate", provider: cloud.provider };
}

const DOWNLOADS: Record<Exclude<CloudProvider, "local">, { macos: string; windows: string; linux: string }> = {
  google_drive: {
    macos: "https://www.google.com/drive/download/",
    windows: "https://www.google.com/drive/download/",
    linux: "https://www.insynchq.com/downloads",
  },
  onedrive: {
    macos: "https://www.microsoft.com/microsoft-365/onedrive/download",
    windows: "https://www.microsoft.com/microsoft-365/onedrive/download",
    linux: "https://github.com/abraunegg/onedrive",
  },
  dropbox: {
    macos: "https://www.dropbox.com/install",
    windows: "https://www.dropbox.com/install",
    linux: "https://www.dropbox.com/install-linux",
  },
  icloud: {
    macos: "https://support.apple.com/guide/mac-help/set-up-icloud-drive-mchl2ea8ca3f/mac",
    windows: "https://apps.microsoft.com/detail/9pktq5699m62",
    linux: "https://www.icloud.com/iclouddrive",
  },
  box: {
    macos: "https://www.box.com/resources/downloads",
    windows: "https://www.box.com/resources/downloads",
    linux: "https://www.box.com/resources/downloads",
  },
};

export function providerDownloadUrl(provider: CloudProvider, os: "macos" | "windows" | "linux"): string | null {
  if (provider === "local") return null;
  return DOWNLOADS[provider][os];
}

/** True when `path` is inside the app-managed room workspaces folder. */
export function isRoomWorkspace(path: string | null, workspacesDir: string | null): boolean {
  if (!path || !workspacesDir) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(path).startsWith(norm(workspacesDir) + "/");
}

/**
 * Text used to seed a session's document. An app-managed room workspace has no
 * content of its own (its main.tex is a placeholder or a cache of the swarm), so
 * it never seeds: it only receives the room's document from peers or from its
 * persisted CRDT state. Seeding a placeholder would leak into the room and, once
 * the real cloud folder shows up, overwrite the real file.
 */
export function seedTextFor(path: string, workspacesDir: string | null, fileText: string): string {
  return isRoomWorkspace(path, workspacesDir) ? "" : fileText;
}
