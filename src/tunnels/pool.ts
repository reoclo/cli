// src/tunnels/pool.ts
//
// One gateway session per (org, server), shared by every saved tunnel to that
// server. The pool opens the session when the first stream or hold asks for it,
// counts open streams and keep-up holds, closes the session after an idle
// period, and remembers why a session ended so callers can show a state.

import type net from "node:net";
import type dgram from "node:dgram";
import type { ForwardSpec, ReadyState, ReverseSpec, SessionStatus } from "../client/tunnel-session";
import {
  isFailureState,
  isStickyState,
  stateForCloseCode,
  stateForConnectError,
  type TunnelState,
} from "./states";

/** The slice of TunnelSession the pool and the manager use. */
export interface PoolSession {
  start(): Promise<ReadyState>;
  stop(): Promise<void>;
  attachTcpSocket(sock: net.Socket, target: Pick<ForwardSpec, "remoteHost" | "remotePort">): void;
  forwardUdpDatagram(
    buf: Buffer,
    rinfo: dgram.RemoteInfo,
    target: Pick<ForwardSpec, "remoteHost" | "remotePort">,
    listener: dgram.Socket,
  ): void;
  addReverse(spec: ReverseSpec): Promise<string>;
  removeReverse(listenId: string): void;
}

export type StatusCallback = (s: SessionStatus, reason?: string, code?: number) => void;

/** Builds a session wired to `onStatus`. Async because it signs in first. */
export type SessionFactory = (onStatus: StatusCallback) => Promise<PoolSession>;

export interface PoolState {
  state: Exclude<TunnelState, "down">;
  detail?: string;
}

/** A claim on the pool's session. Release it exactly when the work ends. */
export interface Lease {
  readonly session: PoolSession;
  release(): void;
}

export type LeaseKind = "stream" | "hold";

export class PoolError extends Error {
  readonly state: Exclude<TunnelState, "down">;
  readonly detail?: string;
  constructor(state: Exclude<TunnelState, "down">, detail?: string) {
    super(detail ? `${state}: ${detail}` : state);
    this.name = "PoolError";
    this.state = state;
    this.detail = detail;
  }
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** What the manager needs from a pool, so tests can swap in a fake. */
export interface PoolLike {
  readonly state: PoolState;
  readonly streamCount: number;
  readonly holdCount: number;
  /** The session when it is open and ready for streams, else undefined. */
  activeSession(): PoolSession | undefined;
  acquire(kind: LeaseKind): Promise<Lease>;
  /** Record activity that is not a stream (a UDP datagram) so the idle timer restarts. */
  touch(): void;
  /** Clear a failure or terminal state. Called when someone runs `up`. */
  reset(): void;
  /** Change how long an unused session stays open. Applies from the next idle period. */
  setIdleTimeout?(ms: number): void;
  stop(): Promise<void>;
  onChange(fn: (s: PoolState) => void): () => void;
}

export interface ServerPoolOptions {
  createSession: SessionFactory;
  idleTimeoutMs: number;
  timers?: Timers;
}

export class ServerPool implements PoolLike {
  private readonly timers: Timers;
  private session?: PoolSession;
  /** Bumped whenever the current session is replaced or dropped; leases and status callbacks from an older generation are ignored. */
  private gen = 0;
  private connecting?: Promise<PoolSession>;
  private streams = 0;
  private holds = 0;
  private idleTimer?: unknown;
  private stopped = false;
  private current: PoolState = { state: "ready" };
  private readonly listeners = new Set<(s: PoolState) => void>();

  private idleMs: number;

  constructor(private readonly opts: ServerPoolOptions) {
    this.timers = opts.timers ?? realTimers;
    this.idleMs = opts.idleTimeoutMs;
  }

  setIdleTimeout(ms: number): void {
    this.idleMs = ms;
    if (this.idleTimer !== undefined) this.armIdle();
  }

  get state(): PoolState {
    return this.current;
  }
  get streamCount(): number {
    return this.streams;
  }
  get holdCount(): number {
    return this.holds;
  }

