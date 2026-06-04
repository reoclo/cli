import { describe, expect, test } from "bun:test";
import { buildOrgRows } from "../../../src/commands/org";
import type { OrgMembership } from "../../../src/client/types";

const memberships: OrgMembership[] = [
  { id: "1", tenant_id: "t1", tenant_slug: "acme", tenant_name: "Acme", role: "tenant_admin" },
  { id: "2", tenant_id: "t2", tenant_slug: "beta", tenant_name: "Beta", role: "viewer" },
];

describe("buildOrgRows", () => {
  test("text mode prettifies the role and marks the active org", () => {
    const rows = buildOrgRows(memberships, "t1", "text");
    expect(rows[0]!).toEqual({ active: "*", slug: "acme", name: "Acme", role: "Tenant Admin" });
    expect(rows[1]!).toEqual({ active: "", slug: "beta", name: "Beta", role: "Viewer" });
  });
  test("json mode keeps the raw role for machine consumers", () => {
    const rows = buildOrgRows(memberships, "t1", "json");
    expect(rows[0]!.role).toBe("tenant_admin");
    expect(rows[1]!.role).toBe("viewer");
  });
  test("yaml mode keeps the raw role and marks the active org", () => {
    const rows = buildOrgRows(memberships, "t2", "yaml");
    expect(rows[0]!.role).toBe("tenant_admin");
    expect(rows[1]!.active).toBe("*");
  });
});
