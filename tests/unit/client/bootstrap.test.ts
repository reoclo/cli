import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap, defaultStreamsUrl } from "../../../src/client/bootstrap";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "boot-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  delete process.env.REOCLO_API_KEY;
  delete process.env.REOCLO_AUTOMATION_KEY;
  delete process.env.REOCLO_PROFILE;
  delete process.env.REOCLO_API_URL;
  delete process.env.REOCLO_STREAMS_URL;
});
afterEach(() => {
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_API_URL;
  delete process.env.REOCLO_STREAMS_URL;
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

test("defaultStreamsUrl maps prod api → streams.reoclo.com", () => {
  expect(defaultStreamsUrl("https://api.reoclo.com")).toBe("https://streams.reoclo.com");
  expect(defaultStreamsUrl("https://api.reoclo.com/")).toBe("https://streams.reoclo.com");
});

test("defaultStreamsUrl falls through to the api host for dev/staging/localhost", () => {
  expect(defaultStreamsUrl("http://localhost:8000")).toBe("http://localhost:8000");
  expect(defaultStreamsUrl("https://api.staging.reoclo.com")).toBe(
    "https://api.staging.reoclo.com",
  );
  expect(defaultStreamsUrl("http://localhost:8000/")).toBe("http://localhost:8000");
});

test("bootstrap streamsUrl defaults to streams.reoclo.com for prod api", async () => {
  const ctx = await bootstrap({ token: "rk_t_test" });
  expect(ctx.api).toBe("https://api.reoclo.com");
  expect(ctx.streamsUrl).toBe("https://streams.reoclo.com");
});

test("bootstrap streamsUrl falls back to api when api is dev/localhost", async () => {
  const ctx = await bootstrap({ token: "rk_t_test", api: "http://localhost:8000" });
  expect(ctx.api).toBe("http://localhost:8000");
  expect(ctx.streamsUrl).toBe("http://localhost:8000");
});

test("REOCLO_STREAMS_URL env overrides the default", async () => {
  process.env.REOCLO_STREAMS_URL = "http://localhost:9000";
  const ctx = await bootstrap({ token: "rk_t_test" });
  expect(ctx.streamsUrl).toBe("http://localhost:9000");
});

test("--streams flag wins over env and defaults", async () => {
  process.env.REOCLO_STREAMS_URL = "http://localhost:9000";
  const ctx = await bootstrap({ token: "rk_t_test", streams: "http://localhost:9001" });
  expect(ctx.streamsUrl).toBe("http://localhost:9001");
});
