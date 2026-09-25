// src/client/transport.ts
//
// One HTTP exchange with a bounded retry for connections that fail before any
// response arrives. Shared by HttpClient and the tenant_switch mint.
//
// Why the retry exists: on some networks, Bun's TLS client gets its connection
// reset by Cloudflare's edge before any response when the request carries a
// long bearer token (field report 2026-09-24, Airtel Nigeria via Cloudflare
// LOS: Bun 1.3.11 failed ~75% of requests, 1.4.2 ~10%; curl and Node never).
// Each failure is per-connection, so a fresh connection usually gets through.
// Only requests that are safe to repeat may retry; callers decide with
// `retries`.

import { NetworkError } from "./errors";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  /** Extra attempts after the first, used only when the connection fails
   *  before any response. Pass 0 for a request that is not safe to repeat. */
  retries: number;
  /** Timeout for EACH attempt, not the whole call. A timeout is never retried. */
  timeoutMs?: number;
  /** Receives --verbose lines. Undefined keeps the transport silent. */
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Pause before retry n (index n-1). Short on purpose: a fresh connection
 *  right away usually works, the pause only spaces out a burst. */
const BACKOFF_MS = [250, 750];

const NETWORK_HINT = "Check your network connection";
const VERBOSE_HINT = "run with --verbose to see each request";

/** Statuses whose Response must have a null body (the constructor throws otherwise). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Send `init` to `url`, retrying up to `opts.retries` times when the connection
 * fails before the full response arrives. Each attempt reads the whole body, so
 * the timeout covers it and a connection that dies mid-body is handled like one
 * that dies before the headers; the returned Response is fully buffered.
 *
 * Each attempt gets its own AbortController for its timeout, combined with any
 * `init.signal`. A caller abort ends the call at once: its error is rethrown
 * as-is, never wrapped and never retried.
 */
export async function sendWithRetry(
  url: string,
  init: RequestInit,
  opts: TransportOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = (init.method ?? "GET").toUpperCase();
  const attempts = opts.retries + 1;
  const log = opts.log;

  for (let attempt = 1; ; attempt++) {
    if (log) logRequest(log, method, url, init);
    const ctrl = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    // Set once the headers arrive: a failure after that happened mid-body.
    let status: number | undefined;
    try {
      const res = await fetchImpl(url, { ...init, signal });
      status = res.status;
      const body =
        NULL_BODY_STATUSES.has(res.status) || method === "HEAD" ? null : await res.arrayBuffer();
      log?.(`< ${res.status} ${method} ${url} (${Date.now() - started} ms)`);
      // fetch() already decoded the body: these two described the encoded one.
      const headers = new Headers(res.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(body, { status: res.status, statusText: res.statusText, headers });
    } catch (e) {
      // Disarm first: this attempt is over, and its timer must not fire
      // during the backoff sleep below.
      clearTimeout(timer);
      // The caller cancelled: not a network failure, not ours to retry.
      if (init.signal?.aborted) throw e;
      // fetch() and the body read reject only on a transport failure (DNS,
      // connect, TLS, a reset, or our own timeout). HTTP errors resolve and
      // are returned above. Match on that, not on runtime-specific error
      // names (Bun and Node disagree).
      if (!(e instanceof Error)) throw e;
      const timedOut = ctrl.signal.aborted;
      const reason = failureReason(e, timedOut, timeoutMs, status);
      const retrying = !timedOut && attempt < attempts;
      log?.(
        `! ${method} ${url} failed: ${reason} (attempt ${attempt} of ${attempts}${retrying ? ", retrying" : ""})`,
      );
      if (!retrying) {
        // A success answer to a request that is not safe to repeat means the
        // server may have applied it: say so, because running it again could
        // apply it twice. A caller that allowed retries has declared the
        // request safe to repeat, so that warning would only mislead.
        const safeToRepeat = opts.retries > 0 || SAFE_TO_REPEAT.has(method);
        const hint =
          status !== undefined && status >= 200 && status < 300 && !safeToRepeat
            ? "The server answered, so it may have applied the request. Check the result before you run it again."
            : hintFor(attempt, Boolean(log), status !== undefined);
        throw new NetworkError(`network error: ${method} ${url}: ${reason}`, e, hint);
      }
      await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Methods that are safe to send again after a connection failure. Anything
 *  else may already have acted on the server. */
export const SAFE_TO_REPEAT: ReadonlySet<string> = new Set(["GET", "HEAD"]);

function failureReason(
  e: Error,
  timedOut: boolean,
  timeoutMs: number,
  status: number | undefined,
): string {
  const afterHeaders = status !== undefined ? ` (status ${status})` : "";
  if (timedOut) {
    return status !== undefined
      ? `timed out after ${formatDuration(timeoutMs)} while reading the response${afterHeaders}`
      : `timed out after ${formatDuration(timeoutMs)} with no response`;
  }
  if (status !== undefined) {
    return `the connection closed before the full response arrived${afterHeaders}`;
  }
  return describeTransportFailure(e);
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms} ms`;
}

/** What to do next. Skips "--verbose" when the user already has it on. */
function hintFor(attempts: number, verbose: boolean, cutOff: boolean): string {
  const action = verbose ? `${NETWORK_HINT}.` : `${NETWORK_HINT}, or ${VERBOSE_HINT}.`;
  if (cutOff) {
    const tries = attempts > 1 ? ` (${attempts} attempts)` : "";
    return `The response was cut off${tries}. ${action}`;
  }
  return attempts > 1 ? `No response after ${attempts} attempts. ${action}` : action;
}

/** Plain words for a transport failure. Bun's own messages carry advice meant
 *  for Bun developers ("pass `verbose: true` in the second argument to
 *  fetch()"), which a CLI user cannot act on. */
export function describeTransportFailure(e: Error): string {
  const code = (e as { code?: unknown }).code;
  if (
    code === "ECONNRESET" ||
    code === "ConnectionClosed" ||
    /socket connection was closed/i.test(e.message)
  ) {
    return "the server closed the connection before responding";
  }
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") {
    return "could not connect to the server";
  }
  const cleaned = e.message.replace(/\s*For more information, pass `verbose: true`.*$/s, "").trim();
  return cleaned || e.name;
}

const SENSITIVE_HEADER = /authorization|cookie|token|secret|password|api-?key/i;

function redactHeader(name: string, value: string): string {
  if (!SENSITIVE_HEADER.test(name)) return value;
  // Keep the scheme ("Bearer") so the log still shows which auth was sent.
  const space = value.indexOf(" ");
  if (/^authorization$/i.test(name) && space > 0) return `${value.slice(0, space)} [redacted]`;
  return "[redacted]";
}

/** Header entries with their original casing (a Headers object lowercases). */
function headerEntries(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) return [];
  if (headers instanceof Headers) {
    const out: [string, string][] = [];
    headers.forEach((value, name) => out.push([name, value]));
    return out;
  }
  if (Array.isArray(headers)) return headers.map(([n, v]) => [String(n), String(v)]);
  return Object.entries(headers).map(([n, v]) => [n, String(v)]);
}

function logRequest(
  log: (line: string) => void,
  method: string,
  url: string,
  init: RequestInit,
): void {
  log(`> ${method} ${url}`);
  for (const [name, value] of headerEntries(init.headers)) {
    log(`>   ${name}: ${redactHeader(name, value)}`);
  }
  // Size only, never content: bodies carry refresh and access tokens. The size
  // matters for diagnosis (the 2026-09-24 resets depended on request size).
  if (typeof init.body === "string") {
    log(`>   (body: ${new TextEncoder().encode(init.body).length} bytes)`);
  }
}
