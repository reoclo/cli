/**
 * Shared tool utilities for formatting results and errors.
 */

import { ApiError } from "../../client/errors";

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
