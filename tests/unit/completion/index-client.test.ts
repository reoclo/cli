import { describe, expect, test } from "bun:test";
import type { HttpClient } from "../../../src/client/http";
import { fetchCompletionIndex, parseIndexResponse } from "../../../src/completion/index-client";

describe("parseIndexResponse", () => {
  // The /completion-index endpoint already returns Entry-shaped objects
  // ({ id, value, name, desc }); parseIndexResponse validates and passes
  // them through — it does NOT re-derive them with the registry's toEntry.
  test("passes Entry-shaped slices through", () => {
    const slices = parseIndexResponse({
      resources: {
        servers: [{ id: "s1", value: "web", name: "Web", desc: "Web — ACTIVE" }],
        apps: [{ id: "a1", value: "api", name: "API", desc: "API" }],
      },
    });
    expect(slices.servers).toEqual([
      { id: "s1", value: "web", name: "Web", desc: "Web — ACTIVE" },
    ]);
    expect(slices.apps?.[0]!.value).toBe("api");
  });

  test("drops entries missing a required string field", () => {
    // missing desc
    expect(
      parseIndexResponse({ resources: { servers: [{ id: "s1", value: "web", name: "Web" }] } })
        .servers,
    ).toEqual([]);

    // missing name
    expect(
      parseIndexResponse({ resources: { servers: [{ id: "s1", value: "web", desc: "d" }] } })
        .servers,
    ).toEqual([]);

    // empty-string id
    expect(
      parseIndexResponse({ resources: { servers: [{ id: "", value: "web", name: "Web", desc: "d" }] } })
        .servers,
    ).toEqual([]);

    // empty-string value
    expect(
      parseIndexResponse({ resources: { servers: [{ id: "s1", value: "", name: "Web", desc: "d" }] } })
        .servers,
    ).toEqual([]);
  });

  test("ignores unknown resource keys", () => {
    const slices = parseIndexResponse({ resources: { bogus: [{}] } });
    expect(slices.servers).toBeUndefined();
  });

  test("returns {} on a malformed payload", () => {
    expect(parseIndexResponse(null)).toEqual({});
    expect(parseIndexResponse({ nope: 1 })).toEqual({});
  });
});

describe("fetchCompletionIndex", () => {
  test("requests the correct path and returns parsed slices", async () => {
    const validEntry = { id: "s1", value: "web", name: "Web", desc: "Web — ACTIVE" };
    const cannedPayload = { resources: { servers: [validEntry] } };
    let calledPath = "";

    const mockClient = {
      get: (p: string) => {
        calledPath = p;
        return Promise.resolve(cannedPayload);
      },
    } as unknown as HttpClient;

    const tenantId = "tenant-abc";
    const result = await fetchCompletionIndex(mockClient, tenantId);

    expect(calledPath).toBe(`/tenants/${tenantId}/completion-index`);
    expect(result.servers).toEqual([validEntry]);
  });
});
