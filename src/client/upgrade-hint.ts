// src/client/upgrade-hint.ts
//
// The single-line "how to upgrade" command for a given install method, shared by
// the auto-update notice (`update-check.ts`) and available for `reoclo upgrade`.
// Managed installs route to their package manager; a raw binary self-upgrades
// via `reoclo upgrade`.

import type { InstallMethod } from "../commands/upgrade";

const JS_PACKAGE = "@reoclo/cli";

export function upgradeCommandFor(method: InstallMethod, bareVersion: string): string {
  switch (method) {
    case "homebrew":
      return "brew upgrade reoclo/tap/reoclo";
    case "npm":
      return `npm i -g ${JS_PACKAGE}@${bareVersion}`;
    case "pnpm":
      return `pnpm add -g ${JS_PACKAGE}@${bareVersion}`;
    case "yarn":
      return `yarn global add ${JS_PACKAGE}@${bareVersion}`;
    case "mise":
      return `mise use -g reoclo@${bareVersion}`;
    case "asdf":
      return `asdf install reoclo ${bareVersion} && asdf global reoclo ${bareVersion}`;
    case "raw":
      return "reoclo upgrade";
  }
}
