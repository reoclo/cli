import { $ } from "bun";
import type { TokenStore } from "../token-store";

export class WindowsKeyringStore implements TokenStore {
  readonly kind = "keyring" as const;
  async get(account: string): Promise<string | null> {
    const target = `reoclo:${account}`;
    const list = await $`cmdkey /list:${target}`.nothrow().quiet();
    if (list.exitCode !== 0 || !list.stdout.toString().includes(target)) return null;
    // cmdkey does not print passwords; tokens must be fetched via CredRead.
    // Use PowerShell CredentialManager module as a fallback.
    const ps = await $`powershell -NoProfile -Command "(Get-StoredCredential -Target '${target}').GetNetworkCredential().Password"`.nothrow().quiet();
    return ps.exitCode === 0 ? ps.stdout.toString().trim() : null;
  }
  async set(account: string, token: string): Promise<void> {
    const target = `reoclo:${account}`;
    await $`cmdkey /generic:${target} /user:reoclo /pass:${token}`.quiet();
  }
  async delete(account: string): Promise<void> {
    const target = `reoclo:${account}`;
    await $`cmdkey /delete:${target}`.nothrow().quiet();
  }
}