  onChange(fn: (s: PoolState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  activeSession(): PoolSession | undefined {
    return this.current.state === "active" && !this.connecting ? this.session : undefined;
  }

  async acquire(kind: LeaseKind): Promise<Lease> {
    if (this.stopped) throw new PoolError("failed", "the tunnel pool is stopped");
    const st = this.current.state;
    if (isStickyState(st)) throw new PoolError(st, this.current.detail);
    // A dropped WebSocket is being re-dialed by the session itself; frames sent now would be lost.
    if (st === "reconnecting") throw new PoolError("reconnecting", this.current.detail);
    const session = await this.ensureSession();
    const gen = this.gen;
    this.clearIdle();
    if (kind === "stream") this.streams++;
    else this.holds++;
    let released = false;
    return {
      session,
      release: () => {
        if (released) return;
        released = true;
        if (gen !== this.gen) return;
        if (kind === "stream") this.streams--;
        else this.holds--;
        this.armIdle();
      },
    };
  }

  touch(): void {
    if (this.session && this.streams === 0 && this.holds === 0 && this.idleTimer !== undefined) {
      this.armIdle();
    }
  }

  reset(): void {
    if (isFailureState(this.current.state)) this.setState({ state: "ready" });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearIdle();
    const session = this.session;
    this.session = undefined;
    this.gen++;
    this.streams = 0;
    this.holds = 0;
    if (this.current.state !== "ready") this.setState({ state: "ready" });
    await session?.stop().catch(() => undefined);
  }

  private ensureSession(): Promise<PoolSession> {
    if (this.connecting) return this.connecting;
    if (this.session) return Promise.resolve(this.session);
    return this.open();
  }

  private open(): Promise<PoolSession> {
    const gen = ++this.gen;
    this.setState({ state: "connecting" });
    const attempt = (async (): Promise<PoolSession> => {
      let session: PoolSession | undefined;
      try {
        session = await this.opts.createSession((s, reason, code) =>
          this.onStatus(gen, s, reason, code),
        );
        if (gen === this.gen) this.session = session;
        await session.start();
      } catch (err) {
        if (gen === this.gen) {
          const { state, detail } = stateForConnectError(err);
          this.session = undefined;
          this.setState({ state, detail });
          await session?.stop().catch(() => undefined);
          throw new PoolError(state, detail);
        }
        await session?.stop().catch(() => undefined);
        throw this.supersededError();
      }
      if (gen !== this.gen) {
        await session.stop().catch(() => undefined);
        throw this.supersededError();
      }
      this.setState({ state: "active" });
      return session;
    })();
    this.connecting = attempt;
    const clear = (): void => {
      if (this.connecting === attempt) this.connecting = undefined;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  /** The error for an attempt that lost its session while connecting: the failure the status callback recorded, else a generic one. */
  private supersededError(): PoolError {
    const { state, detail } = this.current;
    return isFailureState(state)
      ? new PoolError(state, detail)
      : new PoolError("failed", "the session closed while connecting");
  }

  private onStatus(gen: number, s: SessionStatus, reason?: string, code?: number): void {
    if (gen !== this.gen) return;
    switch (s) {
      case "active":
        this.setState({ state: "active" });
        this.armIdle();
        return;
      case "reconnecting":
        this.setState({ state: "reconnecting", detail: reason });
        return;
      case "failed":
        this.fail(code, reason);
        return;
      default:
        // "connecting" is already our state, and "closed" only follows a stop() we asked for.
        return;
    }
  }

  /** The session is gone for good: remember why and drop every lease. */
  private fail(code: number | undefined, reason: string | undefined): void {
    const session = this.session;
    this.session = undefined;
    this.gen++;
    this.streams = 0;
    this.holds = 0;
    this.clearIdle();
    this.setState({ state: stateForCloseCode(code), detail: reason });
    void session?.stop().catch(() => undefined);
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.stopped || !this.session || this.current.state !== "active") return;
    if (this.streams > 0 || this.holds > 0 || this.connecting) return;
    const gen = this.gen;
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = undefined;
      if (gen !== this.gen || this.streams > 0 || this.holds > 0) return;
      void this.closeIdle();
    }, this.idleMs);
  }

  private async closeIdle(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.gen++;
    this.setState({ state: "ready" });
    await session?.stop().catch(() => undefined);
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) {
      this.timers.clear(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private setState(next: PoolState): void {
    if (this.current.state === next.state && this.current.detail === next.detail) return;
    this.current = next;
    for (const fn of [...this.listeners]) fn(next);
  }
}
