export interface TokenStore {
  readonly kind: "keyring" | "file" | "memory";
  get(profile: string): Promise<string | null>;
  set(profile: string, token: string): Promise<void>;
  delete(profile: string): Promise<void>;
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
