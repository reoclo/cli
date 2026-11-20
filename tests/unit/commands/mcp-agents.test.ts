// tests/unit/commands/mcp-agents.test.ts
//
// `reoclo mcp agents|install|uninstall` as the desktop app calls them: arguments
// in, `-o json` out. The agent locations come from a temp home, never the real one.
import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { registerMcpAgents } from "../../../src/commands/mcp-agents";
import type { AgentEnv } from "../../../src/agents/agents";
import { AgentConfigError } from "../../../src/agents/errors";
import { rejectionOf } from "../../helpers/rejection";

let home: string;
let env: AgentEnv;
let exe: string;
let stdout: Mock<typeof process.stdout.write>;
let out: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "reoclo-mcp-agents-")));
  env = { home, codexHome: join(home, ".codex"), binDirs: [] };
  mkdirSync(join(home, "bin"));
  exe = join(home, "bin", "reoclo");
  writeFileSync(exe, "");
  out = "";
  stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
});

afterEach(() => {
  stdout.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const program = new Command().option("-o, --output <fmt>", "output format", "text").exitOverride();
  registerMcpAgents(program.command("mcp"), () => env);
  await program.parseAsync(["node", "reoclo", ...args]);
}

const claudeFile = (): string => join(home, ".claude.json");
const codexFile = (): string => join(home, ".codex", "config.toml");

function seedBoth(): void {
  writeFileSync(claudeFile(), `{"mcpServers":{"reoclo":{"command":"${exe}","args":["mcp"]}}}`);
  mkdirSync(join(home, ".codex"));
  writeFileSync(codexFile(), `[mcp_servers.reoclo]\ncommand = "${exe}"\nargs = ["mcp"]\n`);
}

test("agents -o json lists every supported agent with its state", async () => {
  writeFileSync(claudeFile(), `{"mcpServers":{"reoclo":{"command":"${exe}","args":["mcp"]}}}`);
  await run("-o", "json", "mcp", "agents");
  expect(JSON.parse(out)).toEqual({
    agents: [
      {
        id: "claude-code",
        name: "Claude Code",
        installed: true,
        config_path: claudeFile(),
        registered: true,
        command: exe,
        error: null,
      },
      {
        id: "codex",
        name: "Codex",
        installed: false,
        config_path: codexFile(),
        registered: false,
        command: null,
        error: null,
      },
    ],
  });
});

test("agents prints one readable line per agent", async () => {
  writeFileSync(claudeFile(), "{}");
  await run("-o", "text", "mcp", "agents");
  const lines = out.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("Claude Code");
  expect(lines[0]).toContain("not registered");
  expect(lines[1]).toContain("Codex");
  expect(lines[1]).toContain("not found");
});

test("install -o json reports what it wrote", async () => {
  writeFileSync(claudeFile(), "{}\n");
  await run("-o", "json", "mcp", "install", "--agent", "claude-code", "--command", exe);
  expect(JSON.parse(out)).toEqual({
    results: [
      {
        agent: "claude-code",
        name: "Claude Code",
        action: "installed",
        config_path: claudeFile(),
        backup_path: `${claudeFile()}.reoclo-backup`,
        command: exe,
        error: null,
      },
    ],
  });
  expect(JSON.parse(readFileSync(claudeFile(), "utf8"))).toMatchObject({ mcpServers: { reoclo: { command: exe } } });
});

test("install for an agent that is not on the machine fails and writes nothing", async () => {
  const err = await rejectionOf(run("-o", "json", "mcp", "install", "--agent", "codex", "--command", exe));
  expect(err).toBeInstanceOf(AgentConfigError);
  expect((err as AgentConfigError).kind).toBe("missing-agent");
  expect(() => readFileSync(codexFile())).toThrow();
});

test("install all with one broken config still registers the other agent, then fails", async () => {
  writeFileSync(claudeFile(), `{ "broken": `);
  mkdirSync(join(home, ".codex"));
  const err = await rejectionOf(run("-o", "json", "mcp", "install", "--agent", "all", "--command", exe));
  expect((err as AgentConfigError).kind).toBe("unparsable");
  expect(JSON.parse(out)).toMatchObject({
    results: [
      { agent: "claude-code", action: "failed", error: { kind: "unparsable" } },
      { agent: "codex", action: "installed", error: null },
    ],
  });
  expect(readFileSync(claudeFile(), "utf8")).toBe(`{ "broken": `);
  expect(readFileSync(codexFile(), "utf8")).toContain("[mcp_servers.reoclo]");
});

test("install with a --command that does not exist fails before touching any config", async () => {
  writeFileSync(claudeFile(), "{}\n");
  const err = await rejectionOf(run("mcp", "install", "--agent", "all", "--command", join(home, "missing")));
  expect((err as AgentConfigError).kind).toBe("invalid-command");
  expect(readFileSync(claudeFile(), "utf8")).toBe("{}\n");
});

test("uninstall removes the entry from every agent", async () => {
  seedBoth();
  await run("-o", "json", "mcp", "uninstall", "--agent", "all");
  expect(JSON.parse(out)).toMatchObject({
    results: [
      { agent: "claude-code", action: "removed" },
      { agent: "codex", action: "removed" },
    ],
  });
  expect(JSON.parse(readFileSync(claudeFile(), "utf8"))).toEqual({ mcpServers: {} });
  expect(readFileSync(codexFile(), "utf8")).toBe("");
});
