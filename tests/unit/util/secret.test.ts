import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readSecretFromStream, MissingSecretError } from "../../../src/util/secret";

function streamFrom(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

describe("readSecretFromStream", () => {
  test("reads stdin to EOF and strips trailing newline", async () => {
    const result = await readSecretFromStream(streamFrom("hunter2\n"));
    expect(result).toBe("hunter2");
  });

  test("reads stdin without trailing newline", async () => {
    const result = await readSecretFromStream(streamFrom("hunter2"));
    expect(result).toBe("hunter2");
  });

  test("strips only trailing newlines, preserves middle whitespace", async () => {
    const result = await readSecretFromStream(streamFrom("hun ter2\n"));
    expect(result).toBe("hun ter2");
  });

  test("strips trailing \\r\\n", async () => {
    const result = await readSecretFromStream(streamFrom("hunter2\r\n"));
    expect(result).toBe("hunter2");
  });

  test("empty stdin throws MissingSecretError", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(readSecretFromStream(streamFrom(""))).rejects.toBeInstanceOf(MissingSecretError);
  });

  test("whitespace-only stdin throws MissingSecretError", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(readSecretFromStream(streamFrom("\n"))).rejects.toBeInstanceOf(MissingSecretError);
  });
});
