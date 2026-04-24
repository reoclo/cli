import { $ } from "bun";
import type { TokenStore } from "../token-store";

const SERVICE = "reoclo";

export class MacOSKeyringStore implements TokenStore {
  readonly kind = "keyring" as const;
  async get(account: string): Promise<string | null> {
    const r = await $`security find-generic-password -s ${SERVICE} -a ${account} -w`.nothrow().quiet();
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim();
  }
  async set(account: string, token: string): Promise<void> {
    await $`security add-generic-password -U -s ${SERVICE} -a ${account} -w ${token}`.quiet();
  }
  async delete(account: string): Promise<void> {
    await $`security delete-generic-password -s ${SERVICE} -a ${account}`.nothrow().quiet();
  }
}
