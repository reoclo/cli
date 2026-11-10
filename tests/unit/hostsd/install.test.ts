import { messageOf, rejectionOf } from "../../helpers/rejection";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInstallArgs } from "../../../src/hostsd/entry";
import {
  InstallError,
  buildConfig,
  hostsdLaunchdPlist,
  hostsdSystemdUnit,
  installHostsd, waitForHelper,
  uninstallHostsd,
} from "../../../src/hostsd/install";
import { LINUX_PATHS, MAC_PATHS, sandboxPaths, sandboxDir, type HostsdPaths } from "../../../src/hostsd/paths";
import type { CommandRunner } from "../../../src/tunnels/command-runner";
import { renderBlock } from "../../../src/tunnels/hosts-block";

let dir: string;
let paths: HostsdPaths;
let calls: string[];
/** launchd answers 113 to `print` for a service it does not know: the old helper is already gone. */
const gone = { code: 113, stdout: "", stderr: "Could not find service" };
const ok = { code: 0, stdout: "", stderr: "" };
const run: CommandRunner = (cmd, args) => {
  calls.push([cmd, ...args].join(" "));
  return Promise.resolve(args[0] === "print" ? gone : ok);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-install-"));
  paths = sandboxPaths(dir);
  calls = [];
  writeFileSync(join(dir, "cli"), "#!/bin/sh\necho cli\n", { mode: 0o755 });
  writeFileSync(paths.hostsFile, `127.0.0.1 localhost\n${renderBlock(["a.reoclo.localhost"])}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("service files", () => {
  it("renders the LaunchDaemon with the helper verb and the fixed binary path", () => {
    const plist = hostsdLaunchdPlist(MAC_PATHS.binary);
    expect(plist).toContain("<string>com.reoclo.hostsd</string>");
    expect(plist).toContain("<string>/Library/PrivilegedHelperTools/com.reoclo.hostsd</string>");
    expect(plist).toContain("<string>__hostsd</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("escapes XML in the binary path", () => {
    expect(hostsdLaunchdPlist("/opt/a&b/<x>")).toContain("/opt/a&amp;b/&lt;x&gt;");
  });

  it("renders the systemd unit", () => {
    const unit = hostsdSystemdUnit(LINUX_PATHS.binary);
    expect(unit).toContain("ExecStart=/usr/local/libexec/reoclo-hostsd __hostsd");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("Restart=always");
  });

  it("keeps the documented paths", () => {
    expect(MAC_PATHS).toMatchObject({
      config: "/Library/Application Support/Reoclo/hostsd.json",
      service: "/Library/LaunchDaemons/com.reoclo.hostsd.plist",
      socket: "/var/run/reoclo/hostsd.sock",
    });
    expect(LINUX_PATHS).toMatchObject({
      config: "/etc/reoclo/hostsd.json",
      service: "/etc/systemd/system/reoclo-hostsd.service",
      socket: "/run/reoclo/hostsd.sock",
    });
  });
});

describe("buildConfig", () => {
  it("records the uid, a sorted allowlist and the relay port only when the relay is on", () => {
    expect(buildConfig({ uid: 501, allowSuffixes: ["internal", "corp.example.com", "internal"], port443: false })).toEqual({
      version: 1,
      uid: 501,
      allow_suffixes: ["corp.example.com", "internal"],
      port_443: false,
    });
    expect(buildConfig({ uid: 501, allowSuffixes: [], port443: true, relayPort: 8443 })).toMatchObject({ port_443: true, relay_port: 8443 });
  });

  it("refuses a bad uid, a dangerous suffix and a relay with no port", () => {
    expect(() => buildConfig({ uid: -1, allowSuffixes: [], port443: false })).toThrow(InstallError);
    expect(() => buildConfig({ uid: 501, allowSuffixes: ["com"], port443: false })).toThrow(/single label/);
    expect(() => buildConfig({ uid: 501, allowSuffixes: [], port443: true })).toThrow(/--relay-port/);
  });
});

describe("installHostsd", () => {
  it("copies the binary, writes the root config and the service, and registers it with launchctl on macOS", async () => {
    const lines = await installHostsd({
      uid: 501,
      allowSuffixes: ["internal"],
      port443: false,
      sourceBinary: join(dir, "cli"),
      platform: "darwin",
      paths,
      run,
    });
    expect(readFileSync(paths.binary, "utf8")).toBe("#!/bin/sh\necho cli\n");
    expect(statSync(paths.binary).mode & 0o777).toBe(0o755);
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({ uid: 501, allow_suffixes: ["internal"], port_443: false });
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.service, "utf8")).toContain(`<string>${paths.binary}</string>`);
    expect(calls).toEqual([
      `launchctl bootout system/com.reoclo.hostsd`,
      `launchctl print system/com.reoclo.hostsd`,
      `launchctl bootstrap system ${paths.service}`,
    ]);
    expect(lines.join("\n")).toContain("allowed suffixes: internal");
  });

  it("registers a systemd unit on Linux and restarts it so a re-run picks up new settings", async () => {
    await installHostsd({
      uid: 1000,
      allowSuffixes: [],
      port443: true,
      relayPort: 8443,
      sourceBinary: join(dir, "cli"),
      platform: "linux",
      paths,
      run,
    });
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({ port_443: true, relay_port: 8443 });
    expect(readFileSync(paths.service, "utf8")).toContain("ExecStart=");
    expect(calls).toEqual([
      "systemctl daemon-reload",
      "systemctl enable reoclo-hostsd.service",
      "systemctl restart reoclo-hostsd.service",
    ]);
  });

  it("does not return until the helper answers", async () => {
    const order: string[] = [];
    const run: CommandRunner = (_cmd, args) => {
      order.push(String(args[0]));
      return Promise.resolve(args[0] === "print" ? gone : ok);
    };
    await installHostsd({
      uid: 501, allowSuffixes: [], port443: false, sourceBinary: join(dir, "cli"), platform: "darwin", paths, run,
      waitUntilUp: () => {
        order.push("up");
        return Promise.resolve();
      },
    });
    expect(order).toEqual(["bootout", "print", "bootstrap", "up"]);
  });

  it("waits until launchd has unloaded the old helper before it bootstraps the new one", async () => {
    const order: string[] = [];
    let prints = 0;
    const slow: CommandRunner = (_cmd, args) => {
      order.push(String(args[0]));
      if (args[0] === "print") return Promise.resolve(++prints < 4 ? ok : gone);
      return Promise.resolve(ok);
    };
    await installHostsd({ uid: 501, allowSuffixes: [], port443: false, sourceBinary: join(dir, "cli"), platform: "darwin", paths, run: slow, sleep: () => Promise.resolve() });
    expect(order).toEqual(["bootout", "print", "print", "print", "print", "bootstrap"]);
  });

  it("still tries the bootstrap when the old helper never unloads, and reports its error", async () => {
    let prints = 0;
    const stuck: CommandRunner = (_cmd, args) => {
      if (args[0] === "print") prints++;
      return Promise.resolve(args[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : ok);
    };
    expect(messageOf(await rejectionOf(
      installHostsd({ uid: 501, allowSuffixes: [], port443: false, sourceBinary: join(dir, "cli"), platform: "darwin", paths, run: stuck, sleep: () => Promise.resolve() }),
    ))).toMatch(/launchctl bootstrap system .* failed: Bootstrap failed: 5/);
    expect(prints).toBe(120);
  });

  it("waits through a helper that is still starting", async () => {
    let calls = 0;
    await waitForHelper(() => (++calls < 4 ? Promise.reject(new Error("not listening")) : Promise.resolve()), () => Promise.resolve());
    expect(calls).toBe(4);
  });

  it("says so when the helper never answers", async () => {
    expect(messageOf(await rejectionOf(
      waitForHelper(() => Promise.reject(new Error("not listening")), () => Promise.resolve()),
    ))).toMatch(/installed but did not answer: not listening/);
  });

  it("retries a bootstrap that races the bootout before it", async () => {
    let attempts = 0;
    const racing: CommandRunner = (_cmd, args) => {
      if (args[0] === "bootstrap" && ++attempts < 3) {
        return Promise.resolve({ code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" });
      }
      return Promise.resolve(args[0] === "print" ? gone : ok);
    };
    await installHostsd({ uid: 501, allowSuffixes: [], port443: false, sourceBinary: join(dir, "cli"), platform: "darwin", paths, run: racing, sleep: () => Promise.resolve() });
    expect(attempts).toBe(3);
  });

  it("fails and says which command failed when the service manager refuses", async () => {
    const failing: CommandRunner = (cmd, args) =>
      Promise.resolve(args[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "no such service" } : args[0] === "print" ? gone : ok);
    expect(messageOf(await rejectionOf(
      installHostsd({ uid: 501, allowSuffixes: [], port443: false, sourceBinary: join(dir, "cli"), platform: "darwin", paths, run: failing, sleep: () => Promise.resolve() }),
    ))).toMatch(/launchctl bootstrap system .* failed: no such service/);
  });

  it("refuses unsupported platforms", async () => {
    expect(messageOf(await rejectionOf(
      installHostsd({ uid: 1, allowSuffixes: [], port443: false, sourceBinary: join(dir, "cli"), platform: "win32", paths, run }),
    ))).toMatch(/not supported/);
  });
});

describe("uninstallHostsd", () => {
  it("unloads the service, removes its files and strips the managed block", async () => {
    await installHostsd({ uid: 501, allowSuffixes: [], port443: false, sourceBinary: join(dir, "cli"), platform: "darwin", paths, run });
    calls = [];
    const lines = await uninstallHostsd({ platform: "darwin", paths, run });
    expect(calls).toEqual(["launchctl bootout system/com.reoclo.hostsd"]);
    expect(existsSync(paths.binary)).toBe(false);
    expect(existsSync(paths.config)).toBe(false);
    expect(existsSync(paths.service)).toBe(false);
    expect(readFileSync(paths.hostsFile, "utf8")).toBe("127.0.0.1 localhost\n");
    expect(lines.join("\n")).toContain("removed the reoclo block");
  });

  it("says so when nothing was installed", async () => {
    writeFileSync(paths.hostsFile, "127.0.0.1 localhost\n");
    expect(await uninstallHostsd({ platform: "linux", paths, run })).toEqual(["the hosts helper was not installed"]);
  });
});

describe("parseInstallArgs", () => {
  it("reads uid, suffixes and the relay", () => {
    expect(parseInstallArgs(["--uid", "501", "--allow-suffix", "internal", "--allow-suffix", "corp.example.com", "--port-443", "--relay-port", "8443"])).toEqual({
      uid: 501,
      allowSuffixes: ["internal", "corp.example.com"],
      port443: true,
      relayPort: 8443,
    });
  });

  it("requires a uid and rejects unknown options and dangerous suffixes", () => {
    expect(() => parseInstallArgs([])).toThrow(/--uid is required/);
    expect(() => parseInstallArgs(["--uid", "1", "--bogus"])).toThrow(/unknown option/);
    expect(() => parseInstallArgs(["--uid", "1", "--allow-suffix", "com"])).toThrow();
    expect(() => parseInstallArgs(["--uid"])).toThrow(/needs a value/);
  });
});

describe("the sandbox", () => {
  it("only applies to a process that is not root", () => {
    const isRoot = process.getuid?.() === 0;
    expect(sandboxDir({ REOCLO_HOSTSD_DIR: "/tmp/x" })).toBe(isRoot ? undefined : "/tmp/x");
    expect(sandboxDir({})).toBeUndefined();
  });
});
