// tests/unit/commands/secrets.test.ts
import { describe, expect, test } from "bun:test";
import {
  mergeBindingKeys,
  resolveProjectId,
  readSecretValue,
  buildProjectUpdate,
} from "../../../src/commands/secrets";
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
  // A stdin reader that records whether it was consumed. `--from-file` and
  // `--value` must never drain stdin — draining a pipe eagerly is the REO-97
  // §4a bug (`--from-file /dev/stdin` then reads empty).
  const countingReader = (value: string | null) => {
    let calls = 0;
    return {
      read: () => {
        calls += 1;
        return Promise.resolve(value);
      },
      calls: () => calls,
    };
  };

  test("prefers --value", async () => {
    const stdin = countingReader("ignored");
    expect(await readSecretValue({ value: "v" }, stdin.read)).toBe("v");
    expect(stdin.calls()).toBe(0);
  });

  test("falls back to stdin", async () => {
    expect(await readSecretValue({}, () => Promise.resolve("from-stdin\n"))).toBe("from-stdin");
  });

  test("reads --from-file and strips a trailing newline", async () => {
    const path = `/tmp/reoclo-secret-fromfile-${process.pid}.txt`;
    await Bun.write(path, "s3cret\n");
    const stdin = countingReader("ignored-stdin");
    expect(await readSecretValue({ fromFile: path }, stdin.read)).toBe("s3cret");
    // Regression: stdin must not be touched when --from-file is set, or a
    // `--from-file /dev/stdin` pipe is drained before the file read.
    expect(stdin.calls()).toBe(0);
  });

  test("throws when no source", async () => {
    let err: unknown;
    try {
      await readSecretValue({}, () => Promise.resolve(null));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});

describe("mergeBindingKeys", () => {
  test("adds a key to an explicit selection", () => {
    const out = mergeBindingKeys(
      [{ key: "A", env_name: null }],
      [{ key: "B", env_name: "RENAMED" }],
      [],
    );
    expect(out).toEqual([
      { key: "A", env_name: null },
      { key: "B", env_name: "RENAMED" },
    ]);
  });

  test("re-adding a selected key updates its rename", () => {
    const out = mergeBindingKeys(
      [{ key: "A", env_name: null }],
      [{ key: "A", env_name: "NEW_NAME" }],
      [],
    );
    expect(out).toEqual([{ key: "A", env_name: "NEW_NAME" }]);
  });

  test("removes a key from an explicit selection", () => {
    const out = mergeBindingKeys(
      [
        { key: "A", env_name: null },
        { key: "B", env_name: null },
      ],
      [],
      ["B"],
    );
    expect(out).toEqual([{ key: "A", env_name: null }]);
  });

  test("re-adding a selected key without a rename keeps the existing rename", () => {
    const out = mergeBindingKeys(
      [{ key: "A", env_name: "KEEP" }],
      [{ key: "A", env_name: null }],
      [],
    );
    expect(out).toEqual([{ key: "A", env_name: "KEEP" }]);
  });

  test("removing a key the same command adds throws when it was not already selected", () => {
    expect(() =>
      mergeBindingKeys([{ key: "A", env_name: null }], [{ key: "B", env_name: null }], ["B"]),
    ).toThrow(/not selected/);
  });

  test("removing a key that is not selected throws", () => {
    expect(() => mergeBindingKeys([{ key: "A", env_name: null }], [], ["MISSING"])).toThrow(
      /not selected/,
    );
  });

  test("adding to an all-keys binding throws", () => {
    expect(() => mergeBindingKeys([], [{ key: "A", env_name: null }], [])).toThrow(/every key/);
  });

  test("removing from an all-keys binding throws", () => {
    expect(() => mergeBindingKeys([], [], ["A"])).toThrow(/--key/);
  });

  test("removing the last key throws instead of widening to all keys", () => {
    expect(() => mergeBindingKeys([{ key: "A", env_name: null }], [], ["A"])).toThrow(/unbind/);
  });
});

describe("buildProjectUpdate", () => {
  test("renames", () => {
    expect(buildProjectUpdate({ name: "payments-production" })).toEqual({
      name: "payments-production",
    });
  });

  test("trims the name and rejects a blank one", () => {
    expect(buildProjectUpdate({ name: "  prod  " })).toEqual({ name: "prod" });
    expect(() => buildProjectUpdate({ name: "   " })).toThrow(/--name/);
  });

  test("sets a description", () => {
    expect(buildProjectUpdate({ description: "Stripe + Postgres" })).toEqual({
      description: "Stripe + Postgres",
    });
  });

  test("clears the description via --clear-description or an empty --description", () => {
    expect(buildProjectUpdate({ clearDescription: true })).toEqual({ description: null });
    expect(buildProjectUpdate({ description: "" })).toEqual({ description: null });
  });

  test("refuses a description and --clear-description that disagree", () => {
    expect(() => buildProjectUpdate({ description: "x", clearDescription: true })).toThrow(
      /not both/,
    );
  });

  test("refuses a no-op with the misuse exit code", () => {
    let err: (Error & { exitCode?: number }) | undefined;
    try {
      buildProjectUpdate({});
    } catch (e) {
      err = e as Error & { exitCode?: number };
    }
    expect(err?.message).toMatch(/nothing to update/);
    expect(err?.exitCode).toBe(2);
  });

  test("combines a rename with a description change", () => {
    expect(buildProjectUpdate({ name: "prod", description: "d" })).toEqual({
      name: "prod",
      description: "d",
    });
  });
});
