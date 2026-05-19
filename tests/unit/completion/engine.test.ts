import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getCompletionCandidates } from "../../../src/completion/engine";
import { withCompletion } from "../../../src/client/command-meta";
import { writeSlice, writeEnvKeys } from "../../../src/completion/cache";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-eng-"));
  process.env.REOCLO_CACHE_DIR = tmp;
});
afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  delete process.env.REOCLO_CONFIG_DIR;
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
    expect(getCompletionCandidates(program(), ["nonsense", "--"], "x")).toEqual([]);
    expect(getCompletionCandidates(program(), ["\x00", null as unknown as string], "")).toEqual([]);
  });

  // --- new tests ---

  test("flagsOf merge: returns both Commander-registered and spec-only flags", () => {
    const p = new Command().name("reoclo");
    const cmd = p.command("deploy");
    cmd.option("--foo <v>", "a commander option");
    withCompletion(cmd, { flags: { "--bar": "servers" } });
    const cands = getCompletionCandidates(p, ["deploy"], "--");
    const names = values(cands);
    expect(names).toContain("--foo");
    expect(names).toContain("--bar");
    // each appears exactly once
    expect(names.filter((n) => n === "--foo")).toHaveLength(1);
    expect(names.filter((n) => n === "--bar")).toHaveLength(1);
  });

  test("profiles: completes profile names from config.json", () => {
    const configDir = mkdtempSync(join(tmpdir(), "reoclo-cfg-"));
    process.env.REOCLO_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ active_profile: "prod", profiles: { prod: {}, staging: {} } }),
      "utf8",
    );
    const p = new Command().name("reoclo");
    withCompletion(p.command("switch <profile>"), { args: [{ slot: 0, resource: "profiles" }] });
    const cands = getCompletionCandidates(p, ["switch"], "");
    expect(values(cands).sort()).toEqual(["prod", "staging"]);
    rmSync(configDir, { recursive: true, force: true });
  });

  test("envKeys without --app: returns []", () => {
    const p = new Command().name("reoclo");
    const envGet = p.command("env:get <key>");
    envGet.option("--app <id>", "app id");
    withCompletion(envGet, { args: [{ slot: 0, resource: "envKeys" }] });
    const cands = getCompletionCandidates(p, ["env:get"], "");
    expect(cands).toEqual([]);
  });

  test("envKeys with --app: returns cached keys for that app", () => {
    writeEnvKeys("app-xyz", ["DATABASE_URL", "SECRET_KEY"]);
    const p = new Command().name("reoclo");
    // Register --app as a known value-taking option so walk() skips it and
    // its value, leaving the key slot as positional 0.
    const envGet = p.command("env:get <key>");
    envGet.option("--app <id>", "app id");
    withCompletion(envGet, { args: [{ slot: 0, resource: "envKeys" }] });
    const cands = getCompletionCandidates(p, ["env:get", "--app", "app-xyz"], "");
    expect(values(cands).sort()).toEqual(["DATABASE_URL", "SECRET_KEY"]);
  });

  test("tunnel-style: merges subcommand names and resource arg candidates at slot 0", () => {
    writeSlice("servers", [{ id: "1", value: "prod-web", name: "p", desc: "" }]);
    const p = new Command().name("reoclo");
    const tunnel = p.command("tunnel");
    withCompletion(tunnel, { args: [{ slot: 0, resource: "servers" }] });
    tunnel.command("ls");
    tunnel.command("describe");
    tunnel.command("close");
    const cands = getCompletionCandidates(p, ["tunnel"], "");
    const names = values(cands);
    // subcommand names
    expect(names).toContain("ls");
    expect(names).toContain("describe");
    expect(names).toContain("close");
    // resource arg at slot 0
    expect(names).toContain("prod-web");
  });

  test("hidden commands are filtered from subcommand completion", () => {
    const p = new Command().name("reoclo");
    p.command("visible");
    // Register the internal hidden commands (they are excluded by the HIDDEN set
    // in the engine regardless of Commander's hidden flag).
    p.command("__complete", { hidden: true });
    p.command("__refresh-completion", { hidden: true });
    const cands = getCompletionCandidates(p, [], "");
    const names = values(cands);
    expect(names).toContain("visible");
    expect(names).not.toContain("__complete");
    expect(names).not.toContain("__refresh-completion");
  });
});
