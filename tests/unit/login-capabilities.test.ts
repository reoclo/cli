import { describe, expect, test, mock } from "bun:test";
import { buildProfileWithCapabilities } from "../../src/commands/login";

describe("buildProfileWithCapabilities", () => {
  test("fetches capabilities and includes them in the profile", async () => {
    const fakeClient = {
      get: mock((path: string) => {
        if (path === "/auth/me/capabilities") {
          return Promise.resolve({
            grants: [
              { verb: "container:read", scope_kind: "*", scope_id: null },
              { verb: "container:exec", scope_kind: "*", scope_id: null },
            ],
          });
        }
        throw new Error(`unexpected path: ${path}`);
      }),
    };
    const profile = await buildProfileWithCapabilities(
      fakeClient as unknown as Parameters<typeof buildProfileWithCapabilities>[0],
      "https://api.example.com",
      "tenant",
      { tenant_id: "t1", tenant_slug: "tenant-1", email: "u@x.com" },
    );
    expect(profile.capabilities).toEqual(["container:read", "container:exec"]);
    expect(profile.capabilities_fetched_at).toBeDefined();
    expect(typeof profile.capabilities_fetched_at).toBe("string");
  });

  test("falls back to empty list if /auth/me/capabilities fails", async () => {
    const fakeClient = {
      get: mock(() => Promise.reject(new Error("network"))),
    };
    const profile = await buildProfileWithCapabilities(
      fakeClient as unknown as Parameters<typeof buildProfileWithCapabilities>[0],
      "https://api.example.com",
      "tenant",
      { tenant_id: "t1", tenant_slug: "tenant-1", email: "u@x.com" },
    );
    expect(profile.capabilities).toEqual([]);
  });
});
