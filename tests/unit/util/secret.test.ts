import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Interface as ReadlineInterface } from "node:readline";
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

test("promptMasked restores process.stdout.write when readline closes without answer", async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const origWrite = process.stdout.write;

  // Force a TTY so readSecret doesn't reject before reaching the prompt.
  const wasTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;

  // Inject a fake readline.createInterface that emits 'close' before answer fires.
  const { promptMasked } = await import("../../../src/util/secret");

  const promise = promptMasked("test-label", {
    createInterface: () => {
      const ee = new EventEmitter() as EventEmitter & {
        question: (label: string, cb: (answer: string) => void) => void;
        close: () => void;
      };
      ee.question = (_label, _cb) => {
        // Defer the close so the muted=true assignment after rl.question() runs first.
        setImmediate(() => ee.emit("close"));
      };
      ee.close = () => {
        ee.emit("close");
      };
      return ee as unknown as ReadlineInterface;
    },
  });

  // eslint-disable-next-line @typescript-eslint/await-thenable
  await expect(promise).rejects.toBeInstanceOf(Error);
  // eslint-disable-next-line @typescript-eslint/unbound-method
  expect(process.stdout.write).toBe(origWrite);

  process.stdin.isTTY = wasTTY;
});
