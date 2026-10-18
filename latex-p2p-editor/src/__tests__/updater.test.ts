import { describe, it, expect, vi, beforeEach } from "vitest";

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

async function fresh() {
  vi.resetModules();
  return import("../services/updater");
}

beforeEach(() => {
  check.mockClear();
});

describe("updater", () => {
  it("answers a manual check with 'uptodate' but stays silent for automatic checks", async () => {
    const { checkAndStageUpdate } = await fresh();
    check.mockResolvedValue(null);
    const manual: string[] = [];
    await checkAndStageUpdate({ onState: (s) => manual.push(s.status) }, { manual: true });
    expect(manual).toEqual(["checking", "uptodate"]);

    const auto: string[] = [];
    await checkAndStageUpdate({ onState: (s) => auto.push(s.status) });
    expect(auto).toEqual(["checking", "idle"]);
  });

  it("downloads once, reports progress, and reuses the staged update on the next check", async () => {
    const { checkAndStageUpdate } = await fresh();
    const download = vi.fn(async (cb: (e: unknown) => void) => {
      cb({ event: "Started", data: { contentLength: 100 } });
      cb({ event: "Progress", data: { chunkLength: 50 } });
      cb({ event: "Progress", data: { chunkLength: 50 } });
      cb({ event: "Finished", data: {} });
    });
    check.mockResolvedValue({ version: "0.1.7", body: "notes", download, install: vi.fn() });

    const states: unknown[] = [];
    expect(await checkAndStageUpdate({ onState: (s) => states.push(s) }, { manual: true })).toBe("0.1.7");
    expect(states).toContainEqual({ status: "downloading", version: "0.1.7", progress: 0.5 });
    expect(states.at(-1)).toEqual({ status: "ready", version: "0.1.7", notes: "notes" });

    const again: unknown[] = [];
    expect(await checkAndStageUpdate({ onState: (s) => again.push(s) }, { manual: true })).toBe("0.1.7");
    expect(again).toEqual([{ status: "ready", version: "0.1.7", notes: "notes" }]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("never runs two checks at once", async () => {
    const { checkAndStageUpdate } = await fresh();
    let resolve!: (v: null) => void;
    check.mockReturnValue(new Promise((r) => (resolve = r)));
    const a = checkAndStageUpdate({ onState: () => undefined });
    const b = checkAndStageUpdate({ onState: () => undefined }, { manual: true });
    resolve(null);
    await Promise.all([a, b]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("reports a failed check as an error state instead of throwing", async () => {
    const { checkAndStageUpdate } = await fresh();
    check.mockImplementation(async () => {
      throw new Error("offline");
    });
    const states: unknown[] = [];
    let result: string | null | undefined;
    let thrown: unknown = null;
    try {
      result = await checkAndStageUpdate({ onState: (st) => states.push(st) }, { manual: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
    expect(result).toBeNull();
    expect(states.at(-1)).toEqual({ status: "error", message: "offline" });
  });
});
