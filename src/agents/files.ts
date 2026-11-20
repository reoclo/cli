// src/agents/files.ts
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { AgentConfigError } from "./errors";

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isMissing = (e: unknown): boolean => e instanceof Error && "code" in e && e.code === "ENOENT";

/** The file's text, or undefined when it does not exist. */
export function readConfig(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (isMissing(e)) return undefined;
    if (e instanceof Error) throw new AgentConfigError("unreadable", `cannot read ${path}: ${reasonOf(e)}`);
    throw e;
  }
}

/**
 * Replaces the file atomically (temp file in the same directory, then rename),
 * following a symlinked config to its target so dotfile setups keep their link.
 * The first change to an existing file also keeps a copy beside it. Returns the
 * backup path when this call made one.
 */
export function writeConfig(path: string, text: string): string | null {
  const target = existsSync(path) ? realpathSync(path) : path;
  const temp = join(dirname(target), `.${basename(target)}.reoclo-${process.pid}.tmp`);
  const backup = `${target}.reoclo-backup`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const existed = existsSync(target);
    if (existed) accessSync(target, constants.W_OK);
    const mode = existed ? statSync(target).mode & 0o777 : 0o600;
    writeFileSync(temp, text, { mode });
    const backedUp = existed && !existsSync(backup);
    if (backedUp) copyFileSync(target, backup, constants.COPYFILE_EXCL);
    renameSync(temp, target);
    return backedUp ? backup : null;
  } catch (e) {
    rmSync(temp, { force: true });
    if (e instanceof Error) throw new AgentConfigError("unwritable", `cannot write ${path}: ${reasonOf(e)}`);
    throw e;
  }
}
