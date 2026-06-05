import { describe, expect, test } from "bun:test";
import { detectCiContext } from "../../src/ci/context";

describe("detectCiContext", () => {
  test("GitHub Actions", () => {
    const ci = detectCiContext({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_WORKFLOW: "deploy",
      GITHUB_EVENT_NAME: "push",
      GITHUB_ACTOR: "octocat",
      GITHUB_SHA: "abc123",
      GITHUB_REF: "refs/heads/main",
      GITHUB_RUN_ID: "42",
      GITHUB_SERVER_URL: "https://github.com",
    });
    expect(ci.runContext.provider).toBe("github_actions");
    expect(ci.runContext.repository).toBe("acme/app");
    expect(ci.runId).toBe("42");
    expect(ci.scmServerUrl).toBe("https://github.com");
  });

  test("Gitea Actions is distinguished from GitHub by GITEA_ACTIONS", () => {
    const ci = detectCiContext({
      GITHUB_ACTIONS: "true",
      GITEA_ACTIONS: "true",
      GITHUB_REPOSITORY: "reoclo/app",
      GITHUB_SHA: "def456",
      GITHUB_SERVER_URL: "https://git.boxpositron.dev",
      GITHUB_RUN_ID: "7",
    });
    expect(ci.runContext.provider).toBe("gitea_actions");
    expect(ci.scmServerUrl).toBe("https://git.boxpositron.dev");
  });

  test("Woodpecker maps CI_* vars and derives scmServerUrl from clone URL", () => {
    const ci = detectCiContext({
      CI: "woodpecker",
      CI_REPO: "reoclo/app",
      CI_PIPELINE_EVENT: "push",
      CI_COMMIT_AUTHOR: "dave",
      CI_COMMIT_SHA: "aaa111",
      CI_COMMIT_REF: "refs/heads/dev",
      CI_PIPELINE_NUMBER: "99",
      CI_REPO_CLONE_URL: "https://git.boxpositron.dev/reoclo/app.git",
    });
    expect(ci.runContext.provider).toBe("woodpecker");
    expect(ci.runContext.repository).toBe("reoclo/app");
    expect(ci.runId).toBe("99");
    expect(ci.scmServerUrl).toBe("https://git.boxpositron.dev");
  });

  test("no CI env → provider 'cli', empty scmServerUrl", () => {
    const ci = detectCiContext({});
    expect(ci.runContext.provider).toBe("cli");
    expect(ci.scmServerUrl).toBe("");
  });
});
