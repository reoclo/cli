// tests/unit/commands/secrets.test.ts
import { describe, expect, test } from "bun:test";
import { resolveProjectId, readSecretValue } from "../../../src/commands/secrets";
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

describe("readSecretValue", () => {
  test("prefers --value", async () => {
    expect(await readSecretValue({ value: "v" }, "ignored")).toBe("v");
  });
  test("falls back to stdin", async () => {
    expect(await readSecretValue({}, "from-stdin\n")).toBe("from-stdin");
  });
  test("reads --from-file and strips a trailing newline (over stdin)", async () => {
    const path = `/tmp/reoclo-secret-fromfile-${process.pid}.txt`;
    await Bun.write(path, "s3cret\n");
    expect(await readSecretValue({ fromFile: path }, "ignored-stdin")).toBe("s3cret");
  });
  test("throws when no source", async () => {
    let err: unknown;
    try {
      await readSecretValue({}, null);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});
