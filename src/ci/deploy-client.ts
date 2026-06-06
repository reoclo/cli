// External-deploy client for `reoclo deploy sync`.
//
// Unlike the rest of the automation surface, the external-deploy endpoints are
// ROOT-mounted (`/external-deploy/*`), not under `/api/automation/v1`. The shared
// HttpClient unconditionally prepends that prefix for `rca_*` keys, so this
// client deliberately bypasses it and fetches `ctx.api` directly — mirroring the
// github-action-deploy-sync `client.ts`.
//
// Two-token flow:
//   1. `rca_*` automation key  → POST /external-deploy/session  → `rds_*` token
//   2. `rds_*` session token   → POST /external-deploy/sync
//   3. `rds_*` session token   → DELETE /external-deploy/session/{id} (self-revoke)

export interface DeploySessionCreateRequest {
  container_names: string[];
  workflow_run_id?: string;
  commit_sha?: string;
}

export interface DeploySessionApplicationRead {
  id: string;
  linked_container_name: string;
  container_port: number | null;
  bound_fqdns: string[];
}

export interface DeploySessionCreateResponse {
  session_id: string;
  session_token: string;
  expires_at: string;
  applications: DeploySessionApplicationRead[];
  unmatched: string[];
}

export interface DeploySyncRequestItem {
  container_name: string;
  container_port: number;
  image_tag?: string;
  force?: boolean;
}

export interface DeploySyncRequest {
  deployments: DeploySyncRequestItem[];
}

export type DeploySyncStatus = "synced" | "noop" | "conflict" | "drift_recovered";

export interface DeploySyncResponseItem {
  application_id: string;
  container_name: string;
  status: DeploySyncStatus;
  signature_hash: string;
  synced_fqdns: string[];
  reason: string | null;
}

export interface DeploySyncResponse {
  session_id: string;
  results: DeploySyncResponseItem[];
  errors: Array<{ container_name: string; reason: string }>;
}

/** Injectable for tests; defaults to the global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function exitErr(message: string, code: number): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = code;
  return e;
}

/** Pull a useful message out of a JSON error body (`{detail}`), else stringify. */
function describe(body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    return typeof d === "string" ? d : JSON.stringify(d);
  }
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

export class DeploySyncClient {
  private readonly baseUrl: string;
  private sessionToken: string | null = null;
  private sessionId: string | null = null;

  constructor(
    api: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly timeoutMs = 60_000,
  ) {
    this.baseUrl = api.replace(/\/+$/, "");
  }

  /** Session id once a session has been created (for revoke / diagnostics). */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  private async send(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json };
  }

  async createSession(req: DeploySessionCreateRequest): Promise<DeploySessionCreateResponse> {
    const { status, json } = await this.send("POST", "/external-deploy/session", this.apiKey, req);
    if (status !== 201) {
      // 403 = missing `external_deploy` scope → exit 4 (same as "wrong key type").
      throw exitErr(`create deploy session failed (${status}): ${describe(json)}`, status === 403 ? 4 : 1);
    }
    const r = json as DeploySessionCreateResponse;
    this.sessionToken = r.session_token;
    this.sessionId = r.session_id;
    return r;
  }

  async sync(req: DeploySyncRequest): Promise<DeploySyncResponse> {
    if (!this.sessionToken) {
      throw exitErr("no deploy session — call createSession first", 1);
    }
    const { status, json } = await this.send("POST", "/external-deploy/sync", this.sessionToken, req);
    // 200 (mixed/ok) and 409 (all-conflict) both carry the structured body; the
    // conflict/exit decision is made by the caller from that body. Anything else
    // is a hard failure.
    if (status !== 200 && status !== 409) {
      throw exitErr(`deploy sync failed (${status}): ${describe(json)}`, 1);
    }
    return json as DeploySyncResponse;
  }

  /** Best-effort self-revocation. Never throws — cleanup must not mask a result. */
  async revokeSession(): Promise<void> {
    if (!this.sessionToken || !this.sessionId) return;
    try {
      await this.send("DELETE", `/external-deploy/session/${this.sessionId}`, this.sessionToken);
    } catch {
      // swallow — revocation is best-effort cleanup
    }
  }
}
