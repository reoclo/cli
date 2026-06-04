// src/ui/format-role.ts
//
// Humanize server role strings (snake_case / kebab-case) for display. Mirrors
// the web humanizer in auth/src/lib/oauth-client.ts:formatRole so the CLI and
// console render roles the same way. Display-only — never feed the result back
// to the API.
export function formatRole(role: string): string {
  return role
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
