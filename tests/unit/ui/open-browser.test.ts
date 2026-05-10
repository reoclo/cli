import { afterEach, beforeEach, expect, test } from "bun:test";
import { openBrowser } from "../../../src/ui/open-browser";

const TEST_URL = "https://example.test/oauth";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    CI: process.env["CI"],
    SSH_CONNECTION: process.env["SSH_CONNECTION"],
    SSH_CLIENT: process.env["SSH_CLIENT"],
    SSH_TTY: process.env["SSH_TTY"],
    REOCLO_NO_BROWSER: process.env["REOCLO_NO_BROWSER"],
    DISPLAY: process.env["DISPLAY"],
    WAYLAND_DISPLAY: process.env["WAYLAND_DISPLAY"],
  };
  delete process.env["CI"];
  delete process.env["SSH_CONNECTION"];
  delete process.env["SSH_CLIENT"];
  delete process.env["SSH_TTY"];
  delete process.env["REOCLO_NO_BROWSER"];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("skips when REOCLO_NO_BROWSER is set", () => {
  process.env["REOCLO_NO_BROWSER"] = "1";
  expect(openBrowser(TEST_URL)).toBe(false);
});

test("skips when running over SSH", () => {
  process.env["SSH_CONNECTION"] = "10.0.0.1 22 10.0.0.2 51234";
  expect(openBrowser(TEST_URL)).toBe(false);
});

test("skips inside CI", () => {
  process.env["CI"] = "true";
  expect(openBrowser(TEST_URL)).toBe(false);
});
