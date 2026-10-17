// Display helpers for the cloud location of a project folder (detected in Rust, cloud.rs).

import type { MessageKey } from "../i18n";
import type { CloudLocation } from "./tauriBridge";

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function isCloud(loc: CloudLocation | null | undefined): loc is CloudLocation {
  return !!loc && loc.provider !== "local";
}

/** "Google Drive · ana@gmail.com", "Dropbox", "Local folder". */
export function cloudLabel(loc: CloudLocation, t: Translate): string {
  const name = t(`cloud.provider.${loc.provider}` as MessageKey);
  return loc.account ? `${name} · ${loc.account}` : name;
}
