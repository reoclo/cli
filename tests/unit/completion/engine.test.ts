import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getCompletionCandidates } from "../../../src/completion/engine";
import { withCompletion } from "../../../src/client/command-meta";
import { writeSlice } from "../../../src/completion/cache";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-eng-"));
  process.env.REOCLO_CACHE_DIR = tmp;
});
afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

function program(): Command {
  const p = new Command().name("reoclo");
  const servers = p.command("servers");
  withCompletion(servers.command("get <id>"), { args: [{ slot: 0, resource: "servers" }] });
  const logs = p.command("logs");
  withCompletion(
    logs.command("tail"),
    { flags: { "--server": "servers", "--source": { enum: ["container", "system"] } } },
  );
  return p;
}

function values(cands: { value: string }[]): string[] {
  return cands.map((c) => c.value);
}

describe("getCompletionCandidates", () => {
  test("completes subcommands", () => {
    expect(values(getCompletionCandidates(program(), [], ""))).toContain("servers");
  });

  test("completes a resource arg slot from the cache", () => {
    writeSlice("servers", [{ id: "1", value: "prod-web", name: "Prod", desc: "Prod — ACTIVE" }]);
    const cands = getCompletionCandidates(program(), ["servers", "get"], "");
    expect(values(cands)).toEqual(["prod-web"]);
    expect(cands[0]!.desc).toBe("Prod — ACTIVE");
  });

  test("prefix-filters resource candidates", () => {
    writeSlice("servers", [
      { id: "1", value: "prod-web", name: "p", desc: "" },
      { id: "2", value: "staging", name: "s", desc: "" },
    ]);
    const cands = getCompletionCandidates(program(), ["servers", "get"], "pro");
    expect(values(cands)).toEqual(["prod-web"]);
  });

  test("completes a flag's dynamic resource value", () => {
    writeSlice("servers", [{ id: "1", value: "web", name: "w", desc: "" }]);
    const cands = getCompletionCandidates(program(), ["logs", "tail", "--server"], "");
    expect(values(cands)).toEqual(["web"]);
  });

  test("completes a flag's static enum", () => {
    const cands = getCompletionCandidates(program(), ["logs", "tail", "--source"], "");
    expect(values(cands)).toEqual(["container", "system"]);
  });

  test("completes flag names after a dash", () => {
    const cands = getCompletionCandidates(program(), ["logs", "tail"], "--ser");
    expect(values(cands)).toContain("--server");
  });

  test("never throws on garbage input", () => {
    expect(() => getCompletionCandidates(program(), ["nonsense", "--"], "x")).not.toThrow();
  });
});
