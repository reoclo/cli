// src/client/relocate.ts
//
// Typed calls for the Relocate API. Every mutation carries a fresh request ID
// and the run revision the caller last saw, so the API can reject stale intent.

import { randomUUID } from "node:crypto";
import type { HttpClient } from "./http";

export type RelocationState =
  | "draft" | "preflight" | "blocked" | "planned" | "preparing" | "syncing"
  | "ready_for_cutover" | "cutting_over" | "verifying" | "cut_over" | "committing"
  | "committed" | "rolling_back" | "rolled_back" | "needs_attention" | "failed";

export type RelocationAction = "plan" | "run" | "cutover" | "confirm-dns" | "resume" | "rollback" | "commit";

export interface RequestedItem {
  kind: "app" | "stack" | "group";
  id: string;
}

export interface VolumeChoice {
  source_server_id: string;
  volume_name: string;
  mode: "warm_files";
  ordinary_files_acknowledged: true;
}

export interface RelocationCheck {
  code: string;
  status: string;
  message: string;
  remedy: string;
}

export interface Relocation {
  id: string;
  state: RelocationState;
  revision: number;
  target_server_id: string;
  source_server_ids: string[];
  plan_revision: number;
  plan_hash: string | null;
  plan_expires_at: string | null;
  blockers: RelocationCheck[];
  pause_reason: string | null;
  error_code: string | null;
  dns_switch_started_at: string | null;
  rollback_until: string | null;
  created_at: string;
  permitted_actions: RelocationAction[];
}

export interface RelocationDetail extends Relocation {
  record_plan_hash: string | null;
}

export interface RelocationEvent {
  sequence: number;
  phase: string;
  kind: string;
  code: string;
  message: string;
  created_at: string;
}

export const TERMINAL: ReadonlySet<RelocationState> = new Set(["committed", "rolled_back", "failed"]);
const OPERATOR_ACTIONS: ReadonlySet<RelocationAction> = new Set(["run", "cutover", "confirm-dns", "resume", "commit"]);

/** Watch stops where a person has to decide: a gate, attention, or the end. */
export function needsOperator(run: Relocation): boolean {
  return (
    TERMINAL.has(run.state) ||
    run.state === "needs_attention" ||
    run.state === "blocked" ||
    run.permitted_actions.some((a) => OPERATOR_ACTIONS.has(a))
  );
}

const base = (tid: string) => `/tenants/${tid}/relocations`;

export function planRelocation(
  c: HttpClient,
  tid: string,
  body: { items: RequestedItem[]; target_server_id: string; options: Record<string, unknown> },
): Promise<Relocation> {
  return c.post<Relocation>(base(tid), { ...body, request_id: randomUUID() });
}

export function listRelocations(c: HttpClient, tid: string): Promise<{ items: Relocation[]; total: number }> {
  return c.get(`${base(tid)}?limit=100`);
}

export function getRelocation(c: HttpClient, tid: string, id: string): Promise<RelocationDetail> {
  return c.get<RelocationDetail>(`${base(tid)}/${id}`);
}

export function getEvents(
  c: HttpClient,
  tid: string,
  id: string,
  after: number,
): Promise<{ items: RelocationEvent[]; next_after: number }> {
  return c.get(`${base(tid)}/${id}/events?after=${after}&limit=200`);
}

export function act(
  c: HttpClient,
  tid: string,
  run: Relocation,
  action: Exclude<RelocationAction, "plan">,
  extra: Record<string, unknown> = {},
): Promise<Relocation> {
  return c.post<Relocation>(`${base(tid)}/${run.id}/${action}`, {
    request_id: randomUUID(),
    revision: run.revision,
    ...extra,
  });
}

interface Group {
  id: string;
  slug: string;
  name: string;
  kind: string;
}

/** Stacks are compose groups; `--group` takes any group. Matches id, slug or exact name. */
export async function resolveGroupId(
  c: HttpClient,
  tid: string,
  ref: string,
  stackOnly: boolean,
): Promise<string> {
  const groups = await c.get<Group[]>(`/tenants/${tid}/application-groups/`);
  const needle = ref.trim().toLowerCase();
  const found = groups.find(
    (g) =>
      (!stackOnly || g.kind === "compose") &&
      (g.id === ref || g.slug === needle || g.name.trim().toLowerCase() === needle),
  );
  if (!found) {
    const e = new Error(`${stackOnly ? "stack" : "group"} '${ref}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found.id;
}
