import { test, expect } from "bun:test";
import { formatWhoamiLines } from "../../../src/commands/whoami";

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
