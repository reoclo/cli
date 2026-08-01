import { test, expect } from "bun:test";
import { orgCurrentHint, orgCurrentOutput } from "../../../src/commands/org";

test("orgCurrentHint: none source explains how to select", () => {
  const hint = orgCurrentHint("none");
  expect(hint).toContain("--org");
  expect(hint).toContain("reoclo init");
});

test("orgCurrentHint: flag/env/reoclo report their source", () => {
  expect(orgCurrentHint("flag")).toContain("--org");
  expect(orgCurrentHint("env")).toContain("REOCLO_ORG");
  expect(orgCurrentHint("reoclo")).toContain(".reoclo");
});

test("orgCurrentOutput: none source writes only the hint to stderr, empty stdout", () => {
  const out = orgCurrentOutput("none", "", true);
  expect(out.stdout).toBe("");
  expect(out.stderr).toContain("no organization selected");
});

test("orgCurrentOutput: flag source with a TTY prints the org and the hint", () => {
  const out = orgCurrentOutput("flag", "acme", true);
  expect(out.stdout).toBe("acme\n");
  expect(out.stderr).toContain("--org");
});

test("orgCurrentOutput: flag source without a TTY prints the org but no hint", () => {
  const out = orgCurrentOutput("flag", "acme", false);
  expect(out.stdout).toBe("acme\n");
  expect(out.stderr).toBe("");
});
