import { describe, expect, it } from "bun:test";
import {
  launchdPlist,
  launchdPlistPath,
  stableBinaryPath,
  systemdUnit,
  systemdUnitPath,
  type ServiceSpec,
} from "../../../src/tunnels/service";

const spec: ServiceSpec = {
  command: ["/opt/homebrew/bin/reoclo", "tunnel", "daemon", "run"],
  logPath: "/Users/me/.reoclo/tunnels/tunneld.log",
  env: { PATH: "/opt/homebrew/bin:/usr/bin", REOCLO_CONFIG_DIR: "/Users/me/.reoclo" },
};

describe("launchdPlist", () => {
  const plist = launchdPlist(spec);
  it("names the agent and runs the stable path", () => {
    expect(plist).toContain("<string>com.reoclo.tunneld</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/reoclo</string>");
    expect(plist).toContain("<string>daemon</string>");
  });
  it("starts at load and restarts only after a crash", () => {
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });
  it("logs to the daemon log and passes the environment", () => {
    expect(plist.match(/\/Users\/me\/\.reoclo\/tunnels\/tunneld\.log/g)).toHaveLength(2);
    expect(plist).toContain("<key>REOCLO_CONFIG_DIR</key>");
  });
  it("escapes XML in arguments", () => {
    expect(launchdPlist({ ...spec, command: ["/a&b/reoclo"] })).toContain("/a&amp;b/reoclo");
  });
  it("lives in the user's LaunchAgents directory", () => {
    expect(launchdPlistPath("/Users/me")).toBe("/Users/me/Library/LaunchAgents/com.reoclo.tunneld.plist");
  });
});

describe("systemdUnit", () => {
  const unit = systemdUnit(spec);
  it("runs the command and installs for the default target", () => {
    expect(unit).toContain("ExecStart=/opt/homebrew/bin/reoclo tunnel daemon run");
    expect(unit).toContain("WantedBy=default.target");
  });
  it("restarts only on failure and appends to the log", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StandardOutput=append:/Users/me/.reoclo/tunnels/tunneld.log");
  });
  it("quotes arguments with spaces", () => {
    expect(systemdUnit({ ...spec, command: ["/My Apps/reoclo", "x"] })).toContain('ExecStart="/My Apps/reoclo" x');
  });
  it("lives in the user's systemd directory", () => {
    expect(systemdUnitPath("/home/me")).toBe("/home/me/.config/systemd/user/reoclo-tunneld.service");
  });
});

describe("stableBinaryPath", () => {
  const cellar = "/opt/homebrew/Cellar/reoclo/0.100.0/bin/reoclo";
  const real = (p: string): string => (p === "/opt/homebrew/bin/reoclo" ? cellar : p);
  it("prefers the PATH symlink over the versioned Cellar path", () => {
    const got = stableBinaryPath(cellar, "/usr/bin:/opt/homebrew/bin", {
      exists: (p) => p === "/opt/homebrew/bin/reoclo",
      realpath: real,
    });
    expect(got).toBe("/opt/homebrew/bin/reoclo");
  });
  it("keeps the Cellar path when no PATH entry points at it", () => {
    expect(stableBinaryPath(cellar, "/usr/bin", { exists: () => false, realpath: real })).toBe(cellar);
  });
  it("leaves any other path alone", () => {
    expect(stableBinaryPath("/usr/local/bin/reoclo", "/usr/bin", { exists: () => true, realpath: real })).toBe(
      "/usr/local/bin/reoclo",
    );
  });
});
