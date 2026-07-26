/**
 * Line-oriented stream readers shared by the remote adapters.
 *
 * Both formats in use here are newline-framed, and both have the same trap:
 * a chunk boundary can land in the middle of a line, and in the middle of a
 * multi-byte UTF-8 character. `TextDecoder({stream:true})` handles the second;
 * buffering until a `\n` handles the first. Getting either wrong produces
 * corrupted text only under load, which is the worst way to find out.
 */

export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** NDJSON: one JSON value per line. Ollama and the SplitLLM backend speak this. */
export async function* readNdjson<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of readLines(body)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      /* a server logging a plain-text line mid-stream must not abort the read */
    }
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Server-Sent Events, as used by OpenAI and Anthropic.
 *
 * `data: [DONE]` is OpenAI's terminator and is not JSON; it is yielded as-is so
 * the caller decides, rather than being swallowed here where a future protocol
 * change would be invisible.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  const dataLines: string[] = [];

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      event = undefined;
      return undefined;
    }
    const out: SseEvent = { event, data: dataLines.join('\n') };
    dataLines.length = 0;
    event = undefined;
    return out;
  };

  for await (const line of readLines(body)) {
    if (line === '') {
      const ev = flush();
      if (ev) yield ev;
      continue;
    }
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  const last = flush();
  if (last) yield last;
}
