// src/hostsd/hosts-file.ts
//
// Rewrite the hosts file the way the helper must: through a temp file in the
// same directory and a rename, keeping the owner and mode. On macOS /etc/hosts
// is a symlink into /private/etc, and a rename over a symlink would replace the
// link itself, so the real path is resolved first.

import { chmodSync, chownSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";

export interface RewriteResult {
  changed: boolean;
}

export function readHostsFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** Apply `edit` to the hosts file text and write it back atomically when it changed. */
export function rewriteHostsFile(path: string, edit: (text: string) => string): RewriteResult {
  let real = path;
  let mode = 0o644;
  let owner: { uid: number; gid: number } | undefined;
  try {
    real = realpathSync(path);
    const st = statSync(real);
    mode = st.mode & 0o7777;
    owner = { uid: st.uid, gid: st.gid };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const before = readHostsFile(real);
  const after = edit(before);
  if (after === before) return { changed: false };
  const tmp = `${real}.reoclo-tmp-${process.pid}`;
  writeFileSync(tmp, after, { mode });
  chmodSync(tmp, mode);
  if (owner) chownSync(tmp, owner.uid, owner.gid);
  renameSync(tmp, real);
  return { changed: true };
}
