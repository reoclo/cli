import { expect, test } from "bun:test";
import { detectKeyringBinary } from "../../../src/config/keyring/detect";

test("detectKeyringBinary returns null for unknown platform", async () => {
  const r = await detectKeyringBinary("freebsd");
  expect(r).toBeNull();
});
