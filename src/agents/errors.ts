// src/agents/errors.ts
import { EXIT } from "../client/exit-codes";
import { assertNever } from "./shared";

export type AgentConfigErrorKind =
  | "missing-agent"
  | "unreadable"
  | "unparsable"
  | "unsupported"
  | "unwritable"
  | "invalid-command";

/** A coding agent's config file that cannot be read or edited safely. Carries the CLI exit code. */
export class AgentConfigError extends Error {
  override readonly name = "AgentConfigError";
  readonly exitCode: number;

  constructor(
    readonly kind: AgentConfigErrorKind,
    message: string,
  ) {
    super(message);
    this.exitCode = exitCodeFor(kind);
  }
}

function exitCodeFor(kind: AgentConfigErrorKind): number {
  switch (kind) {
    case "missing-agent":
      return EXIT.NOT_FOUND;
    case "invalid-command":
      return EXIT.MISUSE;
    case "unreadable":
    case "unparsable":
    case "unsupported":
    case "unwritable":
      return EXIT.GENERIC;
    default:
      return assertNever(kind);
  }
}

/** Thrown by the format editors; the agent layer adds the path and rethrows as an AgentConfigError. */
export class ConfigFormatError extends Error {
  override readonly name = "ConfigFormatError";

  constructor(
    readonly kind: "unparsable" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}
