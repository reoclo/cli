export interface TokenStore {
  readonly kind: "keyring" | "file" | "memory";
  get(profile: string): Promise<string | null>;
  set(profile: string, token: string): Promise<void>;
  delete(profile: string): Promise<void>;
}
