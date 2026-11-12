import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerTestPools } from "../../../src/commands/test-pools";
import { registerTests } from "../../../src/commands/tests";
import { summarizeTest } from "../../../src/commands/tests-files";
import { parseUnsetKeys, parseVariables } from "../../../src/util/test-vars";

function group(name: string): Command {
  const program = new Command().name("reoclo");
  registerTestPools(program);
  registerTests(program);
  return program.commands.find((c) => c.name() === name)!;
}

const longs = (cmd: Command | undefined): string[] => (cmd?.options ?? []).map((o) => o.long ?? "");
const sub = (name: string, leaf: string): Command | undefined => group(name).commands.find((c) => c.name() === leaf);

async function failure(args: string[]): Promise<{ exitCode?: number; message: string }> {
  const program = new Command().name("reoclo");
  registerTestPools(program);
  registerTests(program);
  const error = (await program.parseAsync(["node", "reoclo", ...args]).catch((e: unknown) => e)) as { exitCode?: number; message: string };
  return error;
}

describe("command surface", () => {
  test("test-pools and tests register their subcommands", () => {
    expect(group("test-pools").commands.map((c) => c.name()).sort()).toEqual(["create", "edit", "get", "ls", "machines", "rm"]);
    expect(group("tests").commands.map((c) => c.name()).sort()).toEqual([
      "cancel", "disable", "enable", "init", "logs", "ls", "rerun", "run", "runs", "show", "validate",
    ]);
  });

  test("pool create and edit take the pool fields and variables, edit also unsets", () => {
    const shared = ["--credential", "--location", "--server-type", "--fallback-type", "--arch", "--image", "--stock-image", "--volume", "--max-machines", "--job-time-limit", "--budget", "--budget-currency", "--var", "--secret"];
    for (const leaf of ["create", "edit"]) for (const flag of shared) expect(longs(sub("test-pools", leaf))).toContain(flag);
    expect(longs(sub("test-pools", "edit"))).toContain("--unset-var");
    for (const flag of ["--slug", "--provider"]) expect(longs(sub("test-pools", "create"))).toContain(flag);
  });

  test("run takes the ref, sha and wait flags, and logs takes job and follow", () => {
    for (const flag of ["--repo", "--ref", "--sha", "--wait"]) expect(longs(sub("tests", "run"))).toContain(flag);
    for (const flag of ["--job", "--follow"]) expect(longs(sub("tests", "logs"))).toContain(flag);
    expect(longs(sub("tests", "ls"))).toContain("--refresh");
  });
});

describe("usage errors exit 2 before any request", () => {
  test("a bad test name, sha or state", async () => {
    expect((await failure(["tests", "run", "Bad_Name"])).exitCode).toBe(2);
    expect((await failure(["tests", "run", "unit", "--sha", "xyz"])).exitCode).toBe(2);
    expect((await failure(["tests", "runs", "--state", "sleeping"])).exitCode).toBe(2);
  });

  test("out-of-range pool numbers, a bad provider and an empty edit", async () => {
    const base = ["test-pools", "create", "--name", "p", "--credential", "c", "--location", "fsn1", "--server-type", "cx23"];
    expect((await failure([...base, "--max-machines", "51"])).exitCode).toBe(2);
    expect((await failure([...base, "--volume", "10"])).exitCode).toBe(2);
    expect((await failure([...base, "--provider", "gcp"])).exitCode).toBe(2);
    expect((await failure(["test-pools", "edit", "ci"])).message).toBe("no fields to update");
  });
});

describe("pool variables", () => {
  test("--var and --secret become typed inputs", () => {
    expect(parseVariables(["A=1", "B=x=y"], ["TOKEN=s3"])).toEqual([
      { key: "A", value: "1", secret: false },
      { key: "B", value: "x=y", secret: false },
      { key: "TOKEN", value: "s3", secret: true },
    ]);
  });

  test("a missing value separator, a bad or reserved name and a repeated key are usage errors", () => {
    for (const bad of [() => parseVariables(["NOVALUE"], []), () => parseVariables(["1A=x"], []), () => parseVariables(["REOCLO_X=1"], []), () => parseVariables(["A=1"], ["A=2"])]) {
      expect((() => { try { bad(); } catch (e) { return (e as { exitCode?: number }).exitCode; } return undefined; })()).toBe(2);
    }
  });

  test("a key cannot be set and unset together", () => {
    expect(() => parseUnsetKeys(["A"], parseVariables(["A=1"], []))).toThrow("both set and unset");
  });
});

test("summarizeTest names the pool, jobs, steps and triggers", () => {
  const summary = summarizeTest({
    name: "unit",
    pool: "ci",
    on: { manual: true, push: { branches: ["main"] } },
    jobs: [{ key: "a", image: "alpine", needs: [], steps: 2 }, { key: "b", image: "alpine", needs: ["a"], steps: 1 }],
    order: ["a", "b"],
  });
  expect(summary).toBe("pool ci, 2 jobs, 3 steps, on manual and push main");
});
