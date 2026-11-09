import { describe, expect, it } from "bun:test";
import {
  Tailscale,
  findTailscaleBinary,
  firstIpv4,
  isLoopbackHost,
  matchPeer,
  parseServeStatus,
  parseStatus,
  portBindProblem,
  statusView,
  targetProblem,
  MAC_APP_BINARY,
} from "../../../src/tunnels/tailscale";
import { FakeTailscaleRunner, SELF_DNS, STOPPED_STATUS, TAILNET, fakeTailscale, serveJson, statusJson } from "../../helpers/fake-tailscale";

describe("parseStatus", () => {
  it("reads a running node with peers and certificate domains", () => {
    const info = parseStatus(
      JSON.parse(statusJson({ peers: [{ host: "prod-1", ips: ["fd7a:115c:a1e0::10", "100.64.0.10"], online: true }, { host: "stage-1", online: false }] })),
    );
    expect(info).toMatchObject({
      running: true,
      backend_state: "Running",
      tailnet: TAILNET,
      https_certificates: true,
      self_dns_name: SELF_DNS,
    });
    expect(info.peers).toEqual([
      { host_name: "prod-1", dns_name: `prod-1.${TAILNET}`, addresses: ["fd7a:115c:a1e0::10", "100.64.0.10"], online: true },
      { host_name: "stage-1", dns_name: `stage-1.${TAILNET}`, addresses: ["100.64.0.11", "fd7a:115c:a1e0::11"], online: false },
    ]);
  });

  it("reads a stopped node: not running, no peers, no certificates, null maps", () => {
    const info = parseStatus(JSON.parse(STOPPED_STATUS));
    expect(info.running).toBe(false);
    expect(info.backend_state).toBe("Stopped");
    expect(info.peers).toEqual([]);
    expect(info.https_certificates).toBe(false);
  });

  it("counts HTTPS certificates as off when CertDomains is empty or null", () => {
    expect(parseStatus(JSON.parse(statusJson({ certDomains: [] }))).https_certificates).toBe(false);
    expect(parseStatus(JSON.parse(statusJson({ certDomains: null }))).https_certificates).toBe(false);
  });

  it("takes the tailnet name from MagicDNSSuffix when CurrentTailnet is missing", () => {
    expect(parseStatus({ BackendState: "Running", MagicDNSSuffix: "other.ts.net" }).tailnet).toBe("other.ts.net");
  });

  it("survives a Peer map with a null value and nonsense input", () => {
    expect(parseStatus({ BackendState: "Running", Peer: { a: null, b: { HostName: "box", TailscaleIPs: ["100.64.0.2", 5], Online: true } } }).peers).toEqual([
      { host_name: "box", dns_name: "", addresses: ["100.64.0.2"], online: true },
    ]);
    expect(parseStatus("nope")).toMatchObject({ running: false, peers: [] });
  });
});

describe("parseServeStatus", () => {
  it("is empty for the empty object", () => {
    expect(parseServeStatus({})).toEqual([]);
  });

  it("reads an https port with its proxy target and a tcp forward", () => {
    const served = parseServeStatus(JSON.parse(serveJson([{ port: 443, proxy: "http://127.0.0.1:18443" }, { port: 5432, tcp: "127.0.0.1:15432" }])));
    expect(served).toEqual([
      { port: 443, kind: "https", target: "http://127.0.0.1:18443" },
      { port: 5432, kind: "tcp", target: "127.0.0.1:15432" },
    ]);
  });

  it("reads a plain http port and ignores keys that are not ports", () => {
    expect(parseServeStatus({ TCP: { "80": { HTTP: true }, nope: {} } })).toEqual([{ port: 80, kind: "http" }]);
  });
});

