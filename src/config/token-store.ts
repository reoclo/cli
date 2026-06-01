export interface TokenStore {
  readonly kind: "keyring" | "file" | "memory";
  get(profile: string): Promise<string | null>;
  set(profile: string, token: string): Promise<void>;
  delete(profile: string): Promise<void>;
}

/**
 * Keyring key under which a profile's OAuth refresh token is stored. Mirrors
 * the access token's scheme (the bare profile name) with a `-refresh` suffix.
 * This is the single source of truth shared by the login WRITE and the
 * bootstrap-refresh READ so the two can never drift apart again — a mismatch
 * here silently breaks token refresh until the access token expires.
 */
export function refreshTokenKey(profileName: string): string {
  return `${profileName}-refresh`;
}

/**
 * Ordered keyring keys to look up a profile's refresh token. The derived key
 * (where login stores it) is tried first; a differing `legacyRef` — e.g. the
 * `reoclo-<profile>-refresh` value some configs recorded before the key was
 * unified — is kept as a fallback so existing profiles recover without a
 * re-login. Duplicates are collapsed.
 */
export function refreshTokenKeyCandidates(profileName: string, legacyRef?: string): string[] {
  const primary = refreshTokenKey(profileName);
  return legacyRef && legacyRef !== primary ? [primary, legacyRef] : [primary];
}

import { MacOSKeyringStore } from "./keyring/macos";
import { LinuxKeyringStore } from "./keyring/linux";
import { WindowsKeyringStore } from "./keyring/windows";
import { FileStore } from "./keyring/file";
import { detectKeyringBinary } from "./keyring/detect";

export interface ResolveOptions {
  requireKeyring?: boolean; // --keyring
  forbidKeyring?: boolean; // --no-keyring
}

export async function resolveStore(opts: ResolveOptions = {}): Promise<TokenStore> {
  if (opts.forbidKeyring) return new FileStore();
  const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.WOODPECKER);
  const cap = await detectKeyringBinary();
  if (!cap) {
    if (opts.requireKeyring) throw new Error("--keyring requested but no OS keyring tool is installed");
    return new FileStore();
  }
  if (isCI && !opts.requireKeyring) return new FileStore();
  if (cap.platform === "darwin") return new MacOSKeyringStore();
  if (cap.platform === "linux") return new LinuxKeyringStore();
  if (cap.platform === "win32") return new WindowsKeyringStore();
  return new FileStore();
}
