import { describe, expect, test } from "bun:test";
import { parseGitRemote } from "../../../src/util/git-remote";

describe("parseGitRemote", () => {
  test("https with and without .git", () => {
    expect(parseGitRemote("https://github.com/acme/web.git")).toBe("acme/web");
    expect(parseGitRemote("https://github.com/acme/web")).toBe("acme/web");
    expect(parseGitRemote("https://github.com/acme/web/")).toBe("acme/web");
  });

  test("https with credentials and a port", () => {
    expect(parseGitRemote("https://user:token@git.example.com:3000/acme/web.git")).toBe(
      "acme/web",
    );
  });

  test("ssh scp style", () => {
    expect(parseGitRemote("git@github.com:acme/web.git")).toBe("acme/web");
    expect(parseGitRemote("git@git.example.com:acme/web")).toBe("acme/web");
  });

  test("ssh:// url", () => {
    expect(parseGitRemote("ssh://git@github.com/acme/web.git")).toBe("acme/web");
    expect(parseGitRemote("ssh://git@git.example.com:2222/acme/web.git")).toBe("acme/web");
  });

  test("keeps the last two path segments", () => {
    expect(parseGitRemote("https://git.example.com/group/acme/web.git")).toBe("acme/web");
  });

  test("returns null when the text names no repository", () => {
    expect(parseGitRemote("")).toBeNull();
    expect(parseGitRemote("acme/web")).toBeNull();
    expect(parseGitRemote("https://github.com/acme")).toBeNull();
    expect(parseGitRemote("/local/path/to/repo")).toBeNull();
  });
});
