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
  role?: "runtime" | "build" | "both";
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
  group_id?: string | null;
  current_deployment_id: string | null;
  created_at: string;
  /**
   * Read-only, server-computed. "linked" = the bound container was created by
   * something other than Reoclo; "reoclo" = Reoclo deployed it (or there is no
   * container yet). Optional because older API versions omit the field.
   */
  container_origin?: "linked" | "reoclo";
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

/** Answer of the deployment cancel endpoints (app deployment and group deployment). */
export interface DeploymentCancelResult {
  id: string;
  /** Status after the request: "cancelled" is immediate, anything else means the running step is being stopped (the step replacing services finishes first). */
  status: string;
  cancel_requested_at: string;
  message: string;
}

export interface Repository {
  id: string;
  tenant_id: string;
  full_name: string;
  name: string;
  owner_login: string;
  is_private: boolean;
  default_branch: string;
  status: string;
  last_push_at?: string | null;
}

export type RedirectCode = 301 | 302 | 307 | 308;

export interface DomainRedirect {
  target_domain_id: string | null;
  target_url: string | null;
  target_path: string | null;
  status_code: RedirectCode;
  keep_path: boolean;
}

export type IpAllowlistPreset = "cloudflare";

/**
 * Source-IP rules enforced by the managed proxy. Shared by domains and by a
 * server's default. `cidrs` takes IPv4/IPv6 addresses or CIDR ranges (max 100);
 * both lists empty means open to everyone.
 */
export interface IpAllowlist {
  cidrs: string[];
  presets: IpAllowlistPreset[];
}

/** The `proxy` block of a server (API 1.239.0+ adds `ip_allowlist`). */
export interface ServerProxyConfig {
  mode?: string;
  external_proxy_type?: string | null;
  intent?: unknown;
  observed?: unknown;
  grant?: unknown;
  /** The server's default allowlist; null when none is set. */
  ip_allowlist?: IpAllowlist | null;
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
  target_port?: number | null;
  /** Whether Reoclo keeps this domain's DNS records published. Absent on older APIs. */
  dns_publish?: { enabled: boolean; proxied: boolean } | null;
  /** Set when the domain redirects instead of serving its application (API 1.238.0+). */
  redirect?: DomainRedirect | null;
  /** Own allowlist; null inherits the server's default. Managed proxy only. */
  ip_allowlist?: IpAllowlist | null;
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

export type ProviderType = "github" | "gitea";
export type ProviderScope = "platform" | "tenant";

export interface GitProvider {
  id: string;
  tenant_id: string;
  provider_type: ProviderType;
  scope: ProviderScope;
  name: string;
  slug: string;
  instance_url: string;
  api_url: string | null;
  status: "active" | "inactive";
  oauth_client_id: string | null;
  is_connected: boolean;
  connected_at: string | null;
  allowed_organizations: string[] | null;
  created_at: string;
  updated_at: string;
  sync_status: "idle" | "syncing" | "enriching" | "completed" | "failed";
  sync_total_repos: number;
  sync_completed_repos: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  sync_error: string | null;
  last_health_checked_at: string | null;
  last_health_status: "healthy" | "disconnected" | "error" | null;
}

export interface SyncStatusResponse {
  status: "idle" | "syncing" | "enriching" | "completed" | "failed";
  total_repos: number;
  completed_repos: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export type DetectedBuildPack = "dockerfile" | "docker_compose" | "docker_image";

export interface DetectedPort {
  container_port: number;
  protocol: "tcp" | "udp";
}

export interface DetectedService {
  service_id: string;
  name: string;
  suggested_slug: string;
  base_directory: string;
  build_pack: DetectedBuildPack;
  dockerfile_path: string | null;
  build_context: string | null;
  compose_file_path: string | null;
  compose_service: string | null;
  container_port: number | null;
  ports: DetectedPort[];
  image: string | null;
  health_check_type: string | null;
  health_check_value: string | null;
  environment_literal_keys: string[];
  build_arg_keys: string[];
  profiles: string[];
  task_label: boolean;
  depends_on: string[];
  detected_files: string[];
  source: "dockerfile" | "compose" | "image";
}

export interface SkippedService {
  name: string;
  reason: string;
  compose_service?: string | null;
}

export interface DetectedDeploymentConfig {
  path: string;
  label: string;
  base_directory?: string | null;
  valid: boolean;
  validation_error?: string | null;
  matched_application_id?: string | null;
}

export interface ManualConfigResult {
  requested_path: string;
  path: string;
  status: "ok" | "not_found" | "invalid";
  kind?: "compose" | "deployment_config" | null;
  error?: string | null;
}

export interface RepoScanResponse {
  repository_id: string;
  ref: string;
  commit_sha: string;
  compose_files: string[];
  services: DetectedService[];
  skipped_services: SkippedService[];
  deployment_configs: DetectedDeploymentConfig[];
  manual_configs: ManualConfigResult[];
}

export interface WizardServiceCreate {
  action: "create";
  name: string;
  slug?: string;
  server_id: string;
  base_directory: string;
  build_pack: DetectedBuildPack;
  dockerfile_path?: string;
  compose_file_path?: string;
  compose_service?: string;
  container_port: number;
  deploy_branch: string | null;
  auto_deploy: boolean;
  linked_container_name: string | null;
  docker_image: string | null;
}

export interface WizardCreateRequest {
  repository_id: string;
  group_name: string | null;
  group_description: string;
  services: WizardServiceCreate[];
  secret_project_bindings: never[];
  deploy_as_stack: boolean;
  deploy_branch: string | null;
}

export interface WizardCreateResponse {
  group: { id: string; name: string; slug: string; kind: string } | null;
  created: Array<{ id: string; name: string; slug: string; status: string }>;
  adopted: Array<{ id: string; name: string; slug: string; status: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

export interface GitHubInstallation {
  installation_id: number;
  account_login: string;
  status?: string;
  repo_selection: "all" | "selected";
  selected_repo_ids: number[];
}

export interface GitHubAvailableRepo {
  id: number;
  full_name: string;
  private: boolean;
  archived: boolean;
}
