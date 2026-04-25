// tests/unit/commands/shell.test.ts
import { expect, test, describe } from "bun:test";
import {
  base64url,
  buildShellSubprotocol,
  buildShellWsUrl,
  SUBPROTOCOL_VERSION,
} from "../../../src/commands/shell";

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
