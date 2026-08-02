import { test, expect } from "bun:test";
import { configAdvisories } from "../../../src/config/config-advisory";

const DAY = 24 * 60 * 60 * 1000;

test("plain project config → outdated advisory", () => {
  const r = configAdvisories({
    projectConfig: { org: "acme" }, latestSkillsSha: undefined,
    now: DAY, throttleMs: DAY,
  });
  expect(r.lines.join("")).toContain("project config is out of date");
  expect(r.configNotifiedAt).toBeDefined();
});

test("skills sha mismatch → skills advisory", () => {
  const r = configAdvisories({
    projectConfig: { org: "acme", version: 1, skills: { ref: "main", sha: "old" } },
    latestSkillsSha: "new", now: DAY, throttleMs: DAY,
  });
  expect(r.lines.join("")).toContain("skills update available");
});

test("no .reoclo → no advisories", () => {
  const r = configAdvisories({ projectConfig: null, latestSkillsSha: "x", now: DAY, throttleMs: DAY });
  expect(r.lines).toEqual([]);
});

test("recently notified within throttle → suppressed", () => {
  const r = configAdvisories({
    projectConfig: { org: "acme" }, latestSkillsSha: undefined,
    now: DAY, throttleMs: DAY, configNotifiedAt: new Date(DAY - 1000).toISOString(),
  });
  expect(r.lines).toEqual([]);
});
