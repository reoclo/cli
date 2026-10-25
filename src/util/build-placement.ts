// src/util/build-placement.ts
//
// Validation for an app's build placement (`build.placement` / `build.push_target`).
// The API enforces the same rules; checking here names the flags to fix instead
// of surfacing a 422.

import { isUuid } from "../client/resolve";
import { badUsage } from "./parse-flag";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFilled(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

/** `target` (build on the app's own server) or `pool:<pool-id>`. */
export function parseBuildPlacement(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === "target" || (v.startsWith("pool:") && isUuid(v.slice("pool:".length)))) return v;
  throw badUsage(`invalid --build-placement: '${raw}' (expected target or pool:<pool-id>)`);
}

/** Pool placement needs a push target, and a push target needs both its parts. */
export function assertPushTarget(build: unknown): void {
  if (!isRecord(build)) return;
  const placement = build["placement"];
  const pool = typeof placement === "string" && placement.startsWith("pool:");
  const target = build["push_target"];
  if (!pool && !isRecord(target)) return;
  const complete =
    isRecord(target) && isFilled(target["registry_credential_id"]) && isFilled(target["repository"]);
  if (!complete) {
    throw badUsage(
      "a push target needs both --push-credential and --push-repository (required for pool placement)",
    );
  }
}
