// src/util/submodules.ts
//
// `--submodules <mode>` on apps and stacks (REO-576). The platform stores one
// field, `submodules`: `off` (the default, and what an absent field means),
// `on` (top-level submodules) or `recursive`.

import { parseEnum } from "./parse-flag";

export const SUBMODULE_MODES = ["off", "on", "recursive"] as const;
export type SubmoduleMode = (typeof SUBMODULE_MODES)[number];

export function parseSubmodules(raw: string): SubmoduleMode {
  return parseEnum(raw, SUBMODULE_MODES, "--submodules");
}

export function withSubmodules<T extends Record<string, unknown>>(
  obj: T,
): Omit<T, "submodules"> & { submodules: string } {
  const value = obj["submodules"];
  return { ...obj, submodules: typeof value === "string" && value !== "" ? value : "off" };
}
