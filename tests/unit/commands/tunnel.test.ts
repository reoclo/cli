import { describe, it, expect } from "bun:test";
import { parseTunnelArgs, buildTunnelWsUrl, formatTunnelTable, formatTunnelDescribe } from "../../../src/commands/tunnel";
import type { TunnelSessionRead } from "../../../src/commands/tunnel";

describe("parseTunnelArgs", () => {
  it("parses -L with 2 parts as local_port:remote_port (remote_host defaults to 127.0.0.1)", () => {
    const r = parseTunnelArgs("srv-1", { L: ["5432:5432"] });
    expect(r.forwards).toEqual([{
      localBind: "127.0.0.1", localPort: 5432, remoteHost: "127.0.0.1", remotePort: 5432, proto: "tcp",
    }]);
  });

  it("parses -L with 3 parts as local_port:remote_host:remote_port", () => {
    const r = parseTunnelArgs("srv-1", { L: ["8080:internal-db:5432"] });
    expect(r.forwards[0]).toEqual({
      localBind: "127.0.0.1", localPort: 8080, remoteHost: "internal-db", remotePort: 5432, proto: "tcp",
    });
  });

  it("parses -L with 4 parts as bind:local_port:remote_host:remote_port", () => {
    const r = parseTunnelArgs("srv-1", { L: ["0.0.0.0:8080:internal:80"] });
    expect(r.forwards[0]!.localBind).toBe("0.0.0.0");
    expect(r.forwards[0]!.localPort).toBe(8080);
    expect(r.forwards[0]!.remoteHost).toBe("internal");
    expect(r.forwards[0]!.remotePort).toBe(80);
  });

  it("rejects malformed -L (1 part)", () => {
    expect(() => parseTunnelArgs("srv-1", { L: ["just-one"] })).toThrow(/invalid -L/);
  });

  it("rejects invalid bind", () => {
    expect(() => parseTunnelArgs("srv-1", { L: ["10.0.0.5:8080:x:80"] })).toThrow(/invalid -L bind/);
  });

  it("rejects out-of-range local_port", () => {
    expect(() => parseTunnelArgs("srv-1", { L: ["99999:x:80"] })).toThrow(/local_port/);
  });

  it("rejects out-of-range remote_port", () => {
    expect(() => parseTunnelArgs("srv-1", { L: ["8080:x:0"] })).toThrow(/remote_port/);
  });

  it("requires at least one -L or -R", () => {
    expect(() => parseTunnelArgs("srv-1", {})).toThrow(/-L or -R/);
  });

  it("supports multiple -L specs", () => {
    const r = parseTunnelArgs("srv-1", { L: ["5432:5432", "6379:6379"] });
    expect(r.forwards.length).toBe(2);
    expect(r.forwards[0]!.localPort).toBe(5432);
    expect(r.forwards[1]!.localPort).toBe(6379);
  });

  it("parses --reconnect-deadline as seconds → ms", () => {
    const r = parseTunnelArgs("srv-1", { L: ["80:80"], reconnectDeadline: "60" });
    expect(r.reconnectDeadlineMs).toBe(60_000);
  });

  it("defaults --reconnect-deadline to 300 seconds", () => {
    const r = parseTunnelArgs("srv-1", { L: ["80:80"] });
    expect(r.reconnectDeadlineMs).toBe(300_000);
  });
});

describe("buildTunnelWsUrl", () => {
  it("converts https to wss and adds /v1/tunnel with server_id", () => {
    expect(buildTunnelWsUrl("https://direct.reoclo.com", "srv-abc"))
      .toBe("wss://direct.reoclo.com/v1/tunnel?server_id=srv-abc");
  });

  it("converts http to ws", () => {
    expect(buildTunnelWsUrl("http://localhost:8002", "srv-1"))
      .toBe("ws://localhost:8002/v1/tunnel?server_id=srv-1");
  });

  it("strips a trailing slash on directUrl", () => {
    expect(buildTunnelWsUrl("https://direct.reoclo.com/", "srv-x"))
      .toBe("wss://direct.reoclo.com/v1/tunnel?server_id=srv-x");
  });

  it("url-encodes special characters in server_id", () => {
    expect(buildTunnelWsUrl("https://direct.reoclo.com", "srv with spaces"))
      .toBe("wss://direct.reoclo.com/v1/tunnel?server_id=srv%20with%20spaces");
  });
});

