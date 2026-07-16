/**
 * The CLI's public exit-code contract.
 *
 * Scripts and pipelines are told they can branch on these, so treat them as
 * API: changing what a code means is a breaking change. Mirrored in the docs at
 * https://docs.reoclo.com/cli/ci-automation/#exit-codes — keep both in sync.
 *
 * The split that matters: AUTH (3) is "we don't know who you are", DENIED (4)
 * is "we know, and no". RESOLUTION_FAILED (6) exists because `reoclo run` passes
 * the child's exit code straight through — reusing GENERIC (1) made a failed
 * secret resolution indistinguishable from a child script that merely exited 1.
 */
export const EXIT = {
  /** Success, or the child exited 0. */
  SUCCESS: 0,
  /** Anything without a more specific code. Also the fallback in `index.ts`. */
  GENERIC: 1,
  /** Bad arguments, unknown command. */
  MISUSE: 2,
  /** Authentication failed: token invalid, expired, or absent (HTTP 401). */
  AUTH: 3,
  /** Authorization failed: authenticated but not permitted (HTTP 403), or the
   *  command is not allowed for this key type. */
  DENIED: 4,
  /** The requested resource does not exist (HTTP 404). */
  NOT_FOUND: 5,
  /** `reoclo run` could not resolve secrets, so the child was never started. */
  RESOLUTION_FAILED: 6,
  /** The control plane was unreachable: connection refused, DNS failure, or timeout. */
  NETWORK: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
