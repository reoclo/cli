// src/lib/program-name.ts
import { basename } from "node:path";

/**
 * Detect how the user invoked the CLI. We accept `rc` as a short alias for
 * `reoclo`; everything else resolves to "reoclo" so the tool has a stable
 * name in help output and error messages.
 *
 * IMPORTANT: read `process.argv0`, NOT `process.argv[0]`. `process.argv0` is
 * the ORIGINAL argv[0] the OS passed at exec time. In a `bun build --compile`
 * standalone binary Bun overwrites `process.argv[0]` with the literal string
 * "bun" (and `process.execPath` resolves the `rc` symlink back to the real
 * `reoclo` path), so neither can tell `rc` from `reoclo`. Only `process.argv0`
 * preserves the real invocation — e.g. "rc", "./rc", "/usr/local/bin/rc" —
 * which is what lets us honour the alias.
 */
export function detectProgramName(argv0: string = process.argv0 || ""): "rc" | "reoclo" {
  const name = basename(argv0).toLowerCase().replace(/\.exe$/, "");
  return name === "rc" ? "rc" : "reoclo";
}
