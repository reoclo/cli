import { describe, expect, test } from "bun:test";
import { bulkCreateSecrets } from "../../../src/client/secrets";
import type { HttpClient } from "../../../src/client/http";

describe("bulkCreateSecrets", () => {
  test("posts {secrets} to the bulk endpoint and returns the created rows", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fake = {
      post: (path: string, body: unknown) => {
        calls.push({ path, body });
        return Promise.resolve([{ id: "s1", key: "A", current_version: 1 }]);
      },
    } as unknown as HttpClient;

    const out = await bulkCreateSecrets(fake, "t1", "p1", [
      { key: "A", value: "1" },
      { key: "B", value: "2", note: "n" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/tenants/t1/secret-projects/p1/secrets/bulk");
    expect(calls[0]!.body).toEqual({
      secrets: [
        { key: "A", value: "1" },
        { key: "B", value: "2", note: "n" },
      ],
    });
    expect(out).toEqual([{ id: "s1", key: "A", current_version: 1 }]);
  });
});
