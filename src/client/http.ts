import { detectKeyType, apiPrefix } from "./routing";
import { mapHttpError, NetworkError } from "./errors";
import { updateProfileCapabilities } from "../config/store";

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  userAgent?: string;
  profile?: string;
}

export class HttpClient {
  private readonly prefix: string;

  constructor(private readonly opts: HttpClientOptions) {
    this.prefix = apiPrefix(detectKeyType(opts.token));
  }

  private url(path: string): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    return this.opts.baseUrl.replace(/\/$/, "") + this.prefix + p;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.opts.token}`,
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

  private async doFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      return await fetch(this.url(path), {
        method,
        headers: {
          ...this.headers(),
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

    // On 403, attempt a one-shot capability refresh then retry (unless this IS the caps endpoint)
    if (res.status === 403 && path !== "/auth/me/capabilities") {
      try {
        const capsRes = await this.doFetch("GET", "/auth/me/capabilities");
        if (capsRes.ok) {
          const capsData = await capsRes.json() as { capabilities?: string[] };
          const caps = capsData.capabilities ?? [];
          if (this.opts.profile) {
            void updateProfileCapabilities(this.opts.profile, caps);
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
