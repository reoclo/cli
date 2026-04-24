import { detectKeyType, apiPrefix } from "./routing";
import { mapHttpError, NetworkError } from "./errors";

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  userAgent?: string;
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(this.url(path), {
        method,
        headers: {
          ...this.headers(),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
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
    } catch (e) {
      if (e instanceof Error && (e.name === "AbortError" || e.name === "TypeError")) {
        throw new NetworkError(`network error: ${e.message}`, e);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
