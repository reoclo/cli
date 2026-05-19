import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { globalOutput, printMutation, resolveFormat } from "../../../src/ui/output";

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

describe("printMutation", () => {
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
