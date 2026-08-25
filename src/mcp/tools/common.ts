/**
 * Shared tool utilities for formatting results and errors.
 */

import { ApiError } from "../../client/errors";
import type { McpRegistrationContext, OrgParamShape } from "./context";

export function asToolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function asToolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  if (error instanceof ApiError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "API request failed",
              status: error.status,
              message: error.message,
              path: error.path,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/**
 * The host's org fragment with every entry made optional. `whoami` uses it so
 * the hosted head can answer without an organization (it is the discovery
 * tool) while the CLI, whose fragment is empty, still exposes nothing.
 */
export function optionalOrgParam(ctx: McpRegistrationContext): OrgParamShape {
  return Object.fromEntries(
    Object.entries(ctx.orgParam).map(([key, schema]) => [key, schema.optional()]),
  );
}