describe("parseTunnelArgs --udp flag", () => {
  it("defaults proto to tcp when --udp omitted", () => {
    const r = parseTunnelArgs("srv-1", { L: ["5432:5432"] });
    expect(r.forwards[0]!.proto).toBe("tcp");
  });

  it("sets proto to udp when --udp passed", () => {
    const r = parseTunnelArgs("srv-1", { L: ["5353:53"], udp: true });
    expect(r.forwards[0]!.proto).toBe("udp");
  });

  it("applies --udp to ALL -L specs in the invocation", () => {
    const r = parseTunnelArgs("srv-1", { L: ["5353:53", "5354:54", "5355:55"], udp: true });
    expect(r.forwards.map((f) => f.proto)).toEqual(["udp", "udp", "udp"]);
  });

  it("--udp false explicit is same as omitted (tcp)", () => {
    const r = parseTunnelArgs("srv-1", { L: ["80:80"], udp: false });
    expect(r.forwards[0]!.proto).toBe("tcp");
  });

  it("UDP forwards preserve all other parsed fields", () => {
    const r = parseTunnelArgs("srv-1", { L: ["0.0.0.0:5353:internal:53"], udp: true });
    expect(r.forwards[0]).toEqual({
      localBind: "0.0.0.0",
      localPort: 5353,
      remoteHost: "internal",
      remotePort: 53,
      proto: "udp",
    });
  });
});

describe("parseTunnelArgs --R reverse spec", () => {
  it("parses -R with 2 parts as remote_port:local_port (local_host=127.0.0.1)", () => {
    const r = parseTunnelArgs("srv-1", { R: ["8080:8080"] });
    expect(r.reverses).toEqual([{
      remoteBind: "127.0.0.1", remotePort: 8080, localHost: "127.0.0.1", localPort: 8080, proto: "tcp",
    }]);
  });

  it("parses -R with 3 parts as remote_port:local_host:local_port", () => {
    const r = parseTunnelArgs("srv-1", { R: ["9000:127.0.0.1:3000"] });
    expect(r.reverses[0]).toEqual({
      remoteBind: "127.0.0.1", remotePort: 9000, localHost: "127.0.0.1", localPort: 3000, proto: "tcp",
    });
  });

  it("parses -R with 4 parts as bind:remote_port:local_host:local_port (requires --bind-public for 0.0.0.0)", () => {
    const r = parseTunnelArgs("srv-1", { R: ["0.0.0.0:80:127.0.0.1:8000"], bindPublic: true });
    expect(r.reverses[0]).toEqual({
      remoteBind: "0.0.0.0", remotePort: 80, localHost: "127.0.0.1", localPort: 8000, proto: "tcp",
    });
  });

  it("rejects 4-part -R with bind=0.0.0.0 when --bind-public is missing", () => {
    expect(() => parseTunnelArgs("srv-1", { R: ["0.0.0.0:80:127.0.0.1:8000"] })).toThrow(/--bind-public/);
  });

  it("accepts explicit bind=127.0.0.1 without --bind-public", () => {
    const r = parseTunnelArgs("srv-1", { R: ["127.0.0.1:8080:127.0.0.1:3000"] });
    expect(r.reverses[0]!.remoteBind).toBe("127.0.0.1");
  });

  it("rejects invalid bind in 4-part form", () => {
    expect(() => parseTunnelArgs("srv-1", { R: ["10.0.0.5:80:x:1"], bindPublic: true })).toThrow(/invalid -R bind/);
  });

  it("rejects hex/decimal/negative ports", () => {
    expect(() => parseTunnelArgs("srv-1", { R: ["0x50:127.0.0.1:80"] })).toThrow(/remote_port/);
    expect(() => parseTunnelArgs("srv-1", { R: ["8080:127.0.0.1:0"] })).toThrow(/local_port/);
  });

  it("rejects remote_port=0 on -R (port 0 is not a meaningful listen port)", () => {
    expect(() => parseTunnelArgs("srv-1", { R: ["0:127.0.0.1:80"] })).toThrow(/remote_port/);
  });

  it("--udp applies to -R specs too", () => {
    const r = parseTunnelArgs("srv-1", { R: ["8080:3000"], udp: true });
    expect(r.reverses[0]!.proto).toBe("udp");
  });

  it("--udp applies to both -L and -R when mixed", () => {
    const r = parseTunnelArgs("srv-1", { L: ["5432:5432"], R: ["8080:3000"], udp: true });
    expect(r.forwards[0]!.proto).toBe("udp");
    expect(r.reverses[0]!.proto).toBe("udp");
  });

  it("supports multiple -R specs", () => {
    const r = parseTunnelArgs("srv-1", { R: ["8080:3000", "9090:4000"] });
    expect(r.reverses.length).toBe(2);
    expect(r.reverses[0]!.remotePort).toBe(8080);
    expect(r.reverses[1]!.remotePort).toBe(9090);
  });

  it("accepts -L and -R together", () => {
    const r = parseTunnelArgs("srv-1", { L: ["5432:5432"], R: ["8080:3000"] });
    expect(r.forwards.length).toBe(1);
    expect(r.reverses.length).toBe(1);
  });

  it("error message change: at least one -L or -R is required", () => {
    expect(() => parseTunnelArgs("srv-1", {})).toThrow(/-L or -R/);
  });
});

