import type { Timers } from "./pool";
import type { TunnelState } from "./states";

export interface RetryView {
  readonly attempt: number;
  readonly next_at: string;
}

export interface RecoveryPolicy {
  readonly maxBackoffMs?: number;
  readonly random?: () => number;
  readonly now?: () => number;
}

export function canRecover(state: TunnelState): boolean {
  switch (state) {
    case "server_offline":
    case "failed":
    case "expired":
    case "reconnecting":
      return true;
    case "down":
    case "ready":
    case "connecting":
    case "active":
    case "needs_sign_in":
    case "quota_reached":
    case "closed_by_operator":
    case "forbidden":
      return false;
  }
}

/** A runtime owns one reconnect timer; successful sessions and explicit actions reset it. */
export class Reconnect {
  private timer: unknown;
  private attempt = 0;
  private due?: RetryView;

  constructor(private readonly timers: Timers, private readonly policy: RecoveryPolicy) {}

  get waiting(): boolean { return this.timer !== undefined; }
  get view(): RetryView | undefined { return this.due; }

  schedule(run: () => void): void {
    if (this.waiting) return;
    const cap = this.policy.maxBackoffMs ?? 30_000;
    const base = Math.min(cap, 1000 * 2 ** Math.min(this.attempt, 30));
    const delay = Math.min(cap, Math.max(1000, Math.round(base * (0.75 + (this.policy.random ?? Math.random)() * 0.25))));
    this.attempt++;
    this.due = { attempt: this.attempt, next_at: new Date((this.policy.now ?? Date.now)() + delay).toISOString() };
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.due = undefined;
      run();
    }, delay);
  }

  reset(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.due = undefined;
    this.attempt = 0;
  }
}
