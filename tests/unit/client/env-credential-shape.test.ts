import { expect, test } from "bun:test";
import { assertEnvCredentialShape } from "../../../src/client/bootstrap";

test("rk_m_ in REOCLO_MACHINE_TOKEN passes", () => {
  expect(() => assertEnvCredentialShape("rk_m_x", undefined)).not.toThrow();
});
test("rca_, rss_ and legacy rk_a_ in REOCLO_AUTOMATION_KEY pass", () => {
  for (const t of ["rca_x", "rss_x", "rk_a_x"])
    expect(() => assertEnvCredentialShape(undefined, t)).not.toThrow();
});
test("rk_m_ in REOCLO_AUTOMATION_KEY exits 2 and names the right variable", () => {
  try {
    assertEnvCredentialShape(undefined, "rk_m_x");
    throw new Error("did not throw");
  } catch (e) {
    expect((e as { exitCode?: number }).exitCode).toBe(2);
    expect(String(e)).toContain("REOCLO_MACHINE_TOKEN");
  }
});
test("rca_ in REOCLO_MACHINE_TOKEN exits 2 and names the right variable", () => {
  try {
    assertEnvCredentialShape("rca_x", undefined);
    throw new Error("did not throw");
  } catch (e) {
    expect((e as { exitCode?: number }).exitCode).toBe(2);
    expect(String(e)).toContain("REOCLO_AUTOMATION_KEY");
  }
});
test("an empty variable is treated as absent, not as a malformed token", () => {
  // Consistent with bootstrap's own precedence chain, where `else if (envMachine)`
  // also skips "" and falls through to the next credential source.
  expect(() => assertEnvCredentialShape("", "")).not.toThrow();
});
