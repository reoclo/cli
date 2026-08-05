import { describe, expect, test } from "bun:test";
import { parseOpRef, opRefString, parseTemplate, TemplateError } from "../../../src/secrets/template";
import { EXIT } from "../../../src/client/exit-codes";

describe("parseOpRef", () => {
  test("parses a 3-segment op ref", () => {
    expect(parseOpRef("op://production/reoclo-deployment/MONGO_URI"))
      .toEqual({ vault: "production", item: "reoclo-deployment", field: "MONGO_URI" });
  });
  test("rejects a non-op string", () => {
    expect(parseOpRef("plain-value")).toBeNull();
  });
  test("rejects fewer than 3 segments", () => {
    expect(parseOpRef("op://prod/MONGO_URI")).toBeNull();
  });
  test("rejects empty segments", () => {
    expect(parseOpRef("op://prod//MONGO_URI")).toBeNull();
  });
  test("opRefString round-trips", () => {
    const r = { vault: "a", item: "b", field: "c" };
    expect(opRefString(r)).toBe("op://a/b/c");
  });
});

describe("parseTemplate", () => {
  test("classifies comment and blank lines as raw", () => {
    const lines = parseTemplate("# a comment\n\n");
    expect(lines[0]).toEqual({ kind: "raw", raw: "# a comment" });
    expect(lines[1]).toEqual({ kind: "raw", raw: "" });
  });
  test("classifies a whole-value ref (unquoted)", () => {
    const [l] = parseTemplate("MONGO_URI=op://production/reoclo-deployment/MONGO_URI");
    expect(l).toEqual({
      kind: "ref", key: "MONGO_URI", quote: null,
      ref: { vault: "production", item: "reoclo-deployment", field: "MONGO_URI" },
      raw: "MONGO_URI=op://production/reoclo-deployment/MONGO_URI",
    });
  });
  test("classifies a double-quoted ref and records the quote", () => {
    const [l] = parseTemplate('JWT_KEY="op://prod/dep/JWT"');
    expect(l).toMatchObject({ kind: "ref", key: "JWT_KEY", quote: '"' });
  });
  test("a bare op:// in a comment is NOT a ref", () => {
    const [l] = parseTemplate("# see op://prod/dep/OLD");
    expect(l!.kind).toBe("raw");
  });
  test("an op:// mid-string is a literal, not a ref", () => {
    const [l] = parseTemplate("DSN=postgres://u:op://prod/dep/PW@host");
    expect(l).toMatchObject({ kind: "literal", key: "DSN", value: "postgres://u:op://prod/dep/PW@host" });
  });
  test("a literal value is de-quoted for its env value but raw is preserved", () => {
    const [l] = parseTemplate('NAME="hello world"');
    expect(l).toMatchObject({ kind: "literal", key: "NAME", value: "hello world", raw: 'NAME="hello world"' });
  });
  test("a malformed op:// whole value throws TemplateError with MISUSE", () => {
    let err: unknown;
    try { parseTemplate("X=op://prod/ONLYTWO"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TemplateError);
    expect((err as { exitCode: number }).exitCode).toBe(EXIT.MISUSE);
    expect((err as Error).message).toContain("line 1");
  });
});
