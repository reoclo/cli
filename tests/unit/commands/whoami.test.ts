import { test, expect } from "bun:test";
import { formatWhoamiLines, resolveWhoamiType } from "../../../src/commands/whoami";

test("formatWhoamiLines shows the account and a plain org count, not a list", () => {
  const lines = formatWhoamiLines({
    org: "acme", user: "a@b.co", api: "https://api.reoclo.com",
    type: "user", prefix: "abcd1234", orgCount: 3,
  });
  const out = lines.join("\n");
  expect(out).toContain("organization:  acme");
  expect(out).toContain("user:          a@b.co");
  expect(out).toContain("organizations: 3");
  expect(out).not.toContain("tenant_admin"); // no per-org listing
});

test("formatWhoamiLines pluralizes/handles a single org", () => {
  const lines = formatWhoamiLines({
    org: "acme", user: "a@b.co", api: "x", type: "user", prefix: "abcd1234", orgCount: 1,
  });
  expect(lines.join("\n")).toContain("organizations: 1");
});

// resolveWhoamiType: a machine token (rk_m_*) routes as tokenType "tenant"
// (full /mcp surface, same as an OAuth user) but must be labeled "machine",
// not "user", so operators can tell a human session from an agent's
// credential at a glance.
test("resolveWhoamiType labels an rk_m_ token 'machine' even though its tokenType is 'tenant'", () => {
  expect(resolveWhoamiType("tenant", "rk_m_abcd")).toBe("machine");
});

test("resolveWhoamiType labels a non-machine tenant token 'user'", () => {
  expect(resolveWhoamiType("tenant", "oauth-tok")).toBe("user");
});

test("resolveWhoamiType passes through 'automation' unchanged", () => {
  expect(resolveWhoamiType("automation", "rca_abcd")).toBe("automation");
});
