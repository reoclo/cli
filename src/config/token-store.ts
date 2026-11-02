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

import { AsyncLocalStorage } from "node:async_hooks";
import { MacOSKeyringStore } from "./keyring/macos";
import { LinuxKeyringStore } from "./keyring/linux";
import { WindowsKeyringStore } from "./keyring/windows";
import { FileStore } from "./keyring/file";
import { detectKeyringBinary } from "./keyring/detect";

export interface ResolveOptions {
  requireKeyring?: boolean; // --keyring
  forbidKeyring?: boolean; // --no-keyring
}

const _keyringStorage = new AsyncLocalStorage<TokenStore | null>();

/** Test-only: run callback with `store` standing in for the OS keyring (null: none). */
export function withKeyringStore<T>(store: TokenStore | null, fn: () => T): T {
  return _keyringStorage.run(store, fn);
}

/** The OS keyring store, or null when this machine has no keyring tool. */
export async function keyringStore(): Promise<TokenStore | null> {
  const override = _keyringStorage.getStore();
  if (override !== undefined) return override;
  const cap = await detectKeyringBinary();
  if (!cap) return null;
  if (cap.platform === "darwin") return new MacOSKeyringStore();
  if (cap.platform === "linux") return new LinuxKeyringStore();
  if (cap.platform === "win32") return new WindowsKeyringStore();
  return null;
}

/** Where a NEW login stores its tokens. Under CI this is the config file. */
export async function resolveStore(opts: ResolveOptions = {}): Promise<TokenStore> {
  if (opts.forbidKeyring) return new FileStore();
  const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.WOODPECKER);
  const keyring = await keyringStore();
  if (!keyring) {
    if (opts.requireKeyring) throw new Error("--keyring requested but no OS keyring tool is installed");
    return new FileStore();
  }
  if (isCI && !opts.requireKeyring) return new FileStore();
  return keyring;
}

/**
 * The store holding a saved profile's tokens. Login records where it put them
 * (`token_ref: "keyring:..."` and `refresh_token_ref` for the keyring, the
 * inline `token` and `refresh_token` fields for config.json), and reads must
 * follow that record. Reading through resolveStore() made any process with CI
 * set (an agent shell exporting CI=1, for one) look in config.json and report a
 * keyring profile as not authenticated. The config-file store is scoped to
 * `profileName`, so refreshSession finds and rotates the inline refresh token.
 */
export async function storeForProfile(
  profile: { token_ref?: string; refresh_token_ref?: string },
  profileName: string,
): Promise<TokenStore> {
  const file = new FileStore({ profile: profileName, key: refreshTokenKey(profileName) });
  const inKeyring = Boolean(profile.token_ref?.startsWith("keyring:") || profile.refresh_token_ref);
  if (!inKeyring) return file;
  return (await keyringStore()) ?? file;
}
