import type { HttpClient } from "../client/http";
import type { ResolvedContext } from "../client/bootstrap";
import type { RunContext } from "./context";

type PostGet = Pick<HttpClient, "post" | "get">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "timeout"]);

function exitErr(message: string, code: number): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = code;
  return e;
}

/** CI commands are automation-key-only. */
export function requireAutomationKey(ctx: Pick<ResolvedContext, "tokenType">): void {
  if (ctx.tokenType !== "automation") {
    throw exitErr(
      "this command requires a Reoclo automation key (rca_*) — set REOCLO_AUTOMATION_KEY",
      4,
    );
  }
}

/** Automation keys can't list servers, so CI commands take a server UUID. */
export function requireServerUuid(identifier: string): string {
  if (UUID_RE.test(identifier)) return identifier;
  throw exitErr(
    `automation commands require a server UUID, got "${identifier}". ` +
      `Find it with 'reoclo servers ls' under an interactive login.`,
    2,
  );
}

export interface AutomationExecRequest {
  server_id: string;
  command: string;
  working_directory?: string;
  env?: Record<string, string>;
  timeout_seconds?: number;
  run_id?: string;
  run_context?: RunContext;
}

export interface AutomationExecResult {
  operation_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

interface ExecResponse {
  operation_id: string;
  status: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
}

interface OperationDetail {
  status: string;
  result?: { exit_code?: number; stdout?: string; stderr?: string; duration_ms?: number };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function pollUntilComplete(
  client: Pick<HttpClient, "get">,
  operationId: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  intervalMs = 2000,
  maxAttempts = 300,
): Promise<OperationDetail> {
  for (let i = 0; i < maxAttempts; i++) {
    const detail = await client.get<OperationDetail>(`/operations/${operationId}`);
    if (TERMINAL.has(detail.status)) return detail;
    await sleep(intervalMs);
  }
  throw exitErr(`operation ${operationId} did not complete after ${maxAttempts} polls`, 1);
}

export async function execOnServer(
  client: PostGet,
  req: AutomationExecRequest,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<AutomationExecResult> {
  const res = await client.post<ExecResponse>("/exec", req);
  if (TERMINAL.has(res.status)) {
    return {
      operation_id: res.operation_id,
      exit_code: res.exit_code ?? 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      duration_ms: res.duration_ms ?? 0,
    };
  }
  const detail = await pollUntilComplete(client, res.operation_id, sleep);
  const r = detail.result ?? {};
  return {
    operation_id: res.operation_id,
    exit_code: r.exit_code ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    duration_ms: r.duration_ms ?? 0,
  };
}

export interface RegistryLoginResponse {
  operation_id: string;
  registry_url: string;
  registry_type: string;
}

export function registryLogin(
  client: Pick<HttpClient, "post">,
  req: { server_id: string; credential_id: string; run_id?: string; run_context?: RunContext },
): Promise<RegistryLoginResponse> {
  return client.post<RegistryLoginResponse>("/registry-auth/login", req);
}

export function registryLoginDirect(
  client: Pick<HttpClient, "post">,
  req: {
    server_id: string;
    registry_url: string;
    username: string;
    access_token: string;
    run_id?: string;
    run_context?: RunContext;
  },
): Promise<RegistryLoginResponse> {
  return client.post<RegistryLoginResponse>("/registry-auth/login-direct", req);
}

export function registryLogout(
  client: Pick<HttpClient, "post">,
  req: { server_id: string; registry_url: string; run_id?: string; run_context?: RunContext },
): Promise<unknown> {
  return client.post<unknown>("/registry-auth/logout", req);
}
