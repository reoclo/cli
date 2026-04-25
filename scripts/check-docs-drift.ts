#!/usr/bin/env bun
// scripts/check-docs-drift.ts
//
// Verifies that every top-level CLI command has a corresponding doc page in
// the rbase docs site, and that each page mentions the command's invocation
// pattern. Run from the cli/ root with REOCLO_DOCS_DIR pointing at the
// commands/ folder in rbase, e.g.:
//
//   REOCLO_DOCS_DIR=/path/to/rbase/docs/src/content/docs/cli/commands \
//     bun run scripts/check-docs-drift.ts
//
// Exits non-zero if any command is missing a doc or the doc does not mention
// the command name in a code fence or inline backticks.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_DOCS = resolve(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "src",
  "content",
  "docs",
  "cli",
  "commands",
);

const DOCS_DIR = process.env.REOCLO_DOCS_DIR ?? DEFAULT_DOCS;

// Commands that must have a doc page. Keep alphabetised within sections.
// Add `apps logs`, `apps restart`, `exec`, `shell` once their CLI commands ship.
const COMMANDS = [
  "apps",
  "deployments",
  "domains",
  "env",
  "keyring",
  "login",
  "logout",
  "logs",
  "mcp",
  "profile",
  "servers",
  "upgrade",
  "whoami",
];

if (!existsSync(DOCS_DIR)) {
  console.error(`docs dir not found: ${DOCS_DIR}`);
  console.error(
    "set REOCLO_DOCS_DIR to the absolute path of rbase/docs/src/content/docs/cli/commands",
  );
  process.exit(1);
}

let bad = 0;
for (const cmd of COMMANDS) {
  const docPath = join(DOCS_DIR, `${cmd}.mdx`);
  if (!existsSync(docPath)) {
    console.error(`MISSING: ${docPath}`);
    bad++;
    continue;
  }

  const doc = readFileSync(docPath, "utf8");

  // The doc should mention the canonical invocation. We accept either
  // `reoclo <cmd>` in any code fence or inline backticks, since prose may
  // wrap the example in a paragraph.
  const needle = `reoclo ${cmd}`;
  if (!doc.includes(needle)) {
    console.error(`DRIFT: ${cmd} — '${needle}' not found in ${docPath}`);
    bad++;
  }
}

if (bad > 0) {
  console.error(`\n${bad} drift issue(s) detected`);
  process.exit(1);
}

console.log(`✓ ${COMMANDS.length} commands in sync with ${DOCS_DIR}`);
