import { expect, test } from "bun:test";
import {
  detectKeyType,
  apiPrefix,
  commandSupportedBy,
  automationAllowedCommands,
  AUTOMATION_KEY_PREFIXES,
  MACHINE_TOKEN_PREFIX,
  isAutomationKeyShaped,
  isMachineTokenShaped,
} from "../../../src/client/routing";

test("rk_a_ → automation", () => {
  expect(detectKeyType("rk_a_xyz")).toBe("automation");
});

test("rca_ → automation", () => {
  expect(detectKeyType("rca_xyz")).toBe("automation");
});

test("OAuth bearer / unknown prefix → tenant routing (fallback)", () => {
  expect(detectKeyType("rk_foo")).toBe("tenant");
  expect(detectKeyType("eyJhbGciOiJSUzI1NiJ9.fake.jwt")).toBe("tenant");
});

test("apiPrefix automation", () => {
  expect(apiPrefix("automation")).toBe("/api/automation/v1");
});

test("apiPrefix tenant", () => {
  expect(apiPrefix("tenant")).toBe("/mcp");
});

import { describe } from "bun:test";

describe("commandSupportedBy", () => {
  test("tenant keys support everything", () => {
    expect(commandSupportedBy("apps deploy", "tenant")).toBe(true);
    expect(commandSupportedBy("containers restart", "tenant")).toBe(true);
    expect(commandSupportedBy("anything", "tenant")).toBe(true);
  });

  test("automation keys support apps deploy/restart, exec, and shell", () => {
    expect(commandSupportedBy("apps deploy", "automation")).toBe(true);
    expect(commandSupportedBy("apps restart", "automation")).toBe(true);
    expect(commandSupportedBy("exec", "automation")).toBe(true);
    expect(commandSupportedBy("shell", "automation")).toBe(true);
  });

  test("automation keys support the CI commands (checkout, registry login/logout)", () => {
    expect(commandSupportedBy("checkout", "automation")).toBe(true);
    expect(commandSupportedBy("registry login", "automation")).toBe(true);
    expect(commandSupportedBy("registry logout", "automation")).toBe(true);
  });

  // `secrets inject` uses the same /secrets/open-session + /secrets/resolve
  // automation endpoints as `run` — it must stay reachable under an
  // automation key, and the pair must not silently regress independently.
  test("automation keys support secrets inject, alongside run", () => {
    expect(commandSupportedBy("secrets inject", "automation")).toBe(true);
    expect(commandSupportedBy("run", "automation")).toBe(true);
  });

  test("automation keys reject secrets ls (not the injection path)", () => {
    expect(commandSupportedBy("secrets ls", "automation")).toBe(false);
  });

  test("automation keys reject containers restart (leaf-name collision fix)", () => {
    expect(commandSupportedBy("containers restart", "automation")).toBe(false);
  });

  test("automation keys reject unrelated commands", () => {
    expect(commandSupportedBy("servers ls", "automation")).toBe(false);
    expect(commandSupportedBy("schedule trigger", "automation")).toBe(false);
  });
});

describe("automationAllowedCommands", () => {
  // The rejection message in index.ts used to restate this list by hand, and it
  // drifted: it omitted `run`, so an operator was told the one command that
  // reads secrets with an automation key was unavailable to automation keys.
  // Pinned against an independent literal on purpose. Looping the returned
  // array back through commandSupportedBy would be `set.has(member)` for every
  // member, which is true by construction and passes even on an empty set.
  test("advertises exactly the accepted command set", () => {
    expect(automationAllowedCommands().slice().sort()).toEqual([
      "apps deploy",
      "apps restart",
      "checkout",
      "deploy sync",
      "exec",
      "registry login",
      "registry logout",
      "run",
      "secrets inject",
      "shell",
    ]);
  });

  test("includes run, the only command that reads secrets", () => {
    expect(automationAllowedCommands()).toContain("run");
  });

  test("returns a copy, so a caller cannot mutate the allowlist", () => {
    automationAllowedCommands().push("servers rm");
    expect(commandSupportedBy("servers rm", "automation")).toBe(false);
  });
});

test("rk_m_ tokens are the machine class", () => {
  expect(detectKeyType("rk_m_" + "a".repeat(32))).toBe("machine");
});
test("machine class routes to the tenant surface", () => {
  expect(apiPrefix("machine")).toBe("/mcp");
});
test("machine class may invoke any command", () => {
  expect(commandSupportedBy("containers restart", "machine")).toBe(true);
  expect(commandSupportedBy("run", "machine")).toBe(true);
});
test("automation class stays restricted", () => {
  expect(commandSupportedBy("containers restart", "automation")).toBe(false);
});

// AUTOMATION_KEY_PREFIXES / MACHINE_TOKEN_PREFIX are the single source of
// truth consumed by both detectKeyType (here) and assertEnvCredentialShape
// (bootstrap.ts). This pins that the exported declaration and detectKeyType's
// actual classification agree for every prefix, so the two can never drift
// silently apart — a new prefix added to one and not the other would fail
// this test.
test("AUTOMATION_KEY_PREFIXES and MACHINE_TOKEN_PREFIX match what detectKeyType actually classifies", () => {
  for (const prefix of AUTOMATION_KEY_PREFIXES) {
    expect(detectKeyType(`${prefix}x`)).toBe("automation");
    expect(isAutomationKeyShaped(`${prefix}x`)).toBe(true);
  }
  expect(detectKeyType(`${MACHINE_TOKEN_PREFIX}x`)).toBe("machine");
  expect(isMachineTokenShaped(`${MACHINE_TOKEN_PREFIX}x`)).toBe(true);

  // The negative direction matters too: a token shaped like neither prefix
  // must not be misclassified as automation or machine by either helper.
  expect(detectKeyType("oauth-bearer-token")).toBe("tenant");
  expect(isAutomationKeyShaped("oauth-bearer-token")).toBe(false);
  expect(isMachineTokenShaped("oauth-bearer-token")).toBe(false);
});
