// src/tunnels/trust.ts
//
// Install, remove and check the local CA in the system trust store. macOS
// adds it to the login keychain as a trusted root (the system shows its own
// authentication prompt). Linux copies it into /usr/local/share/ca-certificates
// with sudo and also into ~/.pki/nssdb when certutil is present. Every command
// goes through an injected runner, so tests assert on command lines and never
// touch a real keychain or trust store.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realRunner, shellWords, type CommandRunner } from "./command-runner";

export const LINUX_CA_PATH = "/usr/local/share/ca-certificates/reoclo-local-ca.crt";
export const NSS_NICKNAME = "Reoclo Local CA";

export class TrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustError";
  }
}

export interface TrustEnv {
  platform: NodeJS.Platform;
  home: string;
  /** Running as root, so Linux commands need no sudo. */
  root: boolean;
  run: CommandRunner;
  exists: (path: string) => boolean;
  readFile: (path: string) => string | undefined;
  hasCommand: (name: string) => Promise<boolean>;
}

export interface TrustTarget {
  /** Path of ca.pem. */
  certPath: string;
  certPem: string;
  /** SHA-1 of the DER, upper-case hex. */
  sha1: string;
}

export function defaultTrustEnv(run: CommandRunner = realRunner): TrustEnv {
  return {
    platform: process.platform,
    home: homedir(),
    root: process.getuid?.() === 0,
    run,
    exists: existsSync,
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
    hasCommand: async (name) => (await run("which", [name])).code === 0,
  };
}

function keychain(env: TrustEnv): string {
  return join(env.home, "Library", "Keychains", "login.keychain-db");
}

function nssDir(env: TrustEnv): string {
  return join(env.home, ".pki", "nssdb");
}

async function need(env: TrustEnv, cmd: string, args: string[], inherit = true): Promise<void> {
  const r = await env.run(cmd, args, { inherit });
  if (r.code !== 0) throw new TrustError(`${shellWords(cmd, args)} failed${r.stderr.trim() ? `: ${r.stderr.trim()}` : ` (exit ${r.code})`}`);
}

function privileged(env: TrustEnv, cmd: string, args: string[]): [string, string[]] {
  return env.root ? [cmd, args] : ["sudo", [cmd, ...args]];
}

async function nssAvailable(env: TrustEnv): Promise<boolean> {
  return env.exists(nssDir(env)) && (await env.hasCommand("certutil"));
}

/** Add the CA to the trust store. Returns what it did, one line each. */
export async function installTrust(env: TrustEnv, ca: TrustTarget): Promise<string[]> {
  if (env.platform === "darwin") {
    await need(env, "security", ["add-trusted-cert", "-r", "trustRoot", "-k", keychain(env), ca.certPath]);
    return [`added the CA to ${keychain(env)} as a trusted root`];
  }
  if (env.platform !== "linux") throw new TrustError(`trusting the CA is not supported on ${env.platform}`);
  const done: string[] = [];
  const [cp, cpArgs] = privileged(env, "install", ["-m", "0644", ca.certPath, LINUX_CA_PATH]);
  await need(env, cp, cpArgs);
  const [up, upArgs] = privileged(env, "update-ca-certificates", []);
  await need(env, up, upArgs);
  done.push(`installed the CA at ${LINUX_CA_PATH}`);
  if (await nssAvailable(env)) {
    const db = `sql:${nssDir(env)}`;
    await env.run("certutil", ["-d", db, "-D", "-n", NSS_NICKNAME]);
    await need(env, "certutil", ["-d", db, "-A", "-t", "C,,", "-n", NSS_NICKNAME, "-i", ca.certPath]);
    done.push(`added the CA to ${nssDir(env)} for Chromium`);
  }
  return done;
}

/** Remove the CA from every store it was added to. Missing entries are not errors. */
export async function removeTrust(env: TrustEnv, ca: Pick<TrustTarget, "certPath" | "sha1">): Promise<string[]> {
  if (env.platform === "darwin") {
    await env.run("security", ["remove-trusted-cert", ca.certPath]);
    await env.run("security", ["delete-certificate", "-Z", ca.sha1, keychain(env)]);
    return [`removed the CA from ${keychain(env)}`];
  }
  if (env.platform !== "linux") throw new TrustError(`trusting the CA is not supported on ${env.platform}`);
  const done: string[] = [];
  const [rm, rmArgs] = privileged(env, "rm", ["-f", LINUX_CA_PATH]);
  await need(env, rm, rmArgs);
  const [up, upArgs] = privileged(env, "update-ca-certificates", ["--fresh"]);
  await need(env, up, upArgs);
  done.push(`removed ${LINUX_CA_PATH}`);
  if (await nssAvailable(env)) {
    await env.run("certutil", ["-d", `sql:${nssDir(env)}`, "-D", "-n", NSS_NICKNAME]);
    done.push(`removed the CA from ${nssDir(env)}`);
  }
  return done;
}

/** True when the system trusts this CA. Never prompts and never needs a password. */
export async function checkTrust(env: TrustEnv, ca: Pick<TrustTarget, "certPath" | "certPem">): Promise<boolean> {
  if (env.platform === "darwin") {
    return (await env.run("security", ["verify-cert", "-c", ca.certPath, "-p", "basic"])).code === 0;
  }
  if (env.platform === "linux") return env.readFile(LINUX_CA_PATH) === ca.certPem;
  return false;
}

/** Firefox keeps its own store unless enterprise roots are on. */
export function firefoxHint(): string {
  return "Firefox uses its own certificate store. In about:config set security.enterprise_roots.enabled to true, or import the file printed by: reoclo tunnel ca-path";
}
