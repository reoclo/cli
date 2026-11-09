// tests/helpers/events.ts
//
// Read the daemon's event stream until a marker shows up. Subscribe first, then
// trigger the action: the stream registers its listener before the response
// headers arrive, so nothing sent after `subscribe` resolves can be missed.

export async function readUntil(res: Response, needle: string, timeoutMs = 5000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (!text.includes(needle)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/** Resolves once the stream is open; `text` resolves with what was read up to `needle`. */
export async function subscribe(socket: string, needle: string, timeoutMs = 5000): Promise<{ text: Promise<string> }> {
  const res = await fetch("http://localhost/v1/events", { unix: socket });
  return { text: readUntil(res, needle, timeoutMs) };
}
