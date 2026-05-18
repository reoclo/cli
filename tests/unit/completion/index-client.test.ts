import { describe, expect, test } from "bun:test";
import { parseIndexResponse } from "../../../src/completion/index-client";

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
    const slices = parseIndexResponse({
      resources: { servers: [{ id: "s1", value: "web", name: "Web" }] },
    });
    expect(slices.servers).toEqual([]);
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
