import { describe, expect, test } from "bun:test";
import { describeBlockers, serviceTunnels, tunnelCommand } from "../../../src/client/network-access";

describe("tunnelCommand", () => {
  test("forwards the same local port over TCP", () => {
    expect(tunnelCommand("web-1", { port: 5432, protocol: "tcp" })).toBe("reoclo tunnel web-1 -L 5432:5432");
  });

  test("adds --udp for a UDP service", () => {
    expect(tunnelCommand("web-1", { port: 51820, protocol: "UDP" })).toBe(
      "reoclo tunnel web-1 -L 51820:51820 --udp",
    );
  });
});

describe("serviceTunnels", () => {
  test("lists a port bound on IPv4 and IPv6 once", () => {
    const tunnels = serviceTunnels("web-1", [
      { port: 5432, protocol: "tcp", bind_address: "127.0.0.1", process: "postgres" },
      { port: 5432, protocol: "tcp", bind_address: "::1", process: "postgres" },
      { port: 5432, protocol: "udp", bind_address: "0.0.0.0", process: null },
    ]);
    expect(tunnels.map((t) => t.command)).toEqual([
      "reoclo tunnel web-1 -L 5432:5432",
      "reoclo tunnel web-1 -L 5432:5432 --udp",
    ]);
  });
});

test("describeBlockers names the kind and label of each blocker", () => {
  expect(describeBlockers([{ kind: "domain", label: "app.example.com", href: null }])).toEqual([
    "domain: app.example.com",
  ]);
});
