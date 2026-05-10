import { detectKeyType, apiPrefix } from "./routing";
import { mapHttpError, NetworkError } from "./errors";
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
   * Called when a 401 is received and the profile uses OAuth.
   * Should attempt to refresh the access token and return the new token,
   * or return null if refresh fails. When non-null, the original request
   * is retried exactly once with the new token.
   */
  refreshToken?: () => Promise<string | null>;
}

export class HttpClient {
  private readonly prefix: string;
  private currentToken: string;

  constructor(private readonly opts: HttpClientOptions) {
    this.prefix = apiPrefix(detectKeyType(opts.token));
    this.currentToken = opts.token;
  }

  private url(path: string): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    return this.opts.baseUrl.replace(/\/$/, "") + this.prefix + p;
  }

  private headers(token?: string): HeadersInit {
    return {
      Authorization: `Bearer ${token ?? this.currentToken}`,
      "User-Agent": this.opts.userAgent ?? "reoclo-cli",
      Accept: "application/json",
    };
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
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      return await fetch(this.url(path), {
        method,
        headers: {
          ...this.headers(token),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "AbortError" || e.name === "TypeError")) {
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
        newToken = await this.opts.refreshToken();
      } catch {
        // refresh threw — fall through to the original 401
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
