import { detectKeyType, apiPrefix } from "./routing";
import { mapHttpError, NetworkError, ReauthRequiredError } from "./errors";
import { updateProfileCapabilities as _updateProfileCapabilities } from "../config/store";

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  userAgent?: string;
  profile?: string;
  /** Override capability persistence (primarily for testing). */
  onCapabilities?: (profile: string, caps: string[]) => Promise<void>;
  /**
   * Called when a 401 is received and the profile uses OAuth. Receives the
   * access token that just failed (so the callback can detect another process
   * having already refreshed it). Should return the new token, or null if the
   * failure is transient (the original 401 then surfaces). When non-null, the
   * original request is retried exactly once with the new token. A thrown
   * {@link ReauthRequiredError} propagates to the caller unchanged (re-login
   * required); any other thrown error is swallowed into the original 401.
   */
  refreshToken?: (failedToken: string) => Promise<string | null>;
  /**
   * When true, adds `X-Reoclo-Source: mcp` to every request.
   * Set by the MCP server command so that API-side traffic attribution
   * works without affecting regular CLI usage.
   */
  mcpSource?: boolean;
}

export class HttpClient {
  private readonly prefix: string;
  private currentToken: string;

  constructor(private readonly opts: HttpClientOptions) {
    this.prefix = apiPrefix(detectKeyType(opts.token));
    this.currentToken = opts.token;
  }

  /**
   * Return a new HttpClient using the given token (re-derives the API prefix).
   * `refreshToken` is deliberately dropped: a short-lived session token (rss_)
   * that 401s should surface the failure, not silently refresh via the parent
   * (rca_) client's refresh closure.
   */
  withToken(token: string): HttpClient {
    return new HttpClient({ ...this.opts, token, refreshToken: undefined });
  }

  private url(path: string): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    return this.opts.baseUrl.replace(/\/$/, "") + this.prefix + p;
  }

  private headers(token?: string): HeadersInit {
    const h: Record<string, string> = {
      Authorization: `Bearer ${token ?? this.currentToken}`,
      "User-Agent": this.opts.userAgent ?? "reoclo-cli",
      Accept: "application/json",
    };
    if (this.opts.mcpSource) {
      h["X-Reoclo-Source"] = "mcp";
    }
    return h;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
  del<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  private async doFetch(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
    const ctrl = new AbortController();

    // Build the request BEFORE the try. url()/headers()/JSON.stringify are our
    // own code — if they throw that is a bug, not a network fault, and it must
    // not be relabelled as one below. Keeping them out here means the try wraps
    // fetch() and nothing else.
    const url = this.url(path);
    const init: RequestInit = {
      method,
      headers: {
        ...this.headers(token),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    };

    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      return await fetch(url, init);
    } catch (e) {
      // fetch() rejects only when the request never completed: DNS failure,
      // connection refused, TLS failure, or our own abort/timeout. An HTTP
      // error is NOT a rejection — it resolves with a non-ok Response and is
      // handled by parseResponse. So every rejection here is a transport
      // failure, whatever the runtime named it.
      //
      // Do NOT reintroduce a name check. The previous guard matched
      // `e.name === "TypeError"` (Node/undici's `TypeError: fetch failed`), but
      // this CLI runs on Bun, which throws `name: "Error"` with
      // `code: "ConnectionRefused"`. Every connection failure escaped unwrapped
      // and fell through to the generic exit 1, printing Bun's raw
      // "Unable to connect..." instead of ours. Matching on runtime-specific
      // error shapes is what rotted; the semantics of fetch() do not.
      if (e instanceof Error) {
        throw new NetworkError(`network error: ${e.message}`, e);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseResponse<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw mapHttpError(res.status, text || res.statusText, path);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const data: unknown = await res.json();
      return data as T;
    }
    const text: unknown = await res.text();
    return text as T;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(method, path, body);

    // On 401 with a refresh callback, attempt token refresh then retry once.
    if (res.status === 401 && this.opts.refreshToken) {
      let newToken: string | null = null;
      try {
        newToken = await this.opts.refreshToken(this.currentToken);
      } catch (e) {
        // A ReauthRequiredError is the callback's deliberate signal that
        // re-login is needed — surface it instead of the generic 401.
        if (e instanceof ReauthRequiredError) throw e;
        // Any other refresh error — fall through to the original 401.
      }
      if (newToken) {
        this.currentToken = newToken;
        const retryRes = await this.doFetch(method, path, body, newToken);
        return this.parseResponse<T>(retryRes, path);
      }
      // Refresh returned null or threw — surface the original 401
      return this.parseResponse<T>(res, path);
    }

    // On 403, attempt a one-shot capability refresh then retry (unless this IS the caps endpoint)
    if (res.status === 403 && path !== "/auth/me/capabilities") {
      try {
        const capsRes = await this.doFetch("GET", "/auth/me/capabilities");
        if (capsRes.ok) {
          const capsData = await capsRes.json() as { capabilities?: string[] };
          const caps = capsData.capabilities ?? [];
          if (this.opts.profile) {
            const persist = this.opts.onCapabilities ?? _updateProfileCapabilities;
            void persist(this.opts.profile, caps);
          }
        }
      } catch {
        // best-effort: ignore refresh errors, still retry
      }
      const retryRes = await this.doFetch(method, path, body);
      return this.parseResponse<T>(retryRes, path);
    }

    return this.parseResponse<T>(res, path);
  }
}
