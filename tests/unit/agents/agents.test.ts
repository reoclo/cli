// tests/unit/agents/agents.test.ts
//
// Registering the reoclo MCP server in Claude Code (~/.claude.json) and Codex
// (~/.codex/config.toml). Every test runs against a temp home passed in as the
// AgentEnv, so the real agent configs are never read or written.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installAgents, listAgents, uninstallAgents, type AgentEnv } from "../../../src/agents/agents";

let home: string;
let env: AgentEnv;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "reoclo-agents-")));
  env = { home, codexHome: join(home, ".codex"), binDirs: [] };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const claudeFile = (): string => join(home, ".claude.json");
const codexFile = (): string => join(home, ".codex", "config.toml");
const write = (path: string, text: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string): string => readFileSync(path, "utf8");
const jsonOf = (text: string): unknown => JSON.parse(text);

const CLAUDE_EXISTING = `{
  "numStartups": 12345678901234567890,
  "note": "caf\\u00e9",
  "mcpServers": {
    "other": {
      "command": "node",
      "args": ["x.js"]
    }
  },
  "tail": true
}
`;

const CLAUDE_ENTRY_AT_4 = `    "reoclo": {
      "type": "stdio",
      "command": "/bin/reoclo",
      "args": [
        "mcp"
      ]
    }`;

const CODEX_EXISTING = `# my codex settings
model = "gpt-5"   # keep this comment

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`;

const CODEX_ENTRY = `[mcp_servers.reoclo]
command = "/bin/reoclo"
args = ["mcp"]
`;

// ---------- detection ----------

test("an empty machine has neither agent", () => {
  const agents = listAgents(env);
  expect(agents.map((a) => [a.id, a.installed, a.registered])).toEqual([
    ["claude-code", false, false],
    ["codex", false, false],
  ]);
});

test("an agent is found by its config file, its config directory or its binary", () => {
  write(claudeFile(), "{}\n");
  mkdirSync(join(home, ".codex"));
  expect(listAgents(env).map((a) => a.installed)).toEqual([true, true]);

  rmSync(claudeFile());
  rmSync(join(home, ".codex"), { recursive: true });
  const bin = join(home, "opt", "bin");
  write(join(bin, "codex"), "");
  const found = listAgents({ ...env, binDirs: [bin] });
  expect(found.map((a) => a.installed)).toEqual([false, true]);
});

test("codex follows the configured codex home", () => {
  const codexHome = join(home, "elsewhere");
  write(join(codexHome, "config.toml"), CODEX_ENTRY);
  const codex = listAgents({ ...env, codexHome }).find((a) => a.id === "codex");
  expect(codex?.config_path).toBe(join(codexHome, "config.toml"));
  expect(codex?.registered).toBe(true);
});

test("registration and its command are read from both formats", () => {
  write(claudeFile(), `{"mcpServers":{"reoclo":{"command":"/a/reoclo","args":["mcp"]}}}`);
  write(codexFile(), `[mcp_servers.reoclo]\ncommand = "/b/reoclo"\nargs = ["mcp"]\n`);
  const [claude, codex] = listAgents(env);
  expect([claude?.registered, claude?.command]).toEqual([true, "/a/reoclo"]);
  expect([codex?.registered, codex?.command]).toEqual([true, "/b/reoclo"]);
});

test("an unparsable config is reported, not thrown", () => {
  write(claudeFile(), `{ "mcpServers": `);
  const claude = listAgents(env)[0];
  expect(claude?.installed).toBe(true);
  expect(claude?.registered).toBeNull();
  expect(claude?.error).toContain(claudeFile());
});

// ---------- install: Claude Code ----------

test("claude install creates the config when only the agent directory exists", () => {
  mkdirSync(join(home, ".claude"));
  const [change] = installAgents("claude-code", env, "/bin/reoclo");
  expect(change?.action).toBe("installed");
  expect(change?.backup_path).toBeNull();
  expect(JSON.parse(read(claudeFile()))).toEqual({
    mcpServers: { reoclo: { type: "stdio", command: "/bin/reoclo", args: ["mcp"] } },
  });
});

test("claude install adds one server and leaves every other byte alone", () => {
  write(claudeFile(), CLAUDE_EXISTING);
  installAgents("claude-code", env, "/bin/reoclo");
  const expected = CLAUDE_EXISTING.replace(
    `"args": ["x.js"]\n    }\n  },`,
    `"args": ["x.js"]\n    },\n${CLAUDE_ENTRY_AT_4}\n  },`,
  );
  expect(read(claudeFile())).toBe(expected);
});

