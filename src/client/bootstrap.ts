import { loadConfig } from "../config/store";
import { resolveStore } from "../config/token-store";
import { detectKeyType, type KeyType } from "./routing";
import { HttpClient } from "./http";

export interface ResolvedContext {
  client: HttpClient;
  profileName: string;
  api: string;
  token: string;
  tokenType: KeyType;
}

export interface BootstrapOptions {
  token?: string; // --token
  profile?: string; // --profile
  api?: string; // --api
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<ResolvedContext> {
  // Precedence:
  //   1. --token flag
  //   2. REOCLO_AUTOMATION_KEY env (more specific)
  //   3. REOCLO_API_KEY env (generic; routing inferred from prefix)
  //   4. ~/.reoclo/config.json active profile
  const flagToken = opts.token;
  const envAuto = process.env.REOCLO_AUTOMATION_KEY;
  const envGeneric = process.env.REOCLO_API_KEY;

  const cfg = await loadConfig();
  const profileName = opts.profile ?? process.env.REOCLO_PROFILE ?? cfg.active_profile;
  const profile = cfg.profiles[profileName];

  let token: string | undefined;
  if (flagToken) {
    token = flagToken;
  } else if (envAuto) {
    token = envAuto;
  } else if (envGeneric) {
    token = envGeneric;
  } else if (profile) {
    const store = await resolveStore();
    token = (await store.get(profileName)) ?? profile.token ?? undefined;
  }

  if (!token) {
    const err = new Error("not authenticated — run 'reoclo login'") as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }

  const api = opts.api ?? process.env.REOCLO_API_URL ?? profile?.api_url ?? "https://api.reoclo.com";
  const client = new HttpClient({ baseUrl: api, token });
  return {
    client,
    profileName,
    api,
    token,
    tokenType: detectKeyType(token),
  };
}
