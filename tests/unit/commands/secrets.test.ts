// tests/unit/commands/secrets.test.ts
import { describe, expect, test } from "bun:test";
import { resolveProjectId } from "../../../src/commands/secrets";
import type { SecretProjectRead } from "../../../src/client/secrets";

describe("resolveProjectId", () => {
  const projects: SecretProjectRead[] = [
    { id: "11111111-1111-1111-1111-111111111111", name: "prod" },
  ];

  test("matches by name", () => {
    expect(resolveProjectId(projects, "prod")).toBe(projects[0]!.id);
  });

  test("matches by id", () => {
    expect(resolveProjectId(projects, projects[0]!.id)).toBe(projects[0]!.id);
  });

  test("throws on unknown", () => {
    expect(() => resolveProjectId(projects, "nope")).toThrow();
  });
});
