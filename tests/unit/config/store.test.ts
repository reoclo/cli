// tests/unit/config/store.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  saveProfile,
  deleteProfile,
} from "../../../src/config/store";
import { withConfigDir } from "../../../src/config/paths";

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "reoclo-cfg-"));
}

test("loadConfig returns empty when no file", async () => {
  const tmp = makeTmp();
  const cfg = await withConfigDir(tmp, () => loadConfig());
  expect(cfg.active_profile).toBe("default");
  expect(cfg.profiles).toEqual({});
});

test("saveProfile writes 0600 file", async () => {
  const tmp = makeTmp();
  await withConfigDir(tmp, () =>
    saveProfile("default", {
      api_url: "x",
      token: "rk_t_1",
      tenant_id: "t",
      tenant_slug: "s",
      user_email: "e",
      token_type: "tenant",
      saved_at: "now",
    })
  );
  const cfg = await withConfigDir(tmp, () => loadConfig());
  expect(cfg.profiles.default?.token).toBe("rk_t_1");
  const mode = statSync(join(tmp, "config.json")).mode & 0o777;
  if (process.platform !== "win32") expect(mode).toBe(0o600);
});

test("deleteProfile removes entry", async () => {
  const tmp = makeTmp();
  await withConfigDir(tmp, () =>
    saveProfile("a", {
      api_url: "x",
      token: "t1",
      tenant_id: "t",
      tenant_slug: "s",
      user_email: "e",
      token_type: "tenant",
      saved_at: "now",
    })
  );
  await withConfigDir(tmp, () => deleteProfile("a"));
  const cfg = await withConfigDir(tmp, () => loadConfig());
  expect(cfg.profiles.a).toBeUndefined();
});
