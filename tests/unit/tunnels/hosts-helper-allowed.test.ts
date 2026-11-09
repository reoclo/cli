import { describe, expect, it } from "bun:test";
import { defaultConfigDir, withConfigDir } from "../../../src/config/paths";
import { hostsHelperAllowed } from "../../../src/tunnels/hosts-client";

describe("hostsHelperAllowed", () => {
  it("allows the default config directory", () => {
    expect(withConfigDir(defaultConfigDir(), () => hostsHelperAllowed({}))).toBe(true);
  });

  it("refuses any other config directory, so it cannot replace the real hostnames", () => {
    expect(withConfigDir("/tmp/reoclo-elsewhere", () => hostsHelperAllowed({}))).toBe(false);
  });

  it("allows a sandboxed helper with any config directory", () => {
    expect(withConfigDir("/tmp/reoclo-elsewhere", () => hostsHelperAllowed({ REOCLO_HOSTSD_DIR: "/tmp/hostsd" }))).toBe(true);
  });
});