describe("findTailscaleBinary", () => {
  const present = (...files: string[]) => (p: string): boolean => files.includes(p);

  it("finds tailscale on PATH before the macOS app", () => {
    expect(findTailscaleBinary({ override: undefined, path: "/nope:/opt/bin", exists: present("/opt/bin/tailscale", MAC_APP_BINARY) })).toBe("/opt/bin/tailscale");
  });

  it("falls back to the macOS app", () => {
    expect(findTailscaleBinary({ override: undefined, path: "/nope", exists: present(MAC_APP_BINARY) })).toBe(MAC_APP_BINARY);
  });

  it("is undefined when nothing is installed", () => {
    expect(findTailscaleBinary({ override: undefined, path: "/nope", exists: present() })).toBeUndefined();
  });

  it("uses the override alone: a missing override means not installed, with no fallback", () => {
    expect(findTailscaleBinary({ override: "/custom/ts", path: "/opt/bin", exists: present("/custom/ts", "/opt/bin/tailscale") })).toBe("/custom/ts");
    expect(findTailscaleBinary({ override: "/custom/ts", path: "/opt/bin", exists: present("/opt/bin/tailscale", MAC_APP_BINARY) })).toBeUndefined();
  });
});

describe("matchPeer", () => {
  const info = parseStatus(
    JSON.parse(
      statusJson({
        peers: [
          { host: "Prod-1", dns: "prod-1-a", online: false },
          { host: "other", dns: "prod-1", online: true },
          { host: "build-box", online: true },
        ],
      }),
    ),
  );

  it("matches HostName first, ignoring case", () => {
    expect(matchPeer(info, "prod-1")?.dns_name).toBe(`prod-1-a.${TAILNET}`);
    expect(matchPeer(info, "BUILD-BOX")?.host_name).toBe("build-box");
  });

  it("matches the first label of DNSName when no HostName matches", () => {
    expect(matchPeer(info, "prod-1-a")?.host_name).toBe("Prod-1");
    expect(matchPeer({ peers: info.peers.slice(1) }, "prod-1")?.host_name).toBe("other");
  });

  it("matches a full DNS name, with or without the trailing dot", () => {
    expect(matchPeer(info, `build-box.${TAILNET}.`)?.host_name).toBe("build-box");
  });

  it("prefers an online peer among equal matches", () => {
    const twins = parseStatus(JSON.parse(statusJson({ peers: [{ host: "twin", online: false }, { host: "twin", online: true }] })));
    expect(matchPeer(twins, "twin")?.online).toBe(true);
  });

  it("is undefined for a name nobody answers to, and for an empty name", () => {
    expect(matchPeer(info, "ghost")).toBeUndefined();
    expect(matchPeer(info, " ")).toBeUndefined();
  });
});

describe("addresses and reachability", () => {
  it("takes the first IPv4 address", () => {
    expect(firstIpv4(["fd7a::1", "100.64.0.7", "100.64.0.8"])).toBe("100.64.0.7");
    expect(firstIpv4(["fd7a::1"])).toBeUndefined();
  });

  it("knows loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.8.9.1", "localhost", "LOCALHOST", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["db.internal", "10.0.0.5", "0.0.0.0", "128.0.0.1"]) expect(isLoopbackHost(h)).toBe(false);
  });

  const scan = (port: number, address: string, protocol = "tcp") => ({ port, protocol, bind_address: address });

  it("refuses a port bound only to loopback", () => {
    expect(portBindProblem([scan(5432, "127.0.0.1")], 5432, "tcp")).toContain("listens only on 127.0.0.1");
    expect(portBindProblem([scan(5432, "127.0.0.1"), scan(5432, "::1")], 5432, "tcp")).toContain("listens only on");
  });

  it("allows a port with any listener on a reachable address", () => {
    for (const address of ["0.0.0.0", "::", "[::]", "*", "100.64.0.10"]) {
      expect(portBindProblem([scan(5432, "127.0.0.1"), scan(5432, address)], 5432, "tcp")).toBeUndefined();
    }
  });

  it("allows a port that is missing from the scan, or a missing scan, because the scan may be stale", () => {
    expect(portBindProblem([scan(80, "127.0.0.1")], 5432, "tcp")).toBeUndefined();
    expect(portBindProblem([], 5432, "tcp")).toBeUndefined();
    expect(portBindProblem(undefined, 5432, "tcp")).toBeUndefined();
  });

  it("keeps tcp and udp listeners apart", () => {
    expect(portBindProblem([scan(53, "127.0.0.1", "udp"), scan(53, "0.0.0.0", "tcp")], 53, "udp")).toContain("listens only on");
    expect(portBindProblem([scan(53, "127.0.0.1", "udp"), scan(53, "0.0.0.0", "tcp")], 53, "tcp")).toBeUndefined();
    expect(portBindProblem([scan(53, "127.0.0.1", "tcp6")], 53, "tcp")).toContain("listens only on");
  });

  it("rejects a target host only the server can resolve", () => {
    expect(targetProblem("tcp", "db.internal:5432")).toContain("not loopback");
    expect(targetProblem("tcp", "127.0.0.1:5432")).toBeUndefined();
    expect(targetProblem("https", "localhost:3000", [scan(3000, "127.0.0.1")])).toContain("listens only on");
  });
});

