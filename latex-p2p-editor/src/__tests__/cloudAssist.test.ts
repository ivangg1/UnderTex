import { describe, it, expect } from "vitest";
import { decideCloudAssist, providerDownloadUrl, isRoomWorkspace, seedTextFor } from "../services/cloudAssist";

const gd = { provider: "google_drive" as const, account: "ana@gmail.com" };
const local = { provider: "local" as const, account: null };

describe("decideCloudAssist", () => {
  it("does nothing until the host publishes a cloud location or when the host is local", () => {
    expect(decideCloudAssist({ roomCloud: null, installedProviders: [], isWorkspace: true, localCloud: null })).toEqual({ kind: "none" });
    expect(decideCloudAssist({ roomCloud: local, installedProviders: ["google_drive"], isWorkspace: true, localCloud: null })).toEqual({ kind: "none" });
  });

  it("asks to install the client when the guest lacks it, and to wait when it is installed", () => {
    expect(decideCloudAssist({ roomCloud: gd, installedProviders: ["dropbox"], isWorkspace: true, localCloud: null })).toEqual({
      kind: "install",
      provider: "google_drive",
    });
    expect(decideCloudAssist({ roomCloud: gd, installedProviders: ["google_drive"], isWorkspace: true, localCloud: null })).toEqual({
      kind: "locate",
      provider: "google_drive",
    });
  });

  it("reports ready when the guest already opened a folder synced by the same provider", () => {
    expect(decideCloudAssist({ roomCloud: gd, installedProviders: ["google_drive"], isWorkspace: false, localCloud: gd })).toEqual({
      kind: "ready",
      provider: "google_drive",
    });
    expect(decideCloudAssist({ roomCloud: gd, installedProviders: ["google_drive"], isWorkspace: false, localCloud: local })).toEqual({ kind: "none" });
  });
});

describe("providerDownloadUrl / isRoomWorkspace", () => {
  it("has a download page for every provider and OS, none for local", () => {
    for (const p of ["google_drive", "onedrive", "dropbox", "icloud", "box"] as const) {
      for (const os of ["macos", "windows", "linux"] as const) {
        expect(providerDownloadUrl(p, os)).toMatch(/^https:\/\//);
      }
    }
    expect(providerDownloadUrl("local", "macos")).toBeNull();
  });

  it("detects app-managed workspaces on both path styles", () => {
    expect(isRoomWorkspace("/Users/a/Library/Application Support/app/rooms/abc", "/Users/a/Library/Application Support/app/rooms")).toBe(true);
    expect(isRoomWorkspace("C:\\Users\\a\\AppData\\app\\rooms\\abc", "C:\\Users\\a\\AppData\\app\\rooms\\")).toBe(true);
    expect(isRoomWorkspace("/Users/a/Documents/rooms-notes", "/Users/a/Documents/rooms")).toBe(false);
    expect(isRoomWorkspace(null, "/x")).toBe(false);
    expect(isRoomWorkspace("/x/y", null)).toBe(false);
  });
});

describe("seedTextFor", () => {
  it("never seeds from an app-managed workspace, always from a real project folder", () => {
    const ws = "/Users/a/Library/Application Support/app/rooms";
    expect(seedTextFor(`${ws}/8478dc5f`, ws, "Hello, world!")).toBe("");
    expect(seedTextFor("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/thesis", ws, "Real thesis")).toBe("Real thesis");
    expect(seedTextFor("/Users/a/Documents/x", null, "x")).toBe("x");
  });
});
