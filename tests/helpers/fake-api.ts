// tests/helpers/fake-api.ts
//
// In-memory ApiClient for the repository-deploy flows: routes answer from
// closures, every request is recorded, and the wait loops run on a fake clock,
// so no test touches the network or sleeps.
import type { ApiClient } from "../../src/client/api-client";
import type { DeployIo } from "../../src/ui/deploy-io";
import type {
  DetectedService,
  RepoScanResponse,
  Repository,
} from "../../src/client/types";

export type Method = "GET" | "POST" | "PUT";

export interface RecordedRequest {
  method: Method;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (req: RecordedRequest) => unknown;

export class FakeApi implements ApiClient {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{ method: Method; path: string; handler: Handler }> = [];

  on(method: Method, path: string, response: Handler): this;
  on(method: Method, path: string, response: unknown): this;
  on(method: Method, path: string, response: unknown): this {
    this.routes.push({
      method,
      path,
      handler: typeof response === "function" ? (response as Handler) : () => response,
    });
    return this;
  }

  calls(method: Method, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  get<T>(path: string): Promise<T> {
    return this.handle<T>("GET", path, undefined);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.handle<T>("POST", path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.handle<T>("PUT", path, body);
  }

  private handle<T>(method: Method, fullPath: string, body: unknown): Promise<T> {
    const [path = "", search = ""] = fullPath.split("?");
    const req: RecordedRequest = { method, path, query: new URLSearchParams(search), body };
    this.requests.push(req);
    const route = this.routes.find((r) => r.method === method && r.path === path);
    if (!route) return Promise.reject(new Error(`unexpected ${method} ${fullPath}`));
    try {
      return Promise.resolve(route.handler(req) as T);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export class FakeClock {
  time = 0;
  readonly slept: number[] = [];
  readonly now = (): number => this.time;
  readonly sleep = (ms: number): Promise<void> => {
    this.slept.push(ms);
    this.time += ms;
    return Promise.resolve();
  };
}

export interface CollectedIo {
  io: DeployIo;
  lines: string[];
  raws: string[];
  objects: Array<{ obj: Record<string, unknown>; fmt: string }>;
}

export function collectIo(): CollectedIo {
  const lines: string[] = [];
  const raws: string[] = [];
  const objects: CollectedIo["objects"] = [];
  return {
    lines,
    raws,
    objects,
    io: {
      line: (text) => void lines.push(text),
      raw: (text) => void raws.push(text),
      object: (obj, fmt) => void objects.push({ obj, fmt }),
    },
  };
}

export async function captureOutput<T>(fn: () => Promise<T> | T): Promise<{ out: string; result: T }> {
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  console.log = (...args: unknown[]): void => {
    chunks.push(`${args.map(String).join(" ")}\n`);
  };
  try {
    const result = await fn();
    return { out: chunks.join(""), result };
  } finally {
    process.stdout.write = realWrite;
    console.log = realLog;
  }
}

export const TID = "00000000-0000-0000-0000-00000000aaaa";
export const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";

export function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: TID,
    full_name: "acme/web",
    name: "web",
    owner_login: "acme",
    is_private: false,
    default_branch: "main",
    status: "active",
    ...overrides,
  };
}

export function service(overrides: Partial<DetectedService> = {}): DetectedService {
  return {
    service_id: "docker-compose.yml:web",
    name: "web",
    suggested_slug: "web",
    base_directory: ".",
    build_pack: "docker_compose",
    dockerfile_path: null,
    build_context: null,
    compose_file_path: "docker-compose.yml",
    compose_service: "web",
    container_port: 3000,
    ports: [{ container_port: 3000, protocol: "tcp" }],
    image: null,
    health_check_type: null,
    health_check_value: null,
    environment_literal_keys: [],
    build_arg_keys: [],
    profiles: [],
    task_label: false,
    depends_on: [],
    detected_files: [],
    source: "compose",
    ...overrides,
  };
}

export function scan(overrides: Partial<RepoScanResponse> = {}): RepoScanResponse {
  return {
    repository_id: "11111111-1111-1111-1111-111111111111",
    ref: "main",
    commit_sha: "abcdef1234567890",
    compose_files: ["docker-compose.yml"],
    services: [service()],
    skipped_services: [],
    deployment_configs: [],
    manual_configs: [],
    ...overrides,
  };
}