describe("deriveDirectUrl behaviors via integration with buildTunnelWsUrl context", () => {
  // deriveDirectUrl is internal, but its observable behavior is the directUrl
  // produced for the gateway. We test the wider parseTunnelArgs+URL build flow
  // indirectly via env-override and direct URL inspection where possible.

  it("rejects hex port literals (Number-coercion safety)", () => {
    expect(() => parseTunnelArgs("srv-1", { L: ["0x50:remote:80"] })).toThrow(/local_port/);
    expect(() => parseTunnelArgs("srv-1", { L: ["8080:remote:0x50"] })).toThrow(/remote_port/);
  });

  it("rejects empty port segments", () => {
    expect(() => parseTunnelArgs("srv-1", { L: [":remote:80"] })).toThrow();
    expect(() => parseTunnelArgs("srv-1", { L: ["8080:remote:"] })).toThrow();
  });

  it("rejects float port literals", () => {
    expect(() => parseTunnelArgs("srv-1", { L: ["8080.5:remote:80"] })).toThrow(/local_port/);
  });
});

// ── Helpers for new subcommand tests ─────────────────────────────────────────

function makeTunnelSession(overrides: Partial<TunnelSessionRead> = {}): TunnelSessionRead {
  return {
    id: "tun-abc123",
    tenant_id: "tenant-1",
    server_id: "srv-aaa",
    user_id: "user-1",
    tunnel_id: "tun-abc123",
    mode: "forward",
    proto: "tcp",
    local_port: 5432,
    remote_host: "127.0.0.1",
    remote_port: 5432,
    bind: "127.0.0.1",
    reason: null,
    opened_at: "2025-05-01T10:00:00Z",
    closed_at: null,
    close_reason: null,
    bytes_in: 1024,
    bytes_out: 2048,
    datagrams_in: 0,
    datagrams_out: 0,
    peer_count: 1,
    interruptions: [],
    ...overrides,
  };
}

// ── formatTunnelTable unit tests ──────────────────────────────────────────────

