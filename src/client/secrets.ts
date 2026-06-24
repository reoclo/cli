import type { HttpClient } from "./http";

export interface SecretProjectRead {
  id: string;
  name: string;
  description?: string | null;
}

export interface SecretRead {
  id: string;
  key: string;
  current_version: number;
}

export interface AccessibleProject {
  id: string;
  name: string;
  access: "read" | "read_write";
}

export interface ResolveResponse {
  values: Record<string, string>;
}

export interface OpenSessionResponse {
  session_id: string;
  session_token: string;
  expires_at: string;
  project_ids: string[];
}

// ---------------------------------------------------------------------------
// Human (OAuth) paths — prefix: /mcp → /tenants/{tid}/…
// ---------------------------------------------------------------------------

export function listProjects(c: HttpClient, tid: string): Promise<SecretProjectRead[]> {
  return c.get<SecretProjectRead[]>(`/tenants/${tid}/secret-projects`);
}

export function listSecrets(
  c: HttpClient,
  tid: string,
  projectId: string,
): Promise<SecretRead[]> {
  return c.get<SecretRead[]>(`/tenants/${tid}/secret-projects/${projectId}/secrets`);
}

export function setSecret(
  c: HttpClient,
  tid: string,
  projectId: string,
  key: string,
  value: string,
  note?: string,
): Promise<SecretRead> {
  return c.post<SecretRead>(`/tenants/${tid}/secret-projects/${projectId}/secrets`, {
    key,
    value,
    note,
  });
}

export interface SecretCreate {
  key: string;
  value: string;
  note?: string;
}

export function bulkCreateSecrets(
  c: HttpClient,
  tid: string,
  projectId: string,
  secrets: SecretCreate[],
): Promise<SecretRead[]> {
  return c.post<SecretRead[]>(
    `/tenants/${tid}/secret-projects/${projectId}/secrets/bulk`,
    { secrets },
  );
}

export function revealSecret(
  c: HttpClient,
  tid: string,
  secretId: string,
): Promise<{ key: string; value: string }> {
  return c.post<{ key: string; value: string }>(`/tenants/${tid}/secrets/${secretId}/reveal`);
}

export function patchSecret(
  c: HttpClient,
  tid: string,
  secretId: string,
  value: string,
): Promise<SecretRead> {
  return c.patch<SecretRead>(`/tenants/${tid}/secrets/${secretId}`, { value });
}

export function deleteSecret(c: HttpClient, tid: string, secretId: string): Promise<void> {
  return c.del<void>(`/tenants/${tid}/secrets/${secretId}`);
}

// ---------------------------------------------------------------------------
// Machine (automation token) paths — prefix: /api/automation/v1 → /secrets/…
// ---------------------------------------------------------------------------

export function accessibleProjects(c: HttpClient): Promise<AccessibleProject[]> {
  return c.get<AccessibleProject[]>(`/secrets/accessible-projects`);
}

export function openSession(
  c: HttpClient,
  projectIds: string[],
  meta: { commit_sha?: string; workflow_run_id?: string },
): Promise<OpenSessionResponse> {
  return c.post<OpenSessionResponse>(`/secrets/open-session`, {
    project_ids: projectIds,
    ...meta,
  });
}

export function resolve(c: HttpClient, projectIds: string[]): Promise<ResolveResponse> {
  return c.post<ResolveResponse>(`/secrets/resolve`, { project_ids: projectIds });
}

// ---------------------------------------------------------------------------
// Pure helper — merge process.env-style base with resolved secrets.
// resolved wins on collision; undefined base values are dropped.
// ---------------------------------------------------------------------------

export function mergeEnv(
  base: Record<string, string | undefined>,
  resolved: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  for (const [k, v] of Object.entries(resolved)) {
    out[k] = v;
  }
  return out;
}
