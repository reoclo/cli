// tests/unit/commands/shell.test.ts
import { expect, test, describe } from "bun:test";
import { Command } from "commander";
import { EXIT } from "../../../src/client/exit-codes";
import {
  base64url,
  buildShellSubprotocol,
  buildShellWsUrl,
  shellCloseToExit,
  SUBPROTOCOL_VERSION,
  registerShell,
} from "../../../src/commands/shell";

describe("shellCloseToExit", () => {
  // The mapping used to live inside a ws.onclose closure, so nothing tested it
  // and 4403 quietly returned 3 for months while HttpClient returned 4 for the
  // same condition (an HTTP 403).
  test("4403 forbidden is DENIED(4), not AUTH(3) — matches HttpClient's 403", () => {
    const r = shellCloseToExit(4403, "no access to server", 0);
    expect(r.exitCode).toBe(EXIT.DENIED);
    expect(r.exitCode).not.toBe(EXIT.AUTH);
    expect(r.message).toContain("forbidden");
  });

  test("4001 authentication failed is AUTH(3)", () => {
    expect(shellCloseToExit(4001, "bad token", 0).exitCode).toBe(EXIT.AUTH);
  });

  test("4404 is NOT_FOUND(5)", () => {
    expect(shellCloseToExit(4404, "no such server", 0).exitCode).toBe(EXIT.NOT_FOUND);
  });

  test("4400 is MISUSE(2)", () => {
    expect(shellCloseToExit(4400, "bad frame", 0).exitCode).toBe(EXIT.MISUSE);
  });

  test("4408 idle timeout is GENERIC(1) — the session lapsed, the plane is reachable", () => {
    const r = shellCloseToExit(4408, "", 0);
    expect(r.exitCode).toBe(EXIT.GENERIC);
    expect(r.message).toContain("idle timeout");
  });

  test("a normal close preserves the child's own exit code", () => {
    // 1000 after an 'exited' frame recorded 42: the child's code must survive.
    const r = shellCloseToExit(1000, "", 42);
    expect(r.exitCode).toBeNull();
    expect(r.message).toBeNull();
  });

  test("1005 (no status) is silent and preserves the current code", () => {
    const r = shellCloseToExit(1005, "", 7);
    expect(r.exitCode).toBeNull();
    expect(r.message).toBeNull();
  });

  test("an unknown close reports, but never overwrites a child's non-zero code", () => {
    const clean = shellCloseToExit(1006, "abnormal", 0);
    expect(clean.exitCode).toBe(EXIT.GENERIC);
    expect(clean.message).toContain("connection closed");

    const alreadyFailed = shellCloseToExit(1006, "abnormal", 42);
    expect(alreadyFailed.exitCode).toBeNull();
    expect(alreadyFailed.message).toContain("connection closed");
  });
});

describe("base64url", () => {
  test("encodes a simple ASCII key without padding or +/", () => {
    const out = base64url("rk_t_abc123");
    expect(out).not.toContain("=");
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
    expect(out).toBe("cmtfdF9hYmMxMjM");
  });

  test("uses url-safe substitutions for + and /", () => {
    // The 3-byte string "\xfb\xff\xbf" base64-encodes to "+/+/" — exercise
    // both substitution paths in one shot.
    const out = base64url("\xfb\xff\xbf");
    // After url-safe substitution and padding strip, all '+' -> '-' and '/' -> '_'.
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
    expect(out).not.toContain("=");
  });

  test("handles empty input", () => {
    expect(base64url("")).toBe("");
  });
});

describe("buildShellWsUrl", () => {
  test("rewrites https -> wss and appends the path", () => {
    expect(buildShellWsUrl("https://api.reoclo.com", "abc-123")).toBe(
      "wss://api.reoclo.com/mcp/ws/terminal/abc-123",
    );
  });

  test("rewrites http -> ws for local dev", () => {
    expect(buildShellWsUrl("http://localhost:8000", "abc-123")).toBe(
      "ws://localhost:8000/mcp/ws/terminal/abc-123",
    );
  });

  test("strips trailing slash from the base URL", () => {
    expect(buildShellWsUrl("https://api.reoclo.com/", "abc")).toBe(
      "wss://api.reoclo.com/mcp/ws/terminal/abc",
    );
  });

  test("preserves non-default ports", () => {
    expect(buildShellWsUrl("https://api.staging.reoclo.com:8443", "abc")).toBe(
      "wss://api.staging.reoclo.com:8443/mcp/ws/terminal/abc",
    );
  });
});

describe("buildShellSubprotocol", () => {
  test("emits the versioned reoclo.api-key prefix", () => {
    const sp = buildShellSubprotocol("rk_t_test");
    expect(sp.startsWith(`reoclo.api-key.${SUBPROTOCOL_VERSION}.`)).toBe(true);
  });

  test("base64url-encodes the token after the prefix", () => {
    const sp = buildShellSubprotocol("rk_t_test");
    const encoded = sp.split(".").pop() ?? "";
    expect(encoded).toBe(base64url("rk_t_test"));
  });

  test("never embeds the raw key", () => {
    const sp = buildShellSubprotocol("rk_t_secret_value");
    expect(sp).not.toContain("rk_t_secret_value");
  });
});

describe("reoclo shell --help", () => {
  test("includes an Examples block", () => {
    const p = new Command().name("reoclo").exitOverride();
    registerShell(p);
    const cmd = p.commands.find((c) => c.name() === "shell")!;
    const help = cmd.helpInformation();
    expect(help).toContain("Examples:");
    expect(help).toContain("reoclo shell my-server");
    expect(help).toContain("--allow-no-tty");
  });
});
