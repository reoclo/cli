// src/commands/upgrade.ts
import type { Command } from "commander";
import { realpathSync } from "node:fs";
import { argv0 } from "node:process";
import { VERSION } from "../index";

interface UpgradeOpts {
  channel: string;
  version?: string;
  check?: boolean;
}

export function registerUpgrade(program: Command): void {
  program
    .command("upgrade")
    .description("self-update the CLI (or print upgrade instructions for managed installs)")
    .option("--channel <name>", "stable | beta | dev", "stable")
    .option("--version <ver>", "pin to a specific version (overrides --channel)")
    .option("--check", "only check, do not upgrade")
    .action(async (opts: UpgradeOpts) => {
      const current = VERSION;
      let latest: string;
      if (opts.version) {
        latest = opts.version;
      } else {
        const res = await fetch(`https://get.reoclo.com/cli/${opts.channel}`);
        if (!res.ok) {
          console.error(`Error: failed to fetch channel pointer (HTTP ${res.status})`);
          process.exit(7);
        }
        latest = (await res.text()).trim();
      }

      if (opts.check) {
        console.log(`current: ${current}`);
        console.log(`latest:  ${latest}`);
        return;
      }

      if (!opts.version && latest === `v${current}`) {
        console.log(`✓ already on latest (${current})`);
        return;
      }

      const self = realpathSync(argv0);
      if (self.includes("/node_modules/")) {
        console.log("Installed via npm. Upgrade with:");
        console.log("  npm i -g @reoclo/cli@latest");
        return;
      }
      if (self.includes("/Cellar/") || self.toLowerCase().includes("/homebrew/")) {
        console.log("Installed via Homebrew. Upgrade with:");
        console.log("  brew upgrade reoclo/tap/reoclo");
        return;
      }
      console.error("Raw-binary upgrade is not yet implemented in this session.");
      console.error("Re-run the installer:");
      console.error("  curl -sSL https://get.reoclo.com/cli | bash");
      process.exit(1);
    });
}
