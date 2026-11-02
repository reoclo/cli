import type { TokenStore } from "../token-store";
import { loadConfig, saveProfile } from "../store";

/** Scope a FileStore to one profile so its refresh-token key maps to the
 *  profile's inline `refresh_token` field. */
export interface FileStoreRefreshScope {
  profile: string;
  /** The key refreshSession reads and writes the refresh token under. */
  key: string;
}

export class FileStore implements TokenStore {
  readonly kind = "file" as const;

  constructor(private readonly refresh?: FileStoreRefreshScope) {}

  private refreshProfileFor(key: string): string | undefined {
    return this.refresh && key === this.refresh.key ? this.refresh.profile : undefined;
  }

  async get(profile: string): Promise<string | null> {
    const cfg = await loadConfig();
    const owner = this.refreshProfileFor(profile);
    if (owner) return cfg.profiles[owner]?.refresh_token ?? null;
    return cfg.profiles[profile]?.token ?? null;
  }
  async set(profile: string, token: string): Promise<void> {
    const cfg = await loadConfig();
    const owner = this.refreshProfileFor(profile);
    const name = owner ?? profile;
    const p = cfg.profiles[name];
    if (!p) throw new Error(`profile '${name}' missing — call saveProfile first`);
    if (owner) await saveProfile(name, { ...p, refresh_token: token });
    else await saveProfile(name, { ...p, token, token_ref: undefined });
  }
  async delete(profile: string): Promise<void> {
    const cfg = await loadConfig();
    const owner = this.refreshProfileFor(profile);
    const name = owner ?? profile;
    const p = cfg.profiles[name];
    if (!p) return;
    if (owner) await saveProfile(name, { ...p, refresh_token: undefined });
    else await saveProfile(name, { ...p, token: undefined });
  }
}
