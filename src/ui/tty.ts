// src/ui/tty.ts
export function isTTY(stream: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stream.isTTY);
}

/** Variables coding agents set in the shells they run commands in. Their shells are pseudo-terminals,
 *  so stdin looks like a person at a keyboard, but nobody is there to answer a prompt. */
const AGENT_VARIABLES = [
  "AI_AGENT",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "GEMINI_CLI",
  "QWEN_CODE",
  "OPENCODE",
  "PI_CODING_AGENT",
  "CURSOR_AGENT",
  "COPILOT_AGENT_SESSION_ID",
  "COPILOT_CLI",
  "CLINE_ACTIVE",
  "ROO_ACTIVE",
  "AUGMENT_AGENT",
  "KILO",
  "CRUSH",
  "GOOSE_TERMINAL",
  "AMP_CURRENT_THREAD_ID",
  "WINDSURF_CASCADE_TERMINAL",
] as const;

const OFF = new Set(["", "0", "false", "no", "off"]);
const isSet = (value: string | undefined): boolean => value !== undefined && !OFF.has(value.trim().toLowerCase());

/** Why no one can answer a prompt here, or null when a person can. */
export function noInputReason(env: NodeJS.ProcessEnv = process.env, stdinIsTTY = Boolean(process.stdin.isTTY)): string | null {
  if (isSet(env["REOCLO_NO_INPUT"])) return "REOCLO_NO_INPUT is set";
  if (!stdinIsTTY) return "stdin is not a terminal";
  if (isSet(env["CI"])) return "CI is set";
  const agent = AGENT_VARIABLES.find((name) => isSet(env[name]));
  return agent === undefined ? null : `a coding agent runs this command (${agent} is set)`;
}

export function noColor(): boolean {
  return Boolean(process.env.NO_COLOR ?? process.env.REOCLO_NO_COLOR);
}
