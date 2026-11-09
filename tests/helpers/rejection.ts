// tests/helpers/rejection.ts
//
// `await expect(p).rejects...` trips the repo's await-thenable lint rule, so
// tests turn a rejection into a value and assert on that.

/** The error `p` rejects with. Fails when `p` resolves. */
export async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the promise to reject");
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
