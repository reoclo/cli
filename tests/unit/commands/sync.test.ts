import { test, expect } from "bun:test";
import {
  formatEnvCapabilitiesReport,
  formatSyncLine,
  reportEnvCapabilities,
  syncProfileCapabilities,
} from "../../../src/commands/sync";
import type { HttpClient } from "../../../src/client/http";

test("formatSyncLine pluralizes the capability noun", () => {
  expect(formatSyncLine("default", 28)).toBe("Synced 28 capabilities for profile 'default'.");
  expect(formatSyncLine("default", 1)).toBe("Synced 1 capability for profile 'default'.");
  expect(formatSyncLine("staging", 0)).toBe("Synced 0 capabilities for profile 'staging'.");
});

test("syncProfileCapabilities fetches then persists the verb list under the profile", async () => {
  const persisted: { profile: string; caps: string[] }[] = [];
  const count = await syncProfileCapabilities({} as unknown as HttpClient, "default", {
    fetch: () => Promise.resolve(["container:read", "server:exec"]),
    persist: (profile, caps) => {
      persisted.push({ profile, caps });
      return Promise.resolve();
    },
  });
  expect(count).toBe(2);
  expect(persisted).toEqual([{ profile: "default", caps: ["container:read", "server:exec"] }]);
});

test("formatEnvCapabilitiesReport lists sorted verbs with a server-enforced note", () => {
  expect(formatEnvCapabilitiesReport(["server:exec", "container:read"])).toBe(
    "2 capabilities for this credential (enforced server-side; not cached locally for machine/automation credentials):\n" +
      "  container:read\n  server:exec",
  );
});

test("formatEnvCapabilitiesReport handles a single capability", () => {
  expect(formatEnvCapabilitiesReport(["container:read"])).toBe(
    "1 capability for this credential (enforced server-side; not cached locally for machine/automation credentials):\n" +
      "  container:read",
  );
});

test("formatEnvCapabilitiesReport handles no capabilities", () => {
  expect(formatEnvCapabilitiesReport([])).toBe(
    "This credential has no capabilities (enforced server-side; not cached locally).",
  );
});

test("reportEnvCapabilities fetches and formats without persisting", async () => {
  const out = await reportEnvCapabilities({} as unknown as HttpClient, {
    fetch: () => Promise.resolve(["server:exec", "container:read"]),
  });
  expect(out).toBe(formatEnvCapabilitiesReport(["server:exec", "container:read"]));
});
