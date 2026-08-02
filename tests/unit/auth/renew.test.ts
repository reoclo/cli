// tests/unit/auth/renew.test.ts
import { describe, expect, test } from "bun:test";
import { jwtExp, RENEW_SUBPROTOCOL } from "../../../src/auth/renew";

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildJwt(payload: unknown, header: unknown = { alg: "none", typ: "JWT" }): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.sig`;
}

describe("jwtExp", () => {
  test("decodes exp from a well-formed JWT", () => {
    const token = buildJwt({ exp: 1234567890 });
    expect(jwtExp(token)).toBe(1234567890);
  });

  test("returns undefined for a malformed token missing segments", () => {
    expect(jwtExp("not.a.jwt")).toBeUndefined();
  });

  test("returns undefined for garbage input", () => {
    expect(jwtExp("garbage")).toBeUndefined();
  });

  test("returns undefined when the payload has no exp", () => {
    const token = buildJwt({ sub: "user-1" });
    expect(jwtExp(token)).toBeUndefined();
  });

  test("returns undefined when exp is not a number", () => {
    const token = buildJwt({ exp: "soon" });
    expect(jwtExp(token)).toBeUndefined();
  });
});

describe("RENEW_SUBPROTOCOL", () => {
  test("is the shared renewal subprotocol identifier", () => {
    expect(RENEW_SUBPROTOCOL).toBe("reoclo.renew.v1");
  });
});
