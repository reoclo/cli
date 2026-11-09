// src/tunnels/approvals.ts
//
// Pending requests from agents. A request that needs a person's approval is
// stored here, in memory, with the action the daemon will run once someone
// approves it. Nothing is persisted: a daemon restart drops every approval.

import { randomBytes } from "node:crypto";
import { ManagerError } from "./manager";
import type { Timers } from "./pool";

/** How long a request waits for an answer. */
export const APPROVAL_TTL_MS = 10 * 60_000;
/** How long a decided approval stays readable, so the agent can fetch its result. */
const KEEP_DECIDED_MS = 60 * 60_000;
const MAX_KEPT = 100;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalView {
  id: string;
  /** The MCP client's name from its initialize handshake. */
  agent: string;
  /** The tool-shaped name of what was asked: save_tunnel, open_tunnel, trust_ca and so on. */
  action: string;
  description: string;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  decided_at?: string;
  /** What the approved action returned. */
  result?: unknown;
  /** Set when the person approved but the action then failed. */
  error?: { code: string; message: string };
}

export interface ApprovalInput {
  agent: string;
  action: string;
  description: string;
  /** Runs when the request is approved. */
  run: () => Promise<unknown>;
}

interface Record_ extends ApprovalInput {
  id: string;
  status: ApprovalStatus;
  created: number;
  expires: number;
  decided?: number;
  /** Approved and executing: no longer pending, result not yet stored. */
  running: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  timer?: unknown;
}

export interface ApprovalStoreOptions {
  now?: () => number;
  timers?: Timers;
  ttlMs?: number;
  /** Called after an approval is created or decided (or expires). */
  onChange?: (approval: ApprovalView) => void;
  newId?: () => string;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class ApprovalStore {
  private readonly records = new Map<string, Record_>();
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly ttl: number;
  private readonly newId: () => string;

  constructor(private readonly opts: ApprovalStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.ttl = opts.ttlMs ?? APPROVAL_TTL_MS;
    this.newId = opts.newId ?? (() => randomBytes(4).toString("hex"));
  }

  create(input: ApprovalInput): ApprovalView {
    this.prune();
    let id = this.newId();
    while (this.records.has(id)) id = this.newId();
    const created = this.now();
    const rec: Record_ = { ...input, id, status: "pending", created, expires: created + this.ttl, running: false };
    rec.timer = this.timers.set(() => this.expire(rec), this.ttl);
    this.records.set(id, rec);
    const view = this.view(rec);
    this.opts.onChange?.(view);
    return view;
  }

  /** Pending approvals, newest first; with `all`, recently decided ones too. */
  list(o: { all?: boolean } = {}): ApprovalView[] {
    const out: ApprovalView[] = [];
    for (const rec of [...this.records.values()].sort((a, b) => b.created - a.created)) {
      this.refresh(rec);
      if (o.all || (rec.status === "pending" && !rec.running)) out.push(this.view(rec));
    }
    return out;
  }

  get(id: string): ApprovalView {
    return this.view(this.require(id));
  }

  /** Approve and run the action. The stored approval carries its result or error. */
  async approve(id: string): Promise<ApprovalView> {
    const rec = this.require(id);
    this.claim(rec);
    rec.running = true;
    this.cancelTimer(rec);
    try {
      rec.result = await rec.run();
    } catch (err) {
      rec.error =
        err instanceof ManagerError
          ? { code: err.code, message: err.message }
          : { code: "internal", message: err instanceof Error ? err.message : String(err) };
    }
    rec.status = "approved";
    rec.running = false;
    rec.decided = this.now();
    const view = this.view(rec);
    this.opts.onChange?.(view);
    return view;
  }

  deny(id: string): ApprovalView {
    const rec = this.require(id);
    this.claim(rec);
    this.cancelTimer(rec);
    rec.status = "denied";
    rec.decided = this.now();
    const view = this.view(rec);
    this.opts.onChange?.(view);
    return view;
  }

  /** Drop every timer. Called when the daemon stops. */
  stop(): void {
    for (const rec of this.records.values()) this.cancelTimer(rec);
  }

  private require(id: string): Record_ {
    const rec = this.records.get(id);
    if (!rec) throw new ManagerError("not_found", `no approval with id "${id}"`);
    this.refresh(rec);
    return rec;
  }

  /** Throws unless the approval can still be decided. */
  private claim(rec: Record_): void {
    if (rec.running) throw new ManagerError("conflict", `approval ${rec.id} is already being approved`);
    if (rec.status !== "pending") throw new ManagerError("conflict", `approval ${rec.id} is already ${rec.status}`);
  }

  private refresh(rec: Record_): void {
    if (rec.status === "pending" && !rec.running && this.now() >= rec.expires) this.expire(rec);
  }

  private expire(rec: Record_): void {
    if (rec.status !== "pending" || rec.running) return;
    this.cancelTimer(rec);
    rec.status = "expired";
    rec.decided = this.now();
    this.opts.onChange?.(this.view(rec));
  }

  private cancelTimer(rec: Record_): void {
    if (rec.timer !== undefined) {
      this.timers.clear(rec.timer);
      rec.timer = undefined;
    }
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_DECIDED_MS;
    const decided = [...this.records.values()]
      .filter((r) => r.decided !== undefined)
      .sort((a, b) => (b.decided ?? 0) - (a.decided ?? 0));
    decided.forEach((rec, i) => {
      if ((rec.decided ?? 0) < cutoff || i >= MAX_KEPT) this.records.delete(rec.id);
    });
  }

  private view(rec: Record_): ApprovalView {
    return {
      id: rec.id,
      agent: rec.agent,
      action: rec.action,
      description: rec.description,
      status: rec.status,
      created_at: new Date(rec.created).toISOString(),
      expires_at: new Date(rec.expires).toISOString(),
      ...(rec.decided === undefined ? {} : { decided_at: new Date(rec.decided).toISOString() }),
      ...(rec.result === undefined ? {} : { result: rec.result }),
      ...(rec.error === undefined ? {} : { error: rec.error }),
    };
  }
}