describe("Tailscale", () => {
  it("reads status once per 30 seconds, and again when a fresh reading is asked for", async () => {
    const runner = new FakeTailscaleRunner();
    let now = 1_000;
    const ts = new Tailscale({ runner: runner.runner, find: () => "/fake/tailscale", now: () => now });
    await ts.status();
    now += 29_999;
    await ts.status();
    expect(runner.statusCalls).toBe(1);
    await ts.status({ fresh: true });
    expect(runner.statusCalls).toBe(2);
    now += 30_000;
    await ts.status();
    expect(runner.statusCalls).toBe(3);
  });

  it("shares one reading between callers that ask at the same time", async () => {
    const runner = new FakeTailscaleRunner();
    const ts = fakeTailscale(runner);
    await Promise.all([ts.status(), ts.status(), ts.status()]);
    expect(runner.statusCalls).toBe(1);
  });

  it("asks only for status --json", async () => {
    const runner = new FakeTailscaleRunner();
    await fakeTailscale(runner).status();
    expect(runner.calls).toEqual([["/fake/tailscale", "status", "--json"]]);
  });

  it("reports not installed without running anything", async () => {
    const runner = new FakeTailscaleRunner();
    const info = await new Tailscale({ runner: runner.runner, find: () => undefined }).status();
    expect(info).toMatchObject({ installed: false, running: false });
    expect(runner.calls).toEqual([]);
  });

  it("reads a stopped app as installed and not running", async () => {
    const runner = new FakeTailscaleRunner();
    runner.status = STOPPED_STATUS;
    expect(await fakeTailscale(runner).status()).toMatchObject({ installed: true, running: false, backend_state: "Stopped" });
  });

  it("uses the JSON even when the command exits non-zero", async () => {
    const runner = new FakeTailscaleRunner();
    runner.statusCode = 1;
    expect((await fakeTailscale(runner).status()).running).toBe(true);
  });

  it("reports output that is not JSON as installed, not running, with the first line as the error", async () => {
    const runner = new FakeTailscaleRunner();
    runner.status = "failed to connect to local tailscaled\nmore detail\n";
    expect(await fakeTailscale(runner).status()).toMatchObject({ installed: true, running: false, error: "failed to connect to local tailscaled" });
  });

  it("reads served ports, and treats a failed read as none", async () => {
    const runner = new FakeTailscaleRunner();
    runner.serve = serveJson([{ port: 8443, proxy: "http://127.0.0.1:1" }]);
    const ts = fakeTailscale(runner);
    expect(await ts.served()).toEqual([{ port: 8443, kind: "https", target: "http://127.0.0.1:1" }]);
    expect(runner.calls.at(-1)).toEqual(["/fake/tailscale", "serve", "status", "--json"]);
    runner.serve = "not json";
    expect(await ts.served()).toEqual([]);
  });

  it("shapes the status view without the peers", async () => {
    const view = statusView(await fakeTailscale(new FakeTailscaleRunner()).status());
    expect(view).toEqual({ installed: true, running: true, state: "Running", tailnet: TAILNET, https_certificates: true });
  });
});
