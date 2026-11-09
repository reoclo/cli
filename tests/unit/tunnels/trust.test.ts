import { messageOf, rejectionOf } from "../../helpers/rejection";
import { describe, expect, it } from "bun:test";
import type { CommandResult, CommandRunner } from "../../../src/tunnels/command-runner";
import {
  LINUX_CA_PATH,
  NSS_NICKNAME,
  TrustError,
  checkTrust,
  installTrust,
  removeTrust,
  type TrustEnv,
} from "../../../src/tunnels/trust";

const ca = { certPath: "/home/u/.reoclo/tunnels/ca/ca.pem", certPem: "PEM-DATA", sha1: "AB12" };
const ok: CommandResult = { code: 0, stdout: "", stderr: "" };

function fakeEnv(over: Partial<TrustEnv> & { results?: Record<string, CommandResult>; files?: Record<string, string> } = {}) {
  const calls: { line: string; inherit: boolean }[] = [];
  const run: CommandRunner = (cmd, args, opts) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ line, inherit: opts?.inherit === true });
    return Promise.resolve(over.results?.[line] ?? ok);
  };
  const files = over.files ?? {};
  const env: TrustEnv = {
    platform: "linux",
    home: "/home/u",
    root: false,
    run,
    exists: (p) => p in files,
    readFile: (p) => files[p],
    hasCommand: () => Promise.resolve(false),
    ...over,
  };
  return { env, calls };
}

describe("macOS", () => {
  it("adds the CA to the login keychain as a trusted root", async () => {
    const { env, calls } = fakeEnv({ platform: "darwin", home: "/Users/u" });
    const done = await installTrust(env, ca);
    expect(calls).toEqual([
      {
        line: `security add-trusted-cert -r trustRoot -k /Users/u/Library/Keychains/login.keychain-db ${ca.certPath}`,
        inherit: true,
      },
    ]);
    expect(done[0]).toContain("login.keychain-db");
  });

  it("explains a refused keychain prompt", async () => {
    const line = `security add-trusted-cert -r trustRoot -k /Users/u/Library/Keychains/login.keychain-db ${ca.certPath}`;
    const { env } = fakeEnv({ platform: "darwin", home: "/Users/u", results: { [line]: { code: 1, stdout: "", stderr: "user canceled" } } });
    expect(messageOf(await rejectionOf(installTrust(env, ca)))).toMatch(/user canceled/);
    expect(await rejectionOf(installTrust(env, ca))).toBeInstanceOf(TrustError);
  });

  it("removes the trust setting, then the certificate by its SHA-1", async () => {
    const { env, calls } = fakeEnv({ platform: "darwin", home: "/Users/u" });
    await removeTrust(env, ca);
    expect(calls.map((c) => c.line)).toEqual([
      `security remove-trusted-cert ${ca.certPath}`,
      "security delete-certificate -Z AB12 /Users/u/Library/Keychains/login.keychain-db",
    ]);
  });

  it("does not fail removal when the certificate is already gone", async () => {
    const { env } = fakeEnv({
      platform: "darwin",
      home: "/Users/u",
      results: { "security delete-certificate -Z AB12 /Users/u/Library/Keychains/login.keychain-db": { code: 44, stdout: "", stderr: "not found" } },
    });
    expect(await removeTrust(env, ca)).toBeDefined();
  });

  it("checks trust with security verify-cert and never prompts", async () => {
    const { env, calls } = fakeEnv({ platform: "darwin" });
    expect(await checkTrust(env, ca)).toBe(true);
    expect(calls).toEqual([{ line: `security verify-cert -c ${ca.certPath} -p basic`, inherit: false }]);
    const { env: untrusted } = fakeEnv({ platform: "darwin", results: { [`security verify-cert -c ${ca.certPath} -p basic`]: { code: 1, stdout: "", stderr: "" } } });
    expect(await checkTrust(untrusted, ca)).toBe(false);
  });
});

describe("Linux", () => {
  it("installs into the system store with sudo", async () => {
    const { env, calls } = fakeEnv();
    await installTrust(env, ca);
    expect(calls.map((c) => c.line)).toEqual([
      `sudo install -m 0644 ${ca.certPath} ${LINUX_CA_PATH}`,
      "sudo update-ca-certificates",
    ]);
    expect(calls.every((c) => c.inherit)).toBe(true);
  });

  it("skips sudo when already root", async () => {
    const { env, calls } = fakeEnv({ root: true });
    await installTrust(env, ca);
    expect(calls.map((c) => c.line)).toEqual([`install -m 0644 ${ca.certPath} ${LINUX_CA_PATH}`, "update-ca-certificates"]);
  });

  it("also adds the CA to ~/.pki/nssdb when it exists and certutil is installed", async () => {
    const { env, calls } = fakeEnv({ files: { "/home/u/.pki/nssdb": "" }, hasCommand: () => Promise.resolve(true) });
    const done = await installTrust(env, ca);
    expect(calls.map((c) => c.line).slice(2)).toEqual([
      `certutil -d sql:/home/u/.pki/nssdb -D -n ${NSS_NICKNAME}`,
      `certutil -d sql:/home/u/.pki/nssdb -A -t C,, -n ${NSS_NICKNAME} -i ${ca.certPath}`,
    ]);
    expect(done.join("\n")).toContain("Chromium");
  });

  it("leaves the NSS database alone without certutil", async () => {
    const { env, calls } = fakeEnv({ files: { "/home/u/.pki/nssdb": "" } });
    await installTrust(env, ca);
    expect(calls.some((c) => c.line.startsWith("certutil"))).toBe(false);
  });

  it("removes the system copy and the NSS entry", async () => {
    const { env, calls } = fakeEnv({ files: { "/home/u/.pki/nssdb": "" }, hasCommand: () => Promise.resolve(true) });
    await removeTrust(env, ca);
    expect(calls.map((c) => c.line)).toEqual([
      `sudo rm -f ${LINUX_CA_PATH}`,
      "sudo update-ca-certificates --fresh",
      `certutil -d sql:/home/u/.pki/nssdb -D -n ${NSS_NICKNAME}`,
    ]);
  });

  it("is trusted when the installed copy matches ca.pem", async () => {
    const { env: same } = fakeEnv({ files: { [LINUX_CA_PATH]: "PEM-DATA" } });
    expect(await checkTrust(same, ca)).toBe(true);
    const { env: other } = fakeEnv({ files: { [LINUX_CA_PATH]: "OLD" } });
    expect(await checkTrust(other, ca)).toBe(false);
    const { env: none } = fakeEnv();
    expect(await checkTrust(none, ca)).toBe(false);
  });
});

describe("other platforms", () => {
  it("refuses to trust", async () => {
    const { env } = fakeEnv({ platform: "win32" });
    expect(messageOf(await rejectionOf(installTrust(env, ca)))).toMatch(/not supported on win32/);
    expect(messageOf(await rejectionOf(removeTrust(env, ca)))).toMatch(/not supported/);
    expect(await checkTrust(env, ca)).toBe(false);
  });
});
