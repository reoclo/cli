import { describe, expect, test } from "bun:test";
import { assertPushTarget, parseBuildPlacement } from "../../../src/util/build-placement";

const POOL = "44444444-4444-4444-4444-444444444444";
const PUSH = { registry_credential_id: "33333333-3333-3333-3333-333333333333", repository: "ghcr.io/acme/web" };

function exitCodeOf(fn: () => void): number | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
  return undefined;
}

describe("parseBuildPlacement", () => {
  test("accepts target and pool:<uuid>, normalising case and whitespace", () => {
    expect(parseBuildPlacement(" TARGET ")).toBe("target");
    expect(parseBuildPlacement(`pool:${POOL.toUpperCase()}`)).toBe(`pool:${POOL}`);
  });

  test("rejects anything else with exit 2", () => {
    for (const bad of ["pool", "pool:", "pool:nope", "runtime", `${POOL}`]) {
      expect(exitCodeOf(() => parseBuildPlacement(bad))).toBe(2);
    }
  });
});

describe("assertPushTarget", () => {
  test("pool placement with a complete push target passes", () => {
    expect(() => assertPushTarget({ placement: `pool:${POOL}`, push_target: PUSH })).not.toThrow();
  });

  test("target placement without a push target passes", () => {
    expect(() => assertPushTarget({ placement: "target", push_target: null })).not.toThrow();
  });

  test("pool placement without a push target exits 2", () => {
    expect(exitCodeOf(() => assertPushTarget({ placement: `pool:${POOL}` }))).toBe(2);
  });

  test("a push target missing its repository exits 2 even under target placement", () => {
    const half = { registry_credential_id: PUSH.registry_credential_id };
    expect(exitCodeOf(() => assertPushTarget({ placement: "target", push_target: half }))).toBe(2);
  });
});
