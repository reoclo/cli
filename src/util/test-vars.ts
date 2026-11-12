// src/util/test-vars.ts
import { badUsage } from "./parse-flag";

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_PREFIX = "REOCLO_";
const MAX_VALUE = 8192;
const MAX_VARIABLES = 100;

export interface VariableInput { key: string; value: string; secret: boolean }

function parsePair(raw: string, flag: string, secret: boolean): VariableInput {
  const eq = raw.indexOf("=");
  if (eq < 1) throw badUsage(`invalid ${flag} value (expected KEY=VALUE)`);
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (!KEY.test(key)) throw badUsage(`invalid variable name '${key}' (letters, digits and underscores, not starting with a digit)`);
  if (key.startsWith(RESERVED_PREFIX)) throw badUsage(`variable names starting with ${RESERVED_PREFIX} are reserved`);
  if (value.length > MAX_VALUE) throw badUsage(`variable '${key}' is longer than ${MAX_VALUE} characters`);
  return { key, value, secret };
}

/** Pool variables from --var and --secret values. A key may appear only once across both flags. */
export function parseVariables(vars: string[], secrets: string[]): VariableInput[] {
  const parsed = [
    ...vars.map((v) => parsePair(v, "--var", false)),
    ...secrets.map((v) => parsePair(v, "--secret", true)),
  ];
  const seen = new Set<string>();
  for (const { key } of parsed) {
    if (seen.has(key)) throw badUsage(`variable '${key}' is set more than once`);
    seen.add(key);
  }
  if (parsed.length > MAX_VARIABLES) throw badUsage(`at most ${MAX_VARIABLES} variables`);
  return parsed;
}

export function parseUnsetKeys(keys: string[], set: VariableInput[]): string[] {
  for (const key of keys) {
    if (!KEY.test(key)) throw badUsage(`invalid variable name '${key}'`);
    if (set.some((v) => v.key === key)) throw badUsage(`variable '${key}' is both set and unset`);
  }
  return keys;
}