test("claude install adds mcpServers when the file has none", () => {
  write(claudeFile(), `{\n  "numStartups": 3,\n  "tail": true\n}\n`);
  installAgents("claude-code", env, "/bin/reoclo");
  expect(read(claudeFile())).toBe(
    `{\n  "numStartups": 3,\n  "tail": true,\n  "mcpServers": {\n${CLAUDE_ENTRY_AT_4}\n  }\n}\n`,
  );
});

test("claude install into an empty object", () => {
  write(claudeFile(), "{}");
  installAgents("claude-code", env, "/bin/reoclo");
  expect(JSON.parse(read(claudeFile()))).toEqual({
    mcpServers: { reoclo: { type: "stdio", command: "/bin/reoclo", args: ["mcp"] } },
  });
});

test("claude install is idempotent and leaves no backup when nothing changes", () => {
  mkdirSync(join(home, ".claude"));
  installAgents("claude-code", env, "/bin/reoclo");
  const first = read(claudeFile());
  const [again] = installAgents("claude-code", env, "/bin/reoclo");
  expect(again?.action).toBe("unchanged");
  expect(read(claudeFile())).toBe(first);
  expect(existsSync(`${claudeFile()}.reoclo-backup`)).toBe(false);
});

test("claude install updates an existing reoclo entry in place", () => {
  const before = `{
  "mcpServers": {
    "other": { "command": "node" },
    "reoclo": {
      "command": "/old/reoclo",
      "args": ["mcp"],
      "env": { "A": "1" }
    }
  }
}
`;
  write(claudeFile(), before);
  const [change] = installAgents("claude-code", env, "/bin/reoclo");
  expect(change?.action).toBe("updated");
  const after = read(claudeFile());
  expect(after.startsWith(`{\n  "mcpServers": {\n    "other": { "command": "node" },\n    "reoclo": `)).toBe(true);
  expect(after.endsWith(`\n  }\n}\n`)).toBe(true);
  expect(jsonOf(after)).toMatchObject({
    mcpServers: { reoclo: { command: "/bin/reoclo", args: ["mcp"], env: { A: "1" }, type: "stdio" } },
  });
});

test("the first change backs the file up and later changes keep that first backup", () => {
  write(claudeFile(), CLAUDE_EXISTING);
  const [first] = installAgents("claude-code", env, "/bin/reoclo");
  expect(first?.backup_path).toBe(`${claudeFile()}.reoclo-backup`);
  expect(read(`${claudeFile()}.reoclo-backup`)).toBe(CLAUDE_EXISTING);
  installAgents("claude-code", env, "/other/reoclo");
  expect(read(`${claudeFile()}.reoclo-backup`)).toBe(CLAUDE_EXISTING);
});

test("claude install writes through a symlinked config and keeps the link", () => {
  const target = join(home, "dotfiles", "claude.json");
  write(target, CLAUDE_EXISTING);
  symlinkSync(target, claudeFile());
  installAgents("claude-code", env, "/bin/reoclo");
  expect(lstatSync(claudeFile()).isSymbolicLink()).toBe(true);
  expect(jsonOf(read(target))).toMatchObject({ mcpServers: { reoclo: { command: "/bin/reoclo" } } });
});

// ---------- install: Codex ----------

test("codex install creates the config file", () => {
  mkdirSync(join(home, ".codex"));
  const [change] = installAgents("codex", env, "/bin/reoclo");
  expect(change?.action).toBe("installed");
  expect(read(codexFile())).toBe(CODEX_ENTRY);
});

test("codex install appends one table and keeps the comments and other servers", () => {
  write(codexFile(), CODEX_EXISTING);
  installAgents("codex", env, "/bin/reoclo");
  expect(read(codexFile())).toBe(`${CODEX_EXISTING}\n${CODEX_ENTRY}`);
});

test("codex install is idempotent", () => {
  write(codexFile(), CODEX_EXISTING);
  installAgents("codex", env, "/bin/reoclo");
  const first = read(codexFile());
  const [again] = installAgents("codex", env, "/bin/reoclo");
  expect(again?.action).toBe("unchanged");
  expect(read(codexFile())).toBe(first);
});

const CODEX_WITH_REOCLO = `# top
model = "gpt-5"

[mcp_servers.reoclo]
# the reoclo server
command = "/old/reoclo"
args = ["mcp", "--org", "acme"]
startup_timeout_sec = 30

[mcp_servers.reoclo.env]
REOCLO_ORG = "acme"

[other]
x = 1
`;

