import type { TokenStore } from "../token-store";

export class MemoryStore implements TokenStore {
  readonly kind = "memory" as const;
  private m = new Map<string, string>();
  get(p: string): Promise<string | null>   { return Promise.resolve(this.m.get(p) ?? null); }
  set(p: string, t: string): Promise<void> { this.m.set(p, t); return Promise.resolve(); }
  delete(p: string): Promise<void>         { this.m.delete(p); return Promise.resolve(); }
}
