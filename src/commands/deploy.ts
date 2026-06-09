import { readFile } from "node:fs/promises";
import { load } from "js-yaml";
import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import { globalOutput, printObject, resolveFormat } from "../ui/output";
import { detectCiContext } from "../ci/context";
import { requireAutomationKey } from "../ci/automation-client";
import {
  DeploySyncClient,
  type DeploySessionCreateResponse,
  type DeploySyncRequestItem,
  type DeploySyncResponse,
} from "../ci/deploy-client";

function exitErr(message: string, code: number): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = code;
  return e;
}

/** A container to register, before session matching. `image_tag` null = unknown. */
export interface DiscoveredService {
  container_name: string;
  container_port: number;
  image_tag: string | null;
  /**
   * Explicit application reference (slug or UUID) from a `reoclo.app` /
   * `reoclo.app-id` label. Lets a container bind to its Reoclo application by
   * identity rather than by name — required when the deployed container name
   * doesn't follow Reoclo's naming scheme.
   */
  application_ref?: string;
}

// ---------------------------------------------------------------------------
// Compose discovery (ported from github-action-deploy-sync/src/compose.ts,
// swapping the `yaml` package for the CLI's js-yaml and `@actions/core` warnings
// for stderr).
// ---------------------------------------------------------------------------

interface RawService {
  container_name?: string;
  image?: string;
  networks?: string[] | Record<string, unknown>;
  labels?: string[] | Record<string, string>;
  expose?: Array<string | number>;
  ports?: Array<string | number | { target?: number; published?: number }>;
}

interface RawCompose {
  services?: Record<string, RawService>;
}

function hasReocloNetwork(networks: RawService["networks"]): boolean {
  if (!networks) return false;
  if (Array.isArray(networks)) return networks.includes("reoclo-proxy");
  return "reoclo-proxy" in networks;
}

function hasReocloLabel(labels: RawService["labels"]): boolean {
  if (!labels) return false;
  if (Array.isArray(labels)) return labels.some((l) => l === "reoclo.managed=true");
  return labels["reoclo.managed"] === "true";
}

