import { test, expect } from "bun:test";
import { fetchCapabilities, hasCapability } from "../../../src/client/capabilities";
import type { HttpClient } from "../../../src/client/http";

function clientReturning(body: unknown): HttpClient {
  return { get: () => Promise.resolve(body) } as unknown as HttpClient;
}

test("fetchCapabilities flattens response.capabilities[].verb to a verb list (REO-167)", async () => {
  const caps = await fetchCapabilities(
    clientReturning({
      capabilities: [
        { verb: "container:read", scope_kind: "*", scope_id: null },
        { verb: "server:exec", scope_kind: "*", scope_id: null },
      ],
    }),
  );
  expect(caps).toEqual(["container:read", "server:exec"]);
});

test("fetchCapabilities tolerates a missing or empty capabilities field", async () => {
  expect(await fetchCapabilities(clientReturning({}))).toEqual([]);
  expect(await fetchCapabilities(clientReturning({ capabilities: [] }))).toEqual([]);
});

test("hasCapability checks membership and treats undefined as no-capability", () => {
  expect(hasCapability(["container:read"], "container:read")).toBe(true);
  expect(hasCapability(["container:read"], "server:exec")).toBe(false);
  expect(hasCapability(undefined, "server:exec")).toBe(false);
});
