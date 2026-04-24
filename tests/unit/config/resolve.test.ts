import { expect, test } from "bun:test";
import { resolveStore } from "../../../src/config/token-store";

test("--no-keyring always returns FileStore", async () => {
  const s = await resolveStore({ forbidKeyring: true });
  expect(s.kind).toBe("file");
});

test("CI env returns FileStore by default", async () => {
  process.env.CI = "true";
  try {
    const s = await resolveStore();
    expect(s.kind).toBe("file");
  } finally {
    delete process.env.CI;
  }
});
