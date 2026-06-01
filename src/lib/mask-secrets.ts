// src/lib/mask-secrets.ts
//
// Mask sensitive values in `containers inspect` output. A running container's
// env vars routinely hold live production secrets — database connection
// strings, cloud access keys, third-party API tokens. Printing them in
// plaintext means a single `inspect` can dump prod secrets to a terminal,
// shell history, log file, or CI artifact.
//
// So `reoclo containers inspect` masks every env VALUE by default (keys stay
// visible, per the "show keys only" request) and `--show-secrets` opts back in
// to the raw values for the rare case where the operator genuinely needs them.

/** Replacement token shown in place of a hidden secret value. */
export const SECRET_MASK = "***";

export interface EnvVarLike {
  key: string;
  value: string;
  [k: string]: unknown;
}

/**
 * Return a copy of `envVars` with every `value` replaced by {@link SECRET_MASK}.
 * Keys (and any extra fields on each entry) are preserved so the caller can
 * still see WHICH variables are set without exposing their values. Pure — the
 * input array and its entries are never mutated.
 */
export function maskEnvVars<T extends EnvVarLike>(envVars: readonly T[]): T[] {
  return envVars.map((e) => ({ ...e, value: SECRET_MASK }));
}

/**
 * Apply env-var masking to a container inspect response unless `showSecrets`
 * is set. Returns the (possibly cloned) response plus `hiddenCount` — the
 * number of env values masked — so callers can print a
 * "N hidden — pass --show-secrets to reveal" hint. `hiddenCount` is 0 when
 * `showSecrets` is true or there are no env vars. The original response object
 * is never mutated.
 */
export function maskInspectResponse<R extends { env_vars?: EnvVarLike[] }>(
  response: R,
  showSecrets: boolean,
): { response: R; hiddenCount: number } {
  const envVars = response.env_vars ?? [];
  if (showSecrets || envVars.length === 0) {
    return { response, hiddenCount: 0 };
  }
  return {
    response: { ...response, env_vars: maskEnvVars(envVars) },
    hiddenCount: envVars.length,
  };
}
