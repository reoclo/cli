import { describe, expect, test } from "bun:test";
import {
  parseOpRef,
  opRefString,
  parseTemplate,
  TemplateError,
  collectRefs,
  lookup,
  renderInject,
  ResolutionError,
  buildEnv,
  assertInputExists,
} from "../../../src/secrets/template";
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

describe("collectRefs", () => {
  test("returns distinct projects and every ref", () => {
    const lines = parseTemplate(
      "A=op://prod/dep/A\nB=op://prod/dep/B\nC=op://staging/dep/C\n# x\nLIT=plain",
    );
    const { projects, refs } = collectRefs(lines);
    expect(projects.sort()).toEqual(["prod", "staging"]);
    expect(refs.map((r) => r.field).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("lookup", () => {
  const resolved = new Map([["prod", { A: "secret-a" }]]);
  test("returns the value for a present project+key", () => {
    expect(lookup(resolved, { vault: "prod", item: "dep", field: "A" })).toBe("secret-a");
  });
  test("throws ResolutionError (exit 6) naming the op path when key missing", () => {
    let err: unknown;
    try { lookup(resolved, { vault: "prod", item: "dep", field: "NOPE" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ResolutionError);
    expect((err as { exitCode: number }).exitCode).toBe(EXIT.RESOLUTION_FAILED);
    expect((err as Error).message).toContain("op://prod/dep/NOPE");
  });
  test("throws when the project itself is absent", () => {
    expect(() => lookup(resolved, { vault: "missing", item: "dep", field: "A" })).toThrow(ResolutionError);
  });
  test("a field literally named 'toString' is treated as missing, not an inherited function", () => {
    const withPrototypeCollision = new Map([["prod", { A: "secret-a" }]]);
    let err: unknown;
    try {
      lookup(withPrototypeCollision, { vault: "prod", item: "dep", field: "toString" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResolutionError);
    expect((err as { exitCode: number }).exitCode).toBe(EXIT.RESOLUTION_FAILED);
    expect((err as Error).message).toContain("op://prod/dep/toString");
  });
  test("a field literally named 'constructor' is treated as missing, not an inherited function", () => {
    const withPrototypeCollision = new Map([["prod", { A: "secret-a" }]]);
    expect(() =>
      lookup(withPrototypeCollision, { vault: "prod", item: "dep", field: "constructor" }),
    ).toThrow(ResolutionError);
  });
});

describe("assertInputExists", () => {
  test("does not throw when the file exists", () => {
    expect(() => assertInputExists(true, ".env.tpl")).not.toThrow();
  });
  test("throws TemplateError (exit MISUSE) naming the path when the file is missing", () => {
    let err: unknown;
    try {
      assertInputExists(false, ".env.tpl");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TemplateError);
    expect((err as { exitCode: number }).exitCode).toBe(EXIT.MISUSE);
    expect((err as Error).message).toContain(".env.tpl");
  });
});

describe("renderInject", () => {
  test("substitutes the op ref, preserving quotes and surrounding text", () => {
    const lines = parseTemplate('# header\nA=op://prod/dep/A\nJWT="op://prod/dep/JWT"\nLIT=plain\n');
    const resolved = new Map([["prod", { A: "aaa", JWT: "line1\nline2" }]]);
    expect(renderInject(lines, resolved)).toBe('# header\nA=aaa\nJWT="line1\nline2"\nLIT=plain\n');
  });
  test("a resolved value containing $ is inserted literally (no regex replacement)", () => {
    const lines = parseTemplate("P=op://prod/dep/P");
    const resolved = new Map([["prod", { P: "a$1b" }]]);
    expect(renderInject(lines, resolved)).toBe("P=a$1b");
  });
});

describe("buildEnv", () => {
  test("resolves refs, keeps literals (de-quoted), skips comments/blanks", () => {
    const lines = parseTemplate('# c\n\nA=op://prod/dep/A\nLIT="plain value"\nRAW=x');
    const resolved = new Map([["prod", { A: "aaa" }]]);
    expect(buildEnv(lines, resolved)).toEqual({ A: "aaa", LIT: "plain value", RAW: "x" });
  });
  test("propagates ResolutionError for a missing key (so run never spawns)", () => {
    const lines = parseTemplate("A=op://prod/dep/MISSING");
    expect(() => buildEnv(lines, new Map([["prod", {}]]))).toThrow();
  });
});
