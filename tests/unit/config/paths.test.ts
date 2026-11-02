// tests/unit/config/paths.test.ts
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configDir, cacheDir, configFile, posixConfigDir } from "../../../src/config/paths";

let home: string;

beforeEach(() => {
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_CACHE_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  home = mkdtempSync(join(tmpdir(), "paths-home-"));
});
afterEach(() => {
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_CACHE_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
});

function writeConfigIn(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}");
}

test("configDir honors REOCLO_CONFIG_DIR", () => {
  process.env.REOCLO_CONFIG_DIR = "/tmp/reoclo-test";
  expect(configDir()).toBe("/tmp/reoclo-test");
});

test("configDir falls back to ~/.reoclo on POSIX", () => {
  expect(posixConfigDir(home, undefined)).toBe(join(home, ".reoclo"));
});

test("configDir honors XDG_CONFIG_HOME", () => {
  expect(posixConfigDir(home, join(home, "xdg"))).toBe(join(home, "xdg", "reoclo"));
});

test("without XDG_CONFIG_HOME, configDir follows a config that only exists in ~/.config/reoclo", () => {
  writeConfigIn(join(home, ".config", "reoclo"));
  expect(posixConfigDir(home, undefined)).toBe(join(home, ".config", "reoclo"));
});

test("without XDG_CONFIG_HOME, an existing ~/.reoclo config still wins", () => {
  writeConfigIn(join(home, ".config", "reoclo"));
  writeConfigIn(join(home, ".reoclo"));
  expect(posixConfigDir(home, undefined)).toBe(join(home, ".reoclo"));
});

test("cacheDir honors REOCLO_CACHE_DIR", () => {
  process.env.REOCLO_CACHE_DIR = "/tmp/reoclo-cache-test";
  expect(cacheDir()).toBe("/tmp/reoclo-cache-test");
});

test("configFile is configDir + config.json", () => {
  process.env.REOCLO_CONFIG_DIR = "/tmp/reoclo-test";
  expect(configFile()).toBe("/tmp/reoclo-test/config.json");
});
