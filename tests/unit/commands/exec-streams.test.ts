import { afterEach, describe, expect, mock, test } from "bun:test";
import { HttpClient } from "../../../src/client/http";
import {
  STREAMS_EXEC_THRESHOLD_SECONDS,
  selectTenantExecClient,
} from "../../../src/commands/exec";

const PATH = "/tenants/t1/servers/s1/exec";
const API = "https://api.reoclo.com";
const STREAMS = "https://streams.reoclo.com";

describe("selectTenantExecClient", () => {
  const originalFetch = globalThis.fetch;
  let sent: { url: string; auth: string | null } | undefined;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sent = undefined;
  });

  async function exec(api: string, streamsUrl: string, timeoutSeconds: number) {
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      sent = { url, auth: new Headers(init.headers).get("authorization") };
      return Promise.resolve(Response.json({ exit_code: 0 }));
    }) as unknown as typeof fetch;
    const client = new HttpClient({ baseUrl: api, token: "rk_t_secret" });
    await selectTenantExecClient({ client, api, streamsUrl }, timeoutSeconds).post(PATH, {});
    return sent;
  }

  test("a long command goes to the streams host, without the /mcp prefix", async () => {
    const r = await exec(API, STREAMS, 600);
    expect(r?.url).toBe(`${STREAMS}${PATH}`);
  });

  test("the token is sent unchanged to the streams host", async () => {
    const r = await exec(API, STREAMS, 600);
    expect(r?.auth).toBe("Bearer rk_t_secret");
  });

  test("a command at the threshold stays on the API host", async () => {
    const r = await exec(API, STREAMS, STREAMS_EXEC_THRESHOLD_SECONDS);
    expect(r?.url).toBe(`${API}/mcp${PATH}`);
  });

  test("a command just over the threshold goes to the streams host", async () => {
    const r = await exec(API, STREAMS, STREAMS_EXEC_THRESHOLD_SECONDS + 1);
    expect(r?.url).toBe(`${STREAMS}${PATH}`);
  });

  test("with no separate streams host (dev, self-hosted) a long command stays on the API", async () => {
    const r = await exec("http://localhost:8000", "http://localhost:8000", 600);
    expect(r?.url).toBe(`http://localhost:8000/mcp${PATH}`);
  });

  test("a trailing slash does not make the streams URL look different", async () => {
    const r = await exec("https://api.example.com", "https://api.example.com/", 600);
    expect(r?.url).toBe(`https://api.example.com/mcp${PATH}`);
  });
});
