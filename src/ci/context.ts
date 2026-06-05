/** CI/CD context metadata for the automation API audit trail. Mirrors the
 *  api `RunContext` schema (provider is a free-form string). */
export interface RunContext {
  provider: string; // github_actions | gitea_actions | woodpecker | cli
  repository: string;
  workflow: string;
  trigger: string;
  actor: string;
  sha?: string;
  ref?: string;
}

export interface CiContext {
  runContext: RunContext;
  /** Provider run/pipeline id, forwarded as `run_id`. */
  runId?: string;
  /** Origin of the SCM host hosting the repo, e.g. "https://github.com" or
   *  "https://git.boxpositron.dev". Empty string when undeterminable. */
  scmServerUrl: string;
}

type Env = Record<string, string | undefined>;

function originOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function detectCiContext(env: Env = process.env): CiContext {
  // Gitea's act_runner sets GITHUB_* AND GITEA_ACTIONS=true, so check Gitea first.
  if (
    env.GITEA_ACTIONS === "true" ||
    (env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_SERVER_URL &&
      originOf(env.GITHUB_SERVER_URL) !== "https://github.com")
  ) {
    return githubShaped(env, "gitea_actions");
  }
  if (env.GITHUB_ACTIONS === "true") {
    return githubShaped(env, "github_actions");
  }
  if (env.CI === "woodpecker" || env.WOODPECKER === "true") {
    return {
      runContext: {
        provider: "woodpecker",
        repository: env.CI_REPO ?? "",
        workflow: env.CI_WORKFLOW_NAME ?? env.CI_PIPELINE_EVENT ?? "",
        trigger: env.CI_PIPELINE_EVENT ?? "",
        actor: env.CI_COMMIT_AUTHOR ?? "",
        sha: env.CI_COMMIT_SHA,
        ref: env.CI_COMMIT_REF,
      },
      runId: env.CI_PIPELINE_NUMBER,
      scmServerUrl: env.CI_FORGE_URL ? originOf(env.CI_FORGE_URL) : originOf(env.CI_REPO_CLONE_URL),
    };
  }
  return {
    runContext: { provider: "cli", repository: "", workflow: "", trigger: "", actor: "" },
    scmServerUrl: "",
  };
}

function githubShaped(env: Env, provider: string): CiContext {
  return {
    runContext: {
      provider,
      repository: env.GITHUB_REPOSITORY ?? "",
      workflow: env.GITHUB_WORKFLOW ?? "",
      trigger: env.GITHUB_EVENT_NAME ?? "",
      actor: env.GITHUB_ACTOR ?? "",
      sha: env.GITHUB_SHA,
      ref: env.GITHUB_REF,
    },
    runId: env.GITHUB_RUN_ID,
    scmServerUrl: originOf(env.GITHUB_SERVER_URL),
  };
}
