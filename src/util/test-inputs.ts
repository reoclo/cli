// src/util/test-inputs.ts
import { badUsage } from "./parse-flag";

/** Inputs for a test run from repeated --input KEY=VALUE flags; the value is everything after the first '='. */
export function parseInputs(raw: string[]): Record<string, string> {
  const inputs = new Map<string, string>();
  for (const item of raw) {
    const eq = item.indexOf("=");
    if (eq < 1) throw badUsage("invalid --input value (expected KEY=VALUE)");
    const key = item.slice(0, eq);
    if (inputs.has(key)) throw badUsage(`input '${key}' is given more than once`);
    inputs.set(key, item.slice(eq + 1));
  }
  return Object.fromEntries(inputs);
}
