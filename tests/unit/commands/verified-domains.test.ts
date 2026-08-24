import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  matchVerifiedDomainForHostname,
  registerVerifiedDomains,
  type VerifiedDomain,
} from "../../../src/commands/verified-domains";

function vdCmd(): Command {
  const p = new Command();
  registerVerifiedDomains(p);
  return p.commands.find((c) => c.name() === "verified-domains")!;
}

function domain(root: string, status = "verified"): VerifiedDomain {
  return { id: `id-${root}`, root_domain: root, status };
}

describe("reoclo verified-domains", () => {
  test("registers the ownership lifecycle", () => {
    const names = vdCmd().commands.map((c) => c.name());
    expect(names.sort()).toEqual(["add", "get", "ls", "resources", "rm", "verify"].sort());
  });

  test("rm has --yes so it can run non-interactively", () => {
    const rm = vdCmd().commands.find((c) => c.name() === "rm")!;
    expect(rm.options.map((o) => o.long)).toContain("--yes");
  });
});

describe("matchVerifiedDomainForHostname", () => {
  test("matches a subdomain against its root", () => {
    const list = [domain("acme.com")];
    expect(matchVerifiedDomainForHostname(list, "status.acme.com")?.root_domain).toBe("acme.com");
  });

  test("matches the root domain itself", () => {
    const list = [domain("acme.com")];
    expect(matchVerifiedDomainForHostname(list, "acme.com")?.root_domain).toBe("acme.com");
  });

  test("prefers the longest matching root", () => {
    const list = [domain("acme.com"), domain("eu.acme.com")];
    expect(matchVerifiedDomainForHostname(list, "status.eu.acme.com")?.root_domain).toBe(
      "eu.acme.com",
    );
  });

  test("ignores case and a trailing dot", () => {
    const list = [domain("acme.com")];
    expect(matchVerifiedDomainForHostname(list, "STATUS.Acme.Com.")?.root_domain).toBe("acme.com");
  });

  test("does not match a domain that merely ends with the same letters", () => {
    const list = [domain("acme.com")];
    expect(matchVerifiedDomainForHostname(list, "notacme.com")).toBeNull();
  });

  test("returns null when nothing is registered", () => {
    expect(matchVerifiedDomainForHostname([], "status.acme.com")).toBeNull();
  });

  test("matches regardless of verification state — the caller checks status", () => {
    const list = [domain("acme.com", "pending")];
    expect(matchVerifiedDomainForHostname(list, "status.acme.com")?.status).toBe("pending");
  });
});
