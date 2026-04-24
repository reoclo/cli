import { expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../../../src/client/bootstrap";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "boot-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  delete process.env.REOCLO_API_KEY;
  delete process.env.REOCLO_AUTOMATION_KEY;
  delete process.env.REOCLO_PROFILE;
});

test("bootstrap throws with exitCode 3 when no auth source", async () => {
  let caught: unknown = null;
  try {
    await bootstrap();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { exitCode?: number }).exitCode).toBe(3);
});

test("bootstrap honors --token flag", async () => {
  const ctx = await bootstrap({ token: "rk_t_flag" });
  expect(ctx.token).toBe("rk_t_flag");
  expect(ctx.tokenType).toBe("tenant");
  expect(ctx.api).toBe("https://api.reoclo.com");
});

test("bootstrap auto-detects automation key by prefix", async () => {
  const ctx = await bootstrap({ token: "rk_a_robot" });
  expect(ctx.tokenType).toBe("automation");
});
