import type { TokenStore } from "../token-store";
import { loadConfig, saveProfile } from "../store";

export class FileStore implements TokenStore {
  readonly kind = "file" as const;
  async get(profile: string): Promise<string | null> {
    const cfg = await loadConfig();
    return cfg.profiles[profile]?.token ?? null;
  }
  async set(profile: string, token: string): Promise<void> {
    const cfg = await loadConfig();
    const p = cfg.profiles[profile];
    if (!p) throw new Error(`profile '${profile}' missing — call saveProfile first`);
    await saveProfile(profile, { ...p, token, token_ref: undefined });
  }
  async delete(profile: string): Promise<void> {
    const cfg = await loadConfig();
    const p = cfg.profiles[profile];
    if (!p) return;
    await saveProfile(profile, { ...p, token: undefined });
  }
}
