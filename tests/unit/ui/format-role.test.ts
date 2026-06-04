import { describe, expect, test } from "bun:test";
import { formatRole } from "../../../src/ui/format-role";

describe("formatRole", () => {
  test("humanizes snake_case", () => {
    expect(formatRole("tenant_admin")).toBe("Tenant Admin");
  });
  test("humanizes super_admin", () => {
    expect(formatRole("super_admin")).toBe("Super Admin");
  });
  test("title-cases a single word", () => {
    expect(formatRole("viewer")).toBe("Viewer");
  });
  test("handles dashes", () => {
    expect(formatRole("read-only")).toBe("Read Only");
  });
  test("collapses repeated separators and trims", () => {
    expect(formatRole("  deployer__bot ")).toBe("Deployer Bot");
  });
  test("title-cases already-spaced input", () => {
    expect(formatRole("tenant admin")).toBe("Tenant Admin");
  });
});
