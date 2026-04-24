// tests/unit/config/paths.test.ts
import { expect, test, beforeEach } from "bun:test";
import { configDir, cacheDir, configFile } from "../../../src/config/paths";

beforeEach(() => {
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
});

test("configDir honors REOCLO_CONFIG_DIR", () => {
  process.env.REOCLO_CONFIG_DIR = "/tmp/reoclo-test";
  expect(configDir()).toBe("/tmp/reoclo-test");
});

test("configDir falls back to ~/.reoclo on POSIX", () => {
  expect(configDir()).toMatch(/\.reoclo$/);
});

test("cacheDir honors REOCLO_CACHE_DIR", () => {
  process.env.REOCLO_CACHE_DIR = "/tmp/reoclo-cache-test";
  expect(cacheDir()).toBe("/tmp/reoclo-cache-test");
});

test("configFile is configDir + config.json", () => {
  process.env.REOCLO_CONFIG_DIR = "/tmp/reoclo-test";
  expect(configFile()).toBe("/tmp/reoclo-test/config.json");
});
