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

// resolveWhoamiType: with KeyType now a three-way union ("tenant" |
// "automation" | "machine"), the label is a pure map off tokenType alone —
// no more prefix-sniffing to tell a human session from an agent credential.
test("resolveWhoamiType labels 'machine' tokenType 'machine'", () => {
  expect(resolveWhoamiType("machine")).toBe("machine");
});

test("resolveWhoamiType labels 'tenant' tokenType 'user'", () => {
  expect(resolveWhoamiType("tenant")).toBe("user");
});

test("resolveWhoamiType passes through 'automation' unchanged", () => {
  expect(resolveWhoamiType("automation")).toBe("automation");
});
