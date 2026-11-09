import { describe, expect, it } from "bun:test";
import { approvalRows, formatApprovals } from "../../../src/commands/tunnel-approvals";
import { detailFor, formatExpiry } from "../../../src/commands/tunnel-saved";
import type { ApprovalView } from "../../../src/tunnels/approvals";
import type { TunnelView } from "../../../src/tunnels/manager";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const at = (ms: number): string => new Date(NOW + ms).toISOString();

const approval = (extra: Partial<ApprovalView> = {}): ApprovalView => ({
  id: "a1b2c3d4",
  agent: "claude-code",
  action: "save_tunnel",
  description: "Save reverse tunnel hook",
  status: "pending",
  created_at: at(0),
  expires_at: at(9 * 60_000),
  ...extra,
});

function captured(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe("formatExpiry", () => {
  it("says how long is left", () => {
    expect(formatExpiry(at(30_000), NOW)).toBe("in 30s");
    expect(formatExpiry(at(9 * 60_000 + 20_000), NOW)).toBe("in 9m");
    expect(formatExpiry(at(65 * 60_000), NOW)).toBe("in 1h 5m");
  });

  it("says expired once the time has passed, or for a bad timestamp", () => {
    expect(formatExpiry(at(0), NOW)).toBe("expired");
    expect(formatExpiry(at(-1000), NOW)).toBe("expired");
    expect(formatExpiry("not a date", NOW)).toBe("expired");
  });
});

describe("detailFor for ad-hoc tunnels", () => {
  const view = (extra: Partial<TunnelView>): TunnelView => ({
    name: "adhoc-1",
    org: "acme",
    server: "prod-1",
    server_id: "s1",
    kind: "tcp",
    keep_up: false,
    enabled: true,
    via: "reoclo",
    path: "relay",
    state: "ready",
    message: "Listening, no session open",
    action: "None",
    traffic: { bytes_in: 0, bytes_out: 0, streams: 0 },
    ...extra,
  });

  it("adds when an ad-hoc tunnel ends", () => {
    expect(detailFor(view({ adhoc: true, expires_at: at(42 * 60_000) }), NOW)).toBe("ends in 42m");
    expect(detailFor(view({ adhoc: true, expires_at: at(42 * 60_000), detail: "runner gone" }), NOW)).toBe("runner gone; ends in 42m");
  });

  it("leaves a saved tunnel's detail alone", () => {
    expect(detailFor(view({}), NOW)).toBe("");
    expect(detailFor(view({ action: "Run reoclo login" }), NOW)).toBe("Run reoclo login");
  });
});

describe("approvals output", () => {
  it("shows pending approvals with the time left", () => {
    expect(approvalRows([approval()], NOW, false)).toEqual([
      {
        id: "a1b2c3d4",
        agent: "claude-code",
        action: "save_tunnel",
        description: "Save reverse tunnel hook",
        expires: "in 9m",
      },
    ]);
  });

  it("adds the status for --all and no expiry for a decided one", () => {
    const rows = approvalRows([approval({ status: "denied" })], NOW, true);
    expect(rows[0]).toMatchObject({ status: "denied", expires: "" });
  });

  it("prints one JSON object per line", () => {
    const out = captured(() => formatApprovals([approval(), approval({ id: "second" })], "json", false, NOW));
    expect(out.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id)).toEqual(["a1b2c3d4", "second"]);
  });

  it("says when there is nothing to approve", () => {
    expect(captured(() => formatApprovals([], "text", false, NOW))).toBe("no pending approvals\n");
    expect(captured(() => formatApprovals([], "text", true, NOW))).toBe("no approvals\n");
  });
});
