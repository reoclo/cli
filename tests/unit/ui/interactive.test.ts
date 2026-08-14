import { test, expect } from "bun:test";
import { isInteractive, confirmPrompt } from "../../../src/ui/interactive";

test("isInteractive is false when stdin is not a TTY", () => {
  // bun:test runs without a TTY on stdin.
  expect(isInteractive()).toBe(false);
});

test("confirmPrompt returns the fallback without prompting when non-interactive", async () => {
  expect(await confirmPrompt("Install skills?", { fallback: true })).toBe(true);
  expect(await confirmPrompt("Install skills?", { fallback: false })).toBe(false);
  expect(await confirmPrompt("Install skills?")).toBe(false); // default fallback
});
