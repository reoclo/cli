// src/util/blue-green.ts
//
// `--blue-green on|off` on apps and stacks (REO-822). The platform stores a
// boolean: `deploy.blue_green` on an app or stack service (REO-820), and
// `blue_green` on a stack, which covers every service with a health check
// (REO-821). The API refuses an app without a health check and a manual group.

import { parseEnum } from "./parse-flag";

const BLUE_GREEN_MODES = ["on", "off"] as const;

export function parseBlueGreen(raw: string): boolean {
  return parseEnum(raw, BLUE_GREEN_MODES, "--blue-green") === "on";
}
