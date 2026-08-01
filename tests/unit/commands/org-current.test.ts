import { test, expect } from "bun:test";
import { orgCurrentHint } from "../../../src/commands/org";

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

test("orgCurrentHint: profile binding has no hint", () => {
  expect(orgCurrentHint("profile")).toBeNull();
});
