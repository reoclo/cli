import { describe, expect, it } from "bun:test";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  BlockError,
  HostnameError,
  assertValidSuffix,
  inSuffix,
  isValidHostname,
  readBlock,
  renderBlock,
  replaceBlock,
  suffixFor,
  validateHelperEntry,
} from "../../../src/tunnels/hosts-block";

const SYSTEM = "127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1             localhost\n";

describe("renderBlock", () => {
  it("writes both loopback addresses for each sorted, de-duplicated hostname", () => {
    expect(renderBlock(["b.reoclo.localhost", "a.reoclo.localhost", "b.reoclo.localhost"])).toBe(
      [
        BLOCK_BEGIN,
        "127.0.0.1 a.reoclo.localhost",
        "::1 a.reoclo.localhost",
        "127.0.0.1 b.reoclo.localhost",
        "::1 b.reoclo.localhost",
        BLOCK_END,
        "",
      ].join("\n"),
    );
  });

  it("renders nothing for an empty list", () => {
    expect(renderBlock([])).toBe("");
  });
});

describe("replaceBlock", () => {
  const entries = ["x.reoclo.localhost"];

  it("appends the block when the file has none, leaving every line alone", () => {
    const out = replaceBlock(SYSTEM, entries);
    expect(out.startsWith(SYSTEM)).toBe(true);
    expect(out.slice(SYSTEM.length)).toBe(renderBlock(entries));
  });

  it("adds the missing newline when the file does not end in one", () => {
    const out = replaceBlock("127.0.0.1 localhost", entries);
    expect(out).toBe(`127.0.0.1 localhost\n${renderBlock(entries)}`);
  });

  it("builds a block in an empty file", () => {
    expect(replaceBlock("", entries)).toBe(renderBlock(entries));
  });

  it("replaces only the lines between the markers", () => {
    const before = `${SYSTEM}# mine\n${renderBlock(["old.reoclo.localhost"])}10.0.0.1 after\n`;
    const out = replaceBlock(before, entries);
    expect(out).toBe(`${SYSTEM}# mine\n${renderBlock(entries)}10.0.0.1 after\n`);
  });

  it("is idempotent", () => {
    const once = replaceBlock(SYSTEM, entries);
    expect(replaceBlock(once, entries)).toBe(once);
  });

  it("removes the block, and only the block, when the list is empty", () => {
    const withBlock = `${SYSTEM}${renderBlock(entries)}10.0.0.1 after\n`;
    expect(replaceBlock(withBlock, [])).toBe(`${SYSTEM}10.0.0.1 after\n`);
    expect(replaceBlock(SYSTEM, [])).toBe(SYSTEM);
  });

  it("keeps CRLF line endings, including in the new block", () => {
    const crlf = "127.0.0.1 localhost\r\n::1 localhost\r\n";
    const out = replaceBlock(crlf, entries);
    expect(out).toBe(`${crlf}${renderBlock(entries, "\r\n")}`);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    const again = replaceBlock(out, ["y.reoclo.localhost"]);
    expect(again.replace(/\r\n/g, "")).not.toContain("\n");
    expect(again.startsWith(crlf)).toBe(true);
  });

  it("refuses a block with a missing end marker, a repeated block or markers out of order", () => {
    expect(() => replaceBlock(`${BLOCK_BEGIN}\n127.0.0.1 a.reoclo.localhost\n`, entries)).toThrow(BlockError);
    expect(() => replaceBlock(`${renderBlock(entries)}${renderBlock(entries)}`, entries)).toThrow(BlockError);
    expect(() => replaceBlock(`${BLOCK_END}\n${BLOCK_BEGIN}\n`, entries)).toThrow(BlockError);
  });
});

describe("readBlock", () => {
  it("lists the hostnames in the block", () => {
    const text = `${SYSTEM}${renderBlock(["b.reoclo.localhost", "a.reoclo.localhost"])}`;
    expect(readBlock(text)).toEqual(["a.reoclo.localhost", "b.reoclo.localhost"]);
    expect(readBlock(SYSTEM)).toEqual([]);
  });
});

describe("hostnames and suffixes", () => {
  it("accepts DNS names with two or more labels and rejects the rest", () => {
    expect(isValidHostname("grafana.prod-1.reoclo.localhost")).toBe(true);
    expect(isValidHostname("a.internal")).toBe(true);
    for (const bad of ["localhost", "UPPER.reoclo.localhost", "a_b.reoclo.localhost", "-a.reoclo.localhost", "a..b", "a.b-", "x y.localhost", ""]) {
      expect(isValidHostname(bad)).toBe(false);
    }
    expect(isValidHostname(`${"a".repeat(64)}.localhost`)).toBe(false);
    expect(isValidHostname(`${"a.".repeat(130)}localhost`)).toBe(false);
  });

  it("matches a suffix itself and its subdomains only", () => {
    expect(inSuffix("reoclo.localhost", "reoclo.localhost")).toBe(true);
    expect(inSuffix("a.reoclo.localhost", "reoclo.localhost")).toBe(true);
    expect(inSuffix("evilreoclo.localhost", "reoclo.localhost")).toBe(false);
    expect(suffixFor("db.internal", ["internal"])).toBe("internal");
    expect(suffixFor("db.example.com", ["internal"])).toBeUndefined();
  });

  it("accepts reserved single labels and multi-label suffixes, and rejects a bare public TLD", () => {
    for (const ok of ["internal", "test", "corp.example.com", "home.arpa"]) expect(() => assertValidSuffix(ok)).not.toThrow();
    for (const bad of ["com", "dev", "Internal", ".internal", "a..b", ""]) expect(() => assertValidSuffix(bad)).toThrow(HostnameError);
  });

  it("validates helper entries against .localhost and the allowlist", () => {
    expect(validateHelperEntry("a.reoclo.localhost", [])).toBeUndefined();
    expect(validateHelperEntry("a.anything.localhost", [])).toBeUndefined();
    expect(validateHelperEntry("a.internal", ["internal"])).toBeUndefined();
    expect(validateHelperEntry("a.internal", [])).toMatch(/allowed suffix/);
    expect(validateHelperEntry("github.com", ["internal"])).toMatch(/allowed suffix/);
    expect(validateHelperEntry("internal", ["internal"])).toMatch(/not a valid hostname/);
    expect(validateHelperEntry("a.b.localhost.evil.com", [])).toMatch(/allowed suffix/);
    expect(validateHelperEntry("not a host", [])).toMatch(/not a valid hostname/);
  });
});
