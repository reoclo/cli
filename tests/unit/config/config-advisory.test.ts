import { test, expect } from "bun:test";
import { configAdvisories } from "../../../src/config/config-advisory";

const DAY = 24 * 60 * 60 * 1000;

test("plain project config → outdated advisory", () => {
  const r = configAdvisories({
    projectConfig: { org: "acme" },
    now: DAY, throttleMs: DAY,
  });
  expect(r.lines.join("")).toContain("project config is out of date");
  expect(r.configNotifiedAt).toBeDefined();
});

test("a current .reoclo with a skills block from an older init → no advisory", () => {
  const r = configAdvisories({
    projectConfig: { org: "acme", version: 1, skills: { ref: "main", sha: "old" } },
    now: DAY, throttleMs: DAY,
  });
  expect(r.lines).toEqual([]);
});

test("no .reoclo → no advisories", () => {
  const r = configAdvisories({ projectConfig: null, now: DAY, throttleMs: DAY });
  expect(r.lines).toEqual([]);
});

test("recently notified within throttle → suppressed", () => {
  const r = configAdvisories({
    projectConfig: { org: "acme" },
    now: DAY, throttleMs: DAY, configNotifiedAt: new Date(DAY - 1000).toISOString(),
  });
  expect(r.lines).toEqual([]);
});
