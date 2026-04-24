import { $ } from "bun";
import type { TokenStore } from "../token-store";

export class LinuxKeyringStore implements TokenStore {
  readonly kind = "keyring" as const;
  async get(account: string): Promise<string | null> {
    const r = await $`secret-tool lookup service reoclo account ${account}`.nothrow().quiet();
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim();
  }
  async set(account: string, token: string): Promise<void> {
    await $`echo -n ${token} | secret-tool store --label=reoclo service reoclo account ${account}`.quiet();
  }
  async delete(account: string): Promise<void> {
    await $`secret-tool clear service reoclo account ${account}`.nothrow().quiet();
  }
}