describe("formatTunnelTable", () => {
  it("writes JSON lines when fmt=json", () => {
    const session = makeTunnelSession();
    const origWrite = process.stdout.write.bind(process.stdout);
    // Capture stdout writes
    let captured = "";
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelTable([session], "json");
    } finally {
      process.stdout.write = origWrite;
    }
    const parsed = JSON.parse(captured.trim());
    expect(parsed.id).toBe("tun-abc123");
    expect(parsed.server_id).toBe("srv-aaa");
  });

  it("prints friendly message for empty list in text mode", () => {
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelTable([], "text");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toContain("no tunnels found");
  });

  it("prints friendly message for empty list in json mode (outputs nothing, no error)", () => {
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelTable([], "json");
    } finally {
      process.stdout.write = origWrite;
    }
    // json mode with empty list emits nothing (each line per item — no items → no output)
    expect(captured).toBe("");
  });

  it("renders table header with expected columns in text mode", () => {
    const session = makeTunnelSession();
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelTable([session], "text");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toContain("TUNNEL ID");
    expect(captured).toContain("SERVER");
    expect(captured).toContain("MODE");
    expect(captured).toContain("PROTO");
    expect(captured).toContain("PORTS");
    expect(captured).toContain("OPENED");
    expect(captured).toContain("STATUS");
    expect(captured).toContain("BYTES IN/OUT");
  });

  it("shows 'active' status for open session", () => {
    const session = makeTunnelSession({ closed_at: null });
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelTable([session], "text");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toContain("active");
  });

  it("shows 'closed' status for closed session", () => {
    const session = makeTunnelSession({ closed_at: "2025-05-01T11:00:00Z", close_reason: "user_request" });
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelTable([session], "text");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toContain("closed");
    expect(captured).toContain("user_request");
  });

  it("shows port spec in PORTS column", () => {
    const session = makeTunnelSession({ local_port: 5432, remote_host: "db.internal", remote_port: 5432 });
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelTable([session], "text");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toContain(":5432→db.internal:5432");
  });
});

// ── formatTunnelDescribe unit tests ───────────────────────────────────────────

describe("formatTunnelDescribe", () => {
  it("outputs JSON when fmt=json", () => {
    const session = makeTunnelSession();
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelDescribe(session, "json");
    } finally {
      process.stdout.write = origWrite;
    }
    const parsed = JSON.parse(captured);
    expect(parsed.id).toBe("tun-abc123");
    expect(parsed.interruptions).toEqual([]);
  });

  it("renders all top-level fields in text mode", () => {
    const session = makeTunnelSession();
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelDescribe(session, "text");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toContain("id");
    expect(captured).toContain("tun-abc123");
    expect(captured).toContain("server_id");
    expect(captured).toContain("opened_at");
    expect(captured).toContain("interruptions: none");
  });

  it("renders interruptions sub-list in text mode", () => {
    const session = makeTunnelSession({
      interruptions: [
        { at: "2025-05-01T10:30:00Z", reason: "network_reset", recovered_at: "2025-05-01T10:30:15Z" },
        { at: "2025-05-01T10:45:00Z", reason: "timeout", recovered_at: null },
      ],
    });
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      formatTunnelDescribe(session, "text");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toContain("interruptions (2)");
    expect(captured).toContain("network_reset");
    expect(captured).toContain("recovered_at=2025-05-01T10:30:15Z");
    expect(captured).toContain("timeout");
    expect(captured).toContain("(not recovered)");
  });
});

// ── Regression: existing parseTunnelArgs wiring still works ───────────────────

describe("regression: parseTunnelArgs still works (open-tunnel path unchanged)", () => {
  it("parseTunnelArgs produces correct parsed args for the open-tunnel invocation", () => {
    const r = parseTunnelArgs("my-server", { L: ["5432:5432"], udp: false });
    expect(r.server).toBe("my-server");
    expect(r.forwards.length).toBe(1);
    expect(r.forwards[0]!.localPort).toBe(5432);
    expect(r.forwards[0]!.remotePort).toBe(5432);
    expect(r.forwards[0]!.proto).toBe("tcp");
    expect(r.reverses.length).toBe(0);
  });

  it("parseTunnelArgs with -R still works for reverse spec", () => {
    const r = parseTunnelArgs("my-server", { R: ["8080:3000"] });
    expect(r.server).toBe("my-server");
    expect(r.reverses.length).toBe(1);
    expect(r.reverses[0]!.remotePort).toBe(8080);
    expect(r.reverses[0]!.localPort).toBe(3000);
  });

  it("buildTunnelWsUrl still produces correct WebSocket URL", () => {
    expect(buildTunnelWsUrl("https://direct.reoclo.com", "srv-xyz"))
      .toBe("wss://direct.reoclo.com/v1/tunnel?server_id=srv-xyz");
  });
});
