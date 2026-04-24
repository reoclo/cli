// tests/unit/config/store.test.ts
import { expect, test, beforeEach } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  saveProfile,
  deleteProfile,
} from "../../../src/config/store";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-cfg-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
});

test("loadConfig returns empty when no file", async () => {
  const cfg = await loadConfig();
  expect(cfg.active_profile).toBe("default");
  expect(cfg.profiles).toEqual({});
});

test("saveProfile writes 0600 file", async () => {
  await saveProfile("default", {
    api_url: "x",
    token: "rk_t_1",
    tenant_id: "t",
    tenant_slug: "s",
    user_email: "e",
    token_type: "tenant",
    saved_at: "now",
  });
  const cfg = await loadConfig();
  expect(cfg.profiles.default?.token).toBe("rk_t_1");
  const mode = statSync(join(tmp, "config.json")).mode & 0o777;
  if (process.platform !== "win32") expect(mode).toBe(0o600);
});

test("deleteProfile removes entry", async () => {
  await saveProfile("a", {
    api_url: "x",
    token: "t1",
    tenant_id: "t",
    tenant_slug: "s",
    user_email: "e",
    token_type: "tenant",
    saved_at: "now",
  });
  await deleteProfile("a");
  const cfg = await loadConfig();
  expect(cfg.profiles.a).toBeUndefined();
});
