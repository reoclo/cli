import { test, expect } from "bun:test";
import { formatSyncLine, syncProfileCapabilities } from "../../../src/commands/sync";
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
