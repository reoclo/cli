// src/util/git-remote.ts

/** `owner/name` from a git remote URL (https, ssh:// or scp style, `.git`
 *  optional), or null when the URL does not name a repository. */
export function parseGitRemote(remote: string): string | null {
  const trimmed = remote.trim();
  let path: string | null = null;
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(trimmed);
  const scp = /^[^@/\s]+@[^:/\s]+:(?!\/\/)(.+)$/.exec(trimmed);
  if (url) path = url[1] ?? null;
  else if (scp) path = scp[1] ?? null;
  if (path === null) return null;
  const segments = path
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  return segments.slice(-2).join("/");
}
