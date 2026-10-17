import { describe, it, expect } from "vitest";
import { cloudLabel, isCloud } from "../services/cloud";
import { translate, type MessageKey } from "../i18n";
import type { CloudProvider } from "../services/tauriBridge";

const tEn = (key: MessageKey, params?: Record<string, string | number>) => translate("en", key, params);
const tEs = (key: MessageKey, params?: Record<string, string | number>) => translate("es", key, params);

describe("cloud location labels", () => {
  it("names the provider and appends the account when known", () => {
    expect(cloudLabel({ provider: "google_drive", account: "ana@gmail.com" }, tEn)).toBe("Google Drive · ana@gmail.com");
    expect(cloudLabel({ provider: "dropbox", account: null }, tEn)).toBe("Dropbox");
    expect(cloudLabel({ provider: "local", account: null }, tEn)).toBe("Local folder");
    expect(cloudLabel({ provider: "local", account: null }, tEs)).toBe("Carpeta local");
  });

  it("has a label for every provider the backend can report", () => {
    const providers: CloudProvider[] = ["google_drive", "onedrive", "dropbox", "icloud", "box", "local"];
    for (const provider of providers) {
      for (const t of [tEn, tEs]) {
        expect(cloudLabel({ provider, account: null }, t)).not.toContain("cloud.provider");
      }
    }
  });

  it("treats only real providers as cloud", () => {
    expect(isCloud({ provider: "icloud", account: null })).toBe(true);
    expect(isCloud({ provider: "local", account: null })).toBe(false);
    expect(isCloud(null)).toBe(false);
  });
});
