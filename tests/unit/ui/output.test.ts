import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { globalOutput, printList, printMutation, resolveFormat } from "../../../src/ui/output";

test("resolveFormat respects explicit flag", () => {
  expect(resolveFormat("json")).toBe("json");
  expect(resolveFormat("yaml")).toBe("yaml");
  expect(resolveFormat("text")).toBe("text");
});

test("resolveFormat unknown flag falls through", () => {
  // In test runner, isTTY() returns false → defaults to json
  expect(resolveFormat("foo")).toBe("json");
  expect(resolveFormat(undefined)).toBe("json");
});

describe("globalOutput", () => {
  test("returns the --output flag value", () => {
    const p = new Command();
    p.option("-o, --output <fmt>", "fmt", "text");
    p.parse(["node", "x", "-o", "json"]);
    expect(globalOutput(p)).toBe("json");
  });

  test("returns undefined when output is not a string", () => {
    const p = new Command();
    expect(globalOutput(p)).toBeUndefined();
  });
});

describe("printMutation", () => {
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured: string;

  function makeProgram(outputFlag?: string): Command {
    const program = new Command().name("reoclo");
    program.option("-o, --output <fmt>", "output format");
    if (outputFlag !== undefined) {
      program.opts()["output"] = outputFlag;
    }
    return program;
  }

  beforeEach(() => {
    captured = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (chunk: unknown): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString();
      return true;
    };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = origWrite;
  });

  test("text mode writes only the textLine", () => {
    const program = makeProgram();
    const origTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    printMutation(program, { id: "abc-123" }, "✓ created: abc-123");
    process.stdout.isTTY = origTTY;
    expect(captured).toBe("✓ created: abc-123\n");
    expect(captured).not.toContain("id");
  });

  test("json mode writes the object as pretty JSON", () => {
    const program = makeProgram("json");
    printMutation(program, { id: "abc-123", name: "x" }, "✓ created: abc-123");
    expect(captured).toContain(`"id": "abc-123"`);
    expect(captured).toContain(`"name": "x"`);
    expect(captured).not.toContain("✓ created");
  });

  test("yaml mode writes key/value pairs", () => {
    const program = makeProgram("yaml");
    printMutation(program, { id: "abc-123", name: "x" }, "✓ created: abc-123");
    expect(captured).toContain("id: abc-123");
    expect(captured).toContain("name: x");
    expect(captured).not.toContain("✓ created");
  });
});

// Mirrors the ORIGIN column added to `apps ls` (src/commands/apps.ts) for the
// container_origin field returned by the platform API (linked vs. reoclo,
// optional because older API versions omit it entirely).
describe("printList ORIGIN column (apps ls container_origin)", () => {
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured: string;

  const columns: Array<{ key: string; label: string }> = [
    { key: "slug", label: "SLUG" },
    { key: "container_origin", label: "ORIGIN" },
  ];

  const rows: Array<Record<string, unknown>> = [
    { slug: "linked-app", container_origin: "linked" },
    { slug: "reoclo-app", container_origin: "reoclo" },
    { slug: "legacy-app" }, // field absent, e.g. an older API version
  ];

  beforeEach(() => {
    captured = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (chunk: unknown): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString();
      return true;
    };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = origWrite;
  });

  test("text mode prints linked, reoclo, and a blank cell for the absent field", () => {
    printList(rows, columns, "text");
    const lines = captured.trim().split("\n");
    expect(lines[0]).toContain("ORIGIN");
    expect(lines[1]?.trim().endsWith("linked")).toBe(true);
    expect(lines[2]?.trim().endsWith("reoclo")).toBe(true);
    // legacy-app has no container_origin: the row still renders, with an
    // empty ORIGIN cell rather than "undefined" or a thrown error.
    expect(lines[3]).toContain("legacy-app");
    expect(lines[3]).not.toContain("undefined");
  });

  test("json mode passes container_origin through untouched, and omits it when absent", () => {
    printList(rows, columns, "json");
    const parsed = captured
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]).toEqual({ slug: "linked-app", container_origin: "linked" });
    expect(parsed[1]).toEqual({ slug: "reoclo-app", container_origin: "reoclo" });
    expect(parsed[2]).toEqual({ slug: "legacy-app" });
    expect(Object.prototype.hasOwnProperty.call(parsed[2], "container_origin")).toBe(false);
  });

  test("yaml mode passes container_origin through untouched, and omits it when absent", () => {
    printList(rows, columns, "yaml");
    expect(captured).toContain("container_origin: linked");
    expect(captured).toContain("container_origin: reoclo");
    // legacy-app's block must not claim any container_origin value.
    const legacyBlock = captured.split("---\n")[3] ?? "";
    expect(legacyBlock).toContain("slug: legacy-app");
    expect(legacyBlock).not.toContain("container_origin");
  });
});
