import { describe, expect, test } from "bun:test";
import { DeploySyncClient, type FetchLike } from "../../../src/ci/deploy-client";

interface RecordedCall {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

/** Build an injectable fetch that records calls and replies via `respond`. */
function recorder(respond: (call: RecordedCall) => { status: number; body?: unknown }) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

const SESSION_BODY = {
  session_id: "sess-1",
  session_token: "rds_secret",
  expires_at: "2026-06-06T00:15:00Z",
  applications: [],
  unmatched: [],
};

describe("DeploySyncClient.createSession", () => {
  test("posts to ROOT /external-deploy/session (no /api/automation/v1) with the rca_* bearer", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 201, body: SESSION_BODY }));
    const client = new DeploySyncClient("https://api.reoclo.com/", "rca_key", fetchImpl);

    const res = await client.createSession({ container_names: ["web"] });

    expect(res.session_token).toBe("rds_secret");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.reoclo.com/external-deploy/session");
    expect(calls[0]?.auth).toBe("Bearer rca_key");
    expect(calls[0]?.body).toEqual({ container_names: ["web"] });
    expect(client.currentSessionId).toBe("sess-1");
  });

  test("403 (missing scope) throws exit-4 and surfaces the server detail", async () => {
    const { fetchImpl } = recorder(() => ({
      status: 403,
      body: { detail: "API key lacks `external_deploy` scope" },
    }));
    const client = new DeploySyncClient("https://api.reoclo.com", "rca_key", fetchImpl);

    try {
      await client.createSession({ container_names: ["web"] });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(4);
      expect((e as Error).message).toContain("external_deploy");
    }
  });

  test("400 (no match) throws exit-1", async () => {
    const { fetchImpl } = recorder(() => ({ status: 400, body: { detail: "none matched" } }));
    const client = new DeploySyncClient("https://api.reoclo.com", "rca_key", fetchImpl);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's .rejects matcher types as void, not a Promise; await is harmless
    await expect(client.createSession({ container_names: ["x"] })).rejects.toMatchObject({
      exitCode: 1,
    });
  });
});

describe("DeploySyncClient.sync", () => {
  async function withSession(respond: (c: RecordedCall) => { status: number; body?: unknown }) {
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.endsWith("/external-deploy/session")) return { status: 201, body: SESSION_BODY };
      return respond(call);
    });
    const client = new DeploySyncClient("https://api.reoclo.com", "rca_key", fetchImpl);
    await client.createSession({ container_names: ["web"] });
    return { calls, client };
  }

  test("uses the rds_* session token (not the rca_* key) against ROOT /external-deploy/sync", async () => {
    const syncBody = { session_id: "sess-1", results: [], errors: [] };
    const { calls, client } = await withSession(() => ({ status: 200, body: syncBody }));

    const res = await client.sync({ deployments: [{ container_name: "web", container_port: 80 }] });

    expect(res).toEqual(syncBody);
    const syncCall = calls.find((c) => c.url.endsWith("/external-deploy/sync"));
    expect(syncCall?.url).toBe("https://api.reoclo.com/external-deploy/sync");
    expect(syncCall?.auth).toBe("Bearer rds_secret");
  });

  test("409 (all-conflict) RETURNS the structured body — does not throw", async () => {
    const body = {
      session_id: "sess-1",
      results: [
        {
          application_id: "a1",
          container_name: "web",
          status: "conflict",
          signature_hash: "h",
          synced_fqdns: [],
          reason: "owned by another signature",
        },
      ],
      errors: [],
    };
    const { client } = await withSession(() => ({ status: 409, body }));
    const res = await client.sync({ deployments: [{ container_name: "web", container_port: 80 }] });
    expect(res.results[0]?.status).toBe("conflict");
  });

  test("500 throws exit-1", async () => {
    const { client } = await withSession(() => ({ status: 500, body: { detail: "boom" } }));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's .rejects matcher types as void, not a Promise; await is harmless
    await expect(
      client.sync({ deployments: [{ container_name: "web", container_port: 80 }] }),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  test("sync without a session throws", async () => {
    const { fetchImpl } = recorder(() => ({ status: 200, body: {} }));
    const client = new DeploySyncClient("https://api.reoclo.com", "rca_key", fetchImpl);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's .rejects matcher types as void, not a Promise; await is harmless
    await expect(client.sync({ deployments: [] })).rejects.toThrow(/session/);
  });
});

describe("DeploySyncClient.revokeSession", () => {
  test("DELETEs /external-deploy/session/{id} with the rds_* token", async () => {
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.endsWith("/external-deploy/session")) return { status: 201, body: SESSION_BODY };
      return { status: 204 };
    });
    const client = new DeploySyncClient("https://api.reoclo.com", "rca_key", fetchImpl);
    await client.createSession({ container_names: ["web"] });

    await client.revokeSession();

    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("https://api.reoclo.com/external-deploy/session/sess-1");
    expect(del?.auth).toBe("Bearer rds_secret");
  });

  test("is a no-op before a session exists (never calls fetch)", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response(null, { status: 204 });
    };
    const client = new DeploySyncClient("https://api.reoclo.com", "rca_key", fetchImpl);
    await client.revokeSession();
    expect(called).toBe(false);
  });

  test("swallows fetch errors — cleanup must not throw", async () => {
    const fetchImpl: FetchLike = async (input) => {
      if (input.endsWith("/external-deploy/session")) {
        return new Response(JSON.stringify(SESSION_BODY), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("network down");
    };
    const client = new DeploySyncClient("https://api.reoclo.com", "rca_key", fetchImpl);
    await client.createSession({ container_names: ["web"] });
    await client.revokeSession(); // must not throw despite the DELETE failing
    expect(client.currentSessionId).toBe("sess-1");
  });
});
