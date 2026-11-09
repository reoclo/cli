import { describe, expect, it } from "bun:test";
import type { DaemonStatus } from "../../../src/tunnels/control-client";
import { readiness, runSetup, type SetupDeps, type SetupOptions } from "../../../src/tunnels/setup";

function status(over: { ca?: Partial<NonNullable<DaemonStatus["ca"]>>; hosts?: Partial<NonNullable<DaemonStatus["hosts"]>> } = {}, rest: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    version: "0.0.0",
    pid: 1,
    uptime_seconds: 0,
    state_dir: "/tmp/x",
    socket: "/tmp/x.sock",
    tunnels: { total: 0, enabled: 0, by_state: {} },
    ca: { exists: true, trusted: true, suffixes: ["reoclo.localhost"], stale: false, ...over.ca },
    hosts: { installed: true, entries: 0, suffixes: [], relay: { enabled: false, listening: false }, ...over.hosts },
    ...rest,
  };
}

const FRESH = status({ ca: { exists: false, trusted: false }, hosts: { installed: false } });
const ALL: SetupOptions = { service: true, trust: true, hosts: true, domains: [], port443: false };

function harness(over: Partial<SetupDeps> & { current?: DaemonStatus | undefined } = {}): { deps: SetupDeps; calls: string[] } {
  const calls: string[] = [];
  const current = "current" in over ? over.current : FRESH;
  const deps: SetupDeps = {
    interactive: true,
    serviceInstalled: () => false,
    installService: () => {
      calls.push("service");
      return "installed";
    },
    status: () => Promise.resolve(current),
    trust: (d) => {
      calls.push(`trust:${d.join(",")}`);
      return Promise.resolve(["trusted"]);
    },
    installHosts: (o) => {
      calls.push(`hosts:${o.domains.join(",")}:${o.port443}`);
      return Promise.resolve(["installed"]);
    },
    progress: () => undefined,
    ...over,
  };
  return { deps, calls };
}

const outcomes = (r: { steps: { outcome: string }[] }): string[] => r.steps.map((s) => s.outcome);

describe("runSetup", () => {
  it("runs every step in order on a fresh machine", async () => {
    const { deps, calls } = harness();
    const r = await runSetup(deps, ALL);
    expect(calls).toEqual(["service", "trust:", "hosts::false"]);
    expect(outcomes(r)).toEqual(["done", "done", "done"]);
    expect(r.ok).toBe(true);
  });

  it("leaves a machine that is already set up alone", async () => {
    const { deps, calls } = harness({ current: status(), serviceInstalled: () => true });
    const r = await runSetup(deps, ALL);
    expect(calls).toEqual([]);
    expect(outcomes(r)).toEqual(["already", "already", "already"]);
    expect(r.ok).toBe(true);
  });

  it("skips the steps turned off by flags", async () => {
    const { deps, calls } = harness();
    const r = await runSetup(deps, { ...ALL, service: false, trust: false, hosts: false });
    expect(calls).toEqual([]);
    expect(outcomes(r)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("keeps going after a step fails, and reports the failure", async () => {
    const { deps, calls } = harness({ trust: () => Promise.reject(new Error("keychain said no")) });
    const r = await runSetup(deps, ALL);
    expect(calls).toEqual(["service", "hosts::false"]);
    expect(outcomes(r)).toEqual(["done", "failed", "done"]);
    expect(r.steps[1]?.detail).toBe("keychain said no");
    expect(r.ok).toBe(false);
  });

  it("does not attempt prompts without a terminal, and that is not a failure", async () => {
    const { deps, calls } = harness({ interactive: false });
    const r = await runSetup(deps, ALL);
    expect(calls).toEqual(["service"]);
    expect(outcomes(r)).toEqual(["done", "skipped", "skipped"]);
    expect(r.ok).toBe(true);
  });

  it("reruns trust for a stale CA", async () => {
    const { deps, calls } = harness({ current: status({ ca: { stale: true } }), serviceInstalled: () => true });
    await runSetup(deps, ALL);
    expect(calls).toEqual(["trust:"]);
  });

  it("reruns trust and hosts when a requested domain is not covered", async () => {
    const { deps, calls } = harness({ current: status(), serviceInstalled: () => true });
    await runSetup(deps, { ...ALL, domains: ["internal"] });
    expect(calls).toEqual(["trust:internal", "hosts:internal:false"]);
  });

  it("reruns hosts when the port 443 relay is requested and off", async () => {
    const { deps, calls } = harness({ current: status(), serviceInstalled: () => true });
    await runSetup(deps, { ...ALL, port443: true });
    expect(calls).toEqual(["hosts::true"]);
  });

  it("still attempts the steps when the daemon cannot be reached", async () => {
    const { deps, calls } = harness({ current: undefined, serviceInstalled: () => true });
    const r = await runSetup(deps, ALL);
    expect(calls).toEqual(["trust:", "hosts::false"]);
    expect(r.status).toBeUndefined();
  });
});

describe("readiness", () => {
  const map = (s: DaemonStatus | undefined): Record<string, string> => Object.fromEntries(readiness(s));

  it("says when the daemon cannot be reached", () => {
    expect(map(undefined)["daemon"]).toContain("could not be reached");
  });

  it("points a signed-out machine at login", () => {
    expect(map(status({}, { signed_in: false }))["sign-in"]).toContain("reoclo login");
  });

  it("shows the HTTPS port until the relay is listening", () => {
    const https = { https: { port: 8443, listening: false } };
    expect(map(status({}, https))["https urls"]).toBe("use port 8443");
    expect(map(status({ hosts: { relay: { enabled: true, listening: true } } }, https))["https urls"]).toBe("no port needed");
  });

  it("treats Tailscale as optional", () => {
    const tailscale = (installed: boolean, running: boolean) => ({ tailscale: { installed, running, https_certificates: false, tailnet: "acme" } });
    expect(map(status({}, tailscale(false, false)))["tailscale"]).toContain("only --via tailscale");
    expect(map(status({}, tailscale(true, false)))["tailscale"]).toContain("not running");
    expect(map(status({}, tailscale(true, true)))["tailscale"]).toBe("connected to acme");
  });
});