test("codex install updates command and args in place and keeps the rest of the table", () => {
  write(codexFile(), CODEX_WITH_REOCLO);
  const [change] = installAgents("codex", env, "/bin/reoclo");
  expect(change?.action).toBe("updated");
  expect(read(codexFile())).toBe(
    CODEX_WITH_REOCLO.replace(`command = "/old/reoclo"\nargs = ["mcp", "--org", "acme"]`, `command = "/bin/reoclo"\nargs = ["mcp"]`),
  );
});

// ---------- selection ----------

test("all installs into the agents that are found and reports the rest", () => {
  mkdirSync(join(home, ".claude"));
  const changes = installAgents("all", env, "/bin/reoclo");
  expect(changes.map((c) => [c.agent, c.action])).toEqual([
    ["claude-code", "installed"],
    ["codex", "not-found"],
  ]);
  expect(existsSync(codexFile())).toBe(false);
});

test("naming an agent that is not on the machine writes nothing", () => {
  const [change] = installAgents("codex", env, "/bin/reoclo");
  expect(change?.action).toBe("not-found");
  expect(change?.problem?.kind).toBe("missing-agent");
  expect(existsSync(join(home, ".codex"))).toBe(false);
});

// ---------- failures ----------

test("an unparsable JSON config is never overwritten", () => {
  const broken = `{ "mcpServers": { "other": `;
  write(claudeFile(), broken);
  const [change] = installAgents("claude-code", env, "/bin/reoclo");
  expect(change?.action).toBe("failed");
  expect(change?.problem?.kind).toBe("unparsable");
  expect(read(claudeFile())).toBe(broken);
  expect(readdirSync(home).sort()).toEqual([".claude.json"]);
});

test("an unparsable TOML config is never overwritten", () => {
  const broken = `[mcp_servers.other\ncommand = \n`;
  write(codexFile(), broken);
  const [change] = installAgents("codex", env, "/bin/reoclo");
  expect(change?.action).toBe("failed");
  expect(change?.problem?.kind).toBe("unparsable");
  expect(read(codexFile())).toBe(broken);
});

test("an unwritable config is reported and left as it was", () => {
  if (process.getuid?.() === 0) return;
  write(claudeFile(), CLAUDE_EXISTING);
  chmodSync(claudeFile(), 0o444);
  const [change] = installAgents("claude-code", env, "/bin/reoclo");
  expect(change?.action).toBe("failed");
  expect(change?.problem?.kind).toBe("unwritable");
  expect(read(claudeFile())).toBe(CLAUDE_EXISTING);
  expect(existsSync(`${claudeFile()}.reoclo-backup`)).toBe(false);
});

// ---------- uninstall ----------

test("claude uninstall removes only the reoclo entry and restores the original bytes", () => {
  write(claudeFile(), CLAUDE_EXISTING);
  installAgents("claude-code", env, "/bin/reoclo");
  const [change] = uninstallAgents("claude-code", env);
  expect(change?.action).toBe("removed");
  expect(read(claudeFile())).toBe(CLAUDE_EXISTING);
});

test("claude uninstall of the only server leaves an empty mcpServers", () => {
  write(claudeFile(), `{\n  "mcpServers": {\n${CLAUDE_ENTRY_AT_4}\n  }\n}\n`);
  uninstallAgents("claude-code", env);
  expect(read(claudeFile())).toBe(`{\n  "mcpServers": {}\n}\n`);
});

test("codex uninstall removes the table and its sub-tables only", () => {
  write(codexFile(), CODEX_WITH_REOCLO);
  const [change] = uninstallAgents("codex", env);
  expect(change?.action).toBe("removed");
  expect(read(codexFile())).toBe(`# top\nmodel = "gpt-5"\n\n[other]\nx = 1\n`);
});

test("codex uninstall after install restores the original bytes", () => {
  write(codexFile(), CODEX_EXISTING);
  installAgents("codex", env, "/bin/reoclo");
  uninstallAgents("codex", env);
  expect(read(codexFile())).toBe(CODEX_EXISTING);
});

test("uninstall with nothing registered changes nothing", () => {
  write(claudeFile(), CLAUDE_EXISTING);
  write(codexFile(), CODEX_EXISTING);
  const changes = uninstallAgents("all", env);
  expect(changes.map((c) => c.action)).toEqual(["unchanged", "unchanged"]);
  expect(read(claudeFile())).toBe(CLAUDE_EXISTING);
  expect(read(codexFile())).toBe(CODEX_EXISTING);
  expect(existsSync(`${claudeFile()}.reoclo-backup`)).toBe(false);
});

test("uninstall refuses an unparsable config", () => {
  write(codexFile(), `[oops\n`);
  const [change] = uninstallAgents("codex", env);
  expect(change?.action).toBe("failed");
  expect(read(codexFile())).toBe(`[oops\n`);
});
