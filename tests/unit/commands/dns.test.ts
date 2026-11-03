import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  buildAddBody,
  listPath,
  parsePriority,
  parseRecordType,
  parseTtl,
  recordRows,
  registerDns,
  removePath,
  type DnsRecord,
} from "../../../src/commands/dns";

function dnsCmd(): Command {
  const p = new Command();
  registerDns(p);
  return p.commands.find((c) => c.name() === "dns")!;
}

function recordsCmd(): Command {
  return dnsCmd().commands.find((c) => c.name() === "records")!;
}

function sub(name: string): Command {
  return recordsCmd().commands.find((c) => c.name() === name)!;
}

function usageError(fn: () => unknown): { message: string; exitCode: number } {
  try {
    fn();
  } catch (e) {
    return e as { message: string; exitCode: number };
  }
  throw new Error("expected a usage error");
}

describe("reoclo dns records", () => {
  test("registers ls, add and rm under dns records", () => {
    expect(dnsCmd().commands.map((c) => c.name())).toEqual(["records"]);
    expect(recordsCmd().commands.map((c) => c.name()).sort()).toEqual(["add", "ls", "rm"]);
  });

  test("ls takes a zone or name and an optional --type", () => {
    expect(sub("ls").registeredArguments.map((a) => a.name())).toEqual(["zoneOrName"]);
    expect(sub("ls").options.map((o) => o.long)).toContain("--type");
  });

  test("add requires --type and --content and offers --ttl, --priority, --zone", () => {
    const add = sub("add");
    const required = add.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required.sort()).toEqual(["--content", "--type"]);
    const flags = add.options.map((o) => o.long);
    for (const flag of ["--ttl", "--priority", "--zone"]) expect(flags).toContain(flag);
  });

  test("rm requires --zone and has --yes so it can run non-interactively", () => {
    const rm = sub("rm");
    expect(rm.options.find((o) => o.long === "--zone")?.mandatory).toBe(true);
    expect(rm.options.map((o) => o.long)).toContain("--yes");
  });
});

describe("argument parsing", () => {
  test("record types are case-insensitive and limited to TXT, CNAME and MX", () => {
    expect(parseRecordType("txt")).toBe("TXT");
    expect(parseRecordType(" Cname ")).toBe("CNAME");
    expect(parseRecordType("MX")).toBe("MX");
    const err = usageError(() => parseRecordType("A"));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain("TXT, CNAME, MX");
  });

  test("ttl is auto or 60 to 86400", () => {
    expect(parseTtl("auto")).toBe(1);
    expect(parseTtl("300")).toBe(300);
    for (const bad of ["5", "86401", "abc", "1.5"]) {
      expect(usageError(() => parseTtl(bad)).exitCode).toBe(2);
    }
  });

  test("priority is an integer from 0 to 65535", () => {
    expect(parsePriority("0")).toBe(0);
    expect(parsePriority("65535")).toBe(65535);
    for (const bad of ["-1", "65536", "x"]) {
      expect(usageError(() => parsePriority(bad)).exitCode).toBe(2);
    }
  });
});

describe("buildAddBody", () => {
  test("the DMARC TXT record", () => {
    const content = "v=DMARC1; p=none; rua=mailto:dmarc@example.com";
    expect(buildAddBody("_dmarc.example.com", { type: "txt", content })).toEqual({
      type: "TXT",
      name: "_dmarc.example.com",
      content,
    });
  });

  test("a relative name carries its zone, and ttl is passed as a number", () => {
    expect(
      buildAddBody("_dmarc", { type: "TXT", content: "x", zone: "example.com", ttl: "300" }),
    ).toEqual({ type: "TXT", name: "_dmarc", content: "x", zone: "example.com", ttl: 300 });
  });

  test("an MX record needs a priority", () => {
    expect(usageError(() => buildAddBody("example.com", { type: "MX", content: "m.example.com" })).exitCode).toBe(2);
    expect(
      buildAddBody("example.com", { type: "MX", content: "m.example.com", priority: "10" }),
    ).toEqual({ type: "MX", name: "example.com", content: "m.example.com", priority: 10 });
  });

  test("a priority on a TXT or CNAME record is refused", () => {
    for (const type of ["TXT", "CNAME"]) {
      const err = usageError(() => buildAddBody("a.example.com", { type, content: "x", priority: "5" }));
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain("MX");
    }
  });

  test("an unsupported type, an empty value and an empty name are refused", () => {
    expect(usageError(() => buildAddBody("a.example.com", { type: "A", content: "1.2.3.4" })).exitCode).toBe(2);
    expect(usageError(() => buildAddBody("a.example.com", { type: "TXT", content: "  " })).exitCode).toBe(2);
    expect(usageError(() => buildAddBody("  ", { type: "TXT", content: "x" })).exitCode).toBe(2);
  });
});

describe("request paths", () => {
  test("ls sends the name and the type, encoded", () => {
    expect(listPath("t1", "_dmarc.example.com")).toBe("/tenants/t1/dns/records?name=_dmarc.example.com");
    expect(listPath("t1", " example.com ", "MX")).toBe("/tenants/t1/dns/records?name=example.com&type=MX");
    expect(listPath("t1", "a b&c")).toBe("/tenants/t1/dns/records?name=a%20b%26c");
  });

  test("rm sends the record id in the path and the zone name in the query, encoded", () => {
    expect(removePath("t1", "abc123", "example.com")).toBe("/tenants/t1/dns/records/abc123?zone=example.com");
    expect(removePath("t1", "../x", "a b")).toBe("/tenants/t1/dns/records/..%2Fx?zone=a%20b");
  });
});

describe("recordRows", () => {
  test("shows auto ttl, a dash for no priority, and which records Reoclo manages", () => {
    const records: DnsRecord[] = [
      { id: "a", type: "TXT", name: "n", content: "c", ttl: 1, priority: null, managed: true },
      { id: "b", type: "MX", name: "m", content: "h", ttl: 300, priority: 10, managed: false },
    ];
    expect(recordRows(records)).toEqual([
      { id: "a", type: "TXT", name: "n", content: "c", ttl: "auto", priority: "-", managed: "reoclo" },
      { id: "b", type: "MX", name: "m", content: "h", ttl: "300", priority: "10", managed: "-" },
    ]);
  });
});