/** Read a single label value, supporting both array (`["k=v"]`) and map (`{k: v}`) forms. */
function readLabel(labels: RawService["labels"], key: string): string | undefined {
  if (!labels) return undefined;
  if (Array.isArray(labels)) {
    const prefix = `${key}=`;
    const hit = labels.find((l) => l.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  }
  const value = labels[key];
  return value !== undefined ? String(value) : undefined;
}

/**
 * Explicit application reference from labels. `reoclo.app-id` (a UUID) takes
 * precedence over `reoclo.app` (a slug). Returns undefined when neither is set.
 */
function extractAppRef(labels: RawService["labels"]): string | undefined {
  const byId = readLabel(labels, "reoclo.app-id")?.trim();
  if (byId) return byId;
  const bySlug = readLabel(labels, "reoclo.app")?.trim();
  return bySlug || undefined;
}

function extractPort(service: RawService): number | null {
  if (service.expose && service.expose.length > 0) {
    const first = service.expose[0];
    if (first !== undefined) {
      const n = parseInt(String(first), 10);
      if (!isNaN(n)) return n;
    }
  }
  if (service.ports && service.ports.length > 0) {
    const first = service.ports[0];
    if (first !== undefined) {
      if (typeof first === "number") return first;
      if (typeof first === "string") {
        // "4321", "8080:80", "0.0.0.0:8080:80" → the container-side port is last.
        const parts = first.split(":");
        const containerPart = parts[parts.length - 1];
        if (containerPart) {
          const n = parseInt(containerPart, 10);
          if (!isNaN(n)) return n;
        }
      }
      if (typeof first === "object" && first !== null && "target" in first) {
        const target = first.target;
        if (typeof target === "number") return target;
      }
    }
  }
  return null;
}

export async function discoverFromCompose(composeFilePath: string): Promise<DiscoveredService[]> {
  let content: string;
  try {
    content = await readFile(composeFilePath, "utf-8");
  } catch {
    throw exitErr(`compose file not found or unreadable: ${composeFilePath}`, 2);
  }

  let doc: RawCompose;
  try {
    doc = (load(content) ?? {}) as RawCompose;
  } catch (cause) {
    throw exitErr(`failed to parse compose file ${composeFilePath}: ${(cause as Error).message}`, 2);
  }

  if (!doc || !doc.services) return [];

  const results: DiscoveredService[] = [];
  for (const [serviceKey, service] of Object.entries(doc.services)) {
    if (!service) continue;
    if (!(hasReocloNetwork(service.networks) || hasReocloLabel(service.labels))) continue;

    const container_name = service.container_name ?? serviceKey;
    const container_port = extractPort(service);
    const image_tag = service.image ?? null;
    const application_ref = extractAppRef(service.labels);

    if (container_port === null) {
      process.stderr.write(
        `warning: service "${serviceKey}" is managed by Reoclo but has no exposed or mapped port — skipping\n`,
      );
      continue;
    }
    results.push({
      container_name,
      container_port,
      image_tag,
      ...(application_ref ? { application_ref } : {}),
    });
  }
  return results;
}

export function parseServicesList(input: string): DiscoveredService[] {
  const results: DiscoveredService[] = [];
  for (const entry of input.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.lastIndexOf(":");
    if (colonIdx === -1) {
      throw exitErr(`invalid services entry "${trimmed}" — expected format "container_name:port"`, 2);
    }
    const name = trimmed.slice(0, colonIdx).trim();
    const portStr = trimmed.slice(colonIdx + 1).trim();
    const port = parseInt(portStr, 10);
    if (!name) {
      throw exitErr(`invalid services entry "${trimmed}" — container name is empty`, 2);
    }
    if (isNaN(port) || port <= 0) {
      throw exitErr(`invalid services entry "${trimmed}" — port "${portStr}" is not a valid number`, 2);
    }
    results.push({ container_name: name, container_port: port, image_tag: null });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Sync orchestration helpers (pure — unit-tested directly).
// ---------------------------------------------------------------------------

/** Build sync items, dropping containers the session couldn't match. */
export function buildDeployments(
  discovered: DiscoveredService[],
  unmatched: string[],
  force: boolean,
): DeploySyncRequestItem[] {
  const unmatchedSet = new Set(unmatched);
  const out: DeploySyncRequestItem[] = [];
  for (const svc of discovered) {
    // The API reports unmatched names AND refs. Keep a service if it matched by
    // either dimension — drop only when both its name and its ref are unmatched.
    const matchedByName = !unmatchedSet.has(svc.container_name);
    const matchedByRef =
      svc.application_ref !== undefined && !unmatchedSet.has(svc.application_ref);
    if (!matchedByName && !matchedByRef) continue;
    const item: DeploySyncRequestItem = {
      container_name: svc.container_name,
      container_port: svc.container_port,
      force,
    };
    if (svc.image_tag !== null) item.image_tag = svc.image_tag;
    if (svc.application_ref !== undefined) item.application_ref = svc.application_ref;
    out.push(item);
  }
  return out;
}

export interface SyncSummary {
  /** De-duped union of synced_fqdns from `synced` + `drift_recovered` results. */
  syncedFqdns: string[];
  /** "container_name: reason" for each `conflict` result. */
  conflicts: string[];
  errors: Array<{ container_name: string; reason: string }>;
  /** Whether the command should exit 0 (no unforced conflicts, no errors). */
  exitOk: boolean;
}

export function summarizeSync(resp: DeploySyncResponse, force: boolean): SyncSummary {
  const fqdns: string[] = [];
  const conflicts: string[] = [];
  for (const r of resp.results) {
    if (r.status === "conflict") conflicts.push(`${r.container_name}: ${r.reason ?? "conflict"}`);
    if (r.status === "synced" || r.status === "drift_recovered") fqdns.push(...r.synced_fqdns);
  }
  const hasUnforcedConflicts = conflicts.length > 0 && !force;
  return {
    syncedFqdns: [...new Set(fqdns)],
    conflicts,
    errors: resp.errors,
    exitOk: !hasUnforcedConflicts && resp.errors.length === 0,
  };
}

export function registerDeploy(program: Command): void {
  const g = program.command("deploy").description("external deploy operations (CI)");

  g.command("sync")
    .description("register externally-deployed containers' proxy routes via Reoclo (CI)")
    .option("--compose-file <path>", "discover Reoclo-managed services from a docker-compose file")
    .option("--services <list>", "explicit services as name:port[,name2:port2,...]")
    .option("--force", "override conflicts (re-take routes held by another signature)", false)
    .action(async (opts: { composeFile?: string; services?: string; force?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      requireAutomationKey(ctx);

      const hasCompose = (opts.composeFile ?? "").trim() !== "";
      const hasServices = (opts.services ?? "").trim() !== "";
      if (hasCompose && hasServices) {
        throw exitErr("--compose-file and --services are mutually exclusive — provide only one", 2);
      }
      if (!hasCompose && !hasServices) {
        throw exitErr("provide either --compose-file or --services", 2);
      }

      const force = opts.force === true;
      const discovered = hasCompose
        ? await discoverFromCompose((opts.composeFile ?? "").trim())
        : parseServicesList((opts.services ?? "").trim());

      if (discovered.length === 0) {
        throw exitErr("no services matched", 2);
      }
      process.stderr.write(
        `discovered ${discovered.length} service(s): ${discovered.map((s) => s.container_name).join(", ")}\n`,
      );

      const ci = detectCiContext();
      const client = new DeploySyncClient(ctx.api, ctx.token);

      const appRefs = [
        ...new Set(
          discovered
            .map((s) => s.application_ref)
            .filter((r): r is string => r !== undefined),
        ),
      ];

      try {
        const session: DeploySessionCreateResponse = await client.createSession({
          container_names: discovered.map((s) => s.container_name),
          ...(appRefs.length > 0 ? { application_refs: appRefs } : {}),
          ...(ci.runId ? { workflow_run_id: ci.runId } : {}),
          ...(ci.runContext.sha ? { commit_sha: ci.runContext.sha } : {}),
        });

        for (const name of session.unmatched) {
          process.stderr.write(
            `warning: container "${name}" has no matching Reoclo application — skipping\n`,
          );
        }

        const deployments = buildDeployments(discovered, session.unmatched, force);
        if (deployments.length === 0) {
          throw exitErr("no deployments to sync after filtering unmatched containers", 2);
        }

        const syncResp = await client.sync({ deployments });
        const summary = summarizeSync(syncResp, force);

        const result = {
          session_id: syncResp.session_id,
          synced_fqdns: summary.syncedFqdns,
          results: syncResp.results,
          errors: syncResp.errors,
        };

        if (fmt === "json" || fmt === "yaml") {
          printObject(result as unknown as Record<string, unknown>, fmt);
        } else {
          for (const r of syncResp.results) {
            process.stdout.write(`${r.container_name}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}\n`);
          }
          if (summary.syncedFqdns.length > 0) {
            process.stdout.write(`synced fqdns: ${summary.syncedFqdns.join(", ")}\n`);
          }
        }

        for (const err of summary.errors) {
          process.stderr.write(`sync error for "${err.container_name}": ${err.reason}\n`);
        }

        if (summary.conflicts.length > 0 && !force) {
          throw exitErr(
            `sync conflicts detected (use --force to override):\n${summary.conflicts.join("\n")}`,
            1,
          );
        }
        if (summary.errors.length > 0) {
          throw exitErr(
            `sync errors:\n${summary.errors.map((e) => `${e.container_name}: ${e.reason}`).join("\n")}`,
            1,
          );
        }
      } finally {
        try {
          await client.revokeSession();
        } catch (err) {
          process.stderr.write(`warning: failed to revoke deploy session: ${(err as Error).message}\n`);
        }
      }
    });
}
