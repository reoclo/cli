// tests/helpers/fake-pool.ts
//
// Fakes for the tunnel daemon's pool layer: a session that records what it was
// asked to do, a manual timer set, and a pool the manager tests can steer.

import type net from "node:net";
import type dgram from "node:dgram";
import { EventEmitter } from "node:events";
import type { ReadyState, ReverseSpec, SessionStatus } from "../../src/client/tunnel-session";
import type {
  PoolError,
  Lease,
  LeaseKind,
  PoolLike,
  PoolSession,
  PoolState,
  StatusCallback,
  Timers,
} from "../../src/tunnels/pool";

export class FakeSession implements PoolSession {
  started = false;
  stopped = false;
  attached: { sock: net.Socket; target: { remoteHost: string; remotePort: number } }[] = [];
  datagrams: { buf: Buffer; target: { remoteHost: string; remotePort: number }; listener: dgram.Socket }[] = [];
  reverses: { id: string; spec: ReverseSpec }[] = [];
  removedReverses: string[] = [];
  /** Echo every attached socket back to itself, like the gateway does in the integration tests. */
  echo = false;
  /** Hold start() until released. */
  startGate?: Promise<void>;
  startError?: Error;
  events = new EventEmitter();
  private nextReverse = 1;
  constructor(readonly onStatus: StatusCallback) {}

  async start(): Promise<ReadyState> {
    if (this.startGate) await this.startGate;
    if (this.startError) throw this.startError;
    this.started = true;
    return { forwards: [], reverses: [] };
  }
  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
  attachTcpSocket(sock: net.Socket, target: { remoteHost: string; remotePort: number }): void {
    this.attached.push({ sock, target });
    if (this.echo) sock.on("data", (b: Buffer) => sock.write(b));
    this.events.emit("attached");
  }
  forwardUdpDatagram(
    buf: Buffer,
    _rinfo: dgram.RemoteInfo,
    target: { remoteHost: string; remotePort: number },
    listener: dgram.Socket,
  ): void {
    this.datagrams.push({ buf, target, listener });
    this.events.emit("datagram");
  }
  addReverse(spec: ReverseSpec): Promise<string> {
    const id = `l-${this.nextReverse++}`;
    this.reverses.push({ id, spec });
    this.events.emit("reverse");
    return Promise.resolve(id);
  }
  removeReverse(id: string): void {
    this.removedReverses.push(id);
  }
  /** Drive the pool as TunnelSession would. */
  status(s: SessionStatus, reason?: string, code?: number): void {
    this.onStatus(s, reason, code);
  }
  waitFor(event: string, ok: () => boolean, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ok()) return resolve();
      const timer = setTimeout(() => {
        this.events.off(event, check);
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      const check = (): void => {
        if (!ok()) return;
        clearTimeout(timer);
        this.events.off(event, check);
        resolve();
      };
      this.events.on(event, check);
    });
  }
}

/** Timers a test fires by hand. */
export class ManualTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  readonly delays: number[] = [];
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    this.delays.push(ms);
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Fire every pending timer once. */
  fire(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, t] of due) t.fn();
  }
}

/** A pool the manager tests control directly. */
export class FakePool implements PoolLike {
  state: PoolState = { state: "ready" };
  streamCount = 0;
  holdCount = 0;
  session = new FakeSession(() => undefined);
  active = false;
  acquired: LeaseKind[] = [];
  released: LeaseKind[] = [];
  resets = 0;
  touches = 0;
  stopped = false;
  /** Hold acquire() until released, to prove callers wait for the session. */
  gate?: Promise<void>;
  error?: PoolError;
  events = new EventEmitter();
  private listeners = new Set<(s: PoolState) => void>();

  activeSession(): PoolSession | undefined {
    return this.active ? this.session : undefined;
  }
  async acquire(kind: LeaseKind): Promise<Lease> {
    this.acquired.push(kind);
    this.events.emit("acquire");
    if (this.gate) await this.gate;
    if (this.error) throw this.error;
    this.holdCount += kind === "hold" ? 1 : 0;
    this.streamCount += kind === "stream" ? 1 : 0;
    let done = false;
    return {
      session: this.session,
      release: () => {
        if (done) return;
        done = true;
        this.released.push(kind);
        this.events.emit("release");
      },
    };
  }
  touch(): void {
    this.touches++;
  }
  reset(): void {
    this.resets++;
  }
  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
  onChange(fn: (s: PoolState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Change the pool state and notify listeners. */
  setState(next: PoolState): void {
    this.state = next;
    this.active = next.state === "active";
    for (const fn of [...this.listeners]) fn(next);
  }
  waitFor(event: string, ok: () => boolean, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ok()) return resolve();
      const timer = setTimeout(() => {
        this.events.off(event, check);
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      const check = (): void => {
        if (!ok()) return;
        clearTimeout(timer);
        this.events.off(event, check);
        resolve();
      };
      this.events.on(event, check);
    });
  }
}
