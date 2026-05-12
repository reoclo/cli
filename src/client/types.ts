/**
 * Membership of an organization (a.k.a. tenant on the server side).
 * Field names match the API contract; user-facing strings should
 * call these "organizations", not "tenants".
 */
export interface OrgMembership {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  role: string;
}

export interface Me {
  id: string;
  email: string;
  tenant_id: string;
  tenant_slug: string;
  roles: string[];
  memberships?: OrgMembership[];
}

export interface Server {
  id: string;
  slug: string;
  name: string | null;
  hostname: string;
  public_ip: string | null;
  status: "online" | "offline" | "unknown";
  runner_version?: string | null;
  connection_type: "runner" | "ssh";
  cpu_cores?: number;
  ram_mb?: number;
  disk_gb?: number;
  created_at: string;
}

export interface Application {
  id: string;
  slug: string;
  name: string;
  server_id: string;
  repository_id: string | null;
  current_deployment_id: string | null;
  created_at: string;
}

export interface Deployment {
  id: string;
  application_id: string;
  status: "queued" | "building" | "deploying" | "succeeded" | "failed" | "cancelled";
  commit_sha?: string;
  commit_ref?: string;
  started_at?: string;
  finished_at?: string;
}

export interface Domain {
  id: string;
  tenant_id: string;
  fqdn: string;
  status: string;
  application_id: string | null;
  bound_server_id: string | null;
  verified_domain_id: string | null;
  scheme_hint: string | null;
}

/**
 * Standard paginated envelope used by the API for several list endpoints
 * (applications, deployments). Other list endpoints (servers, domains)
 * return bare arrays — check the specific endpoint's response shape.
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  skip: number;
  limit: number;
}
