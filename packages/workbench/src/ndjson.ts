export interface ReadNdjsonByteFramesOptions {
  readonly maxFrameBytes: number;
  readonly onFrame: (bytes: Uint8Array) => void;
  /** Called when the stream ends with bytes that never saw a terminating newline. */
  readonly onIncomplete: (bytes: Uint8Array) => void;
  readonly onLimitExceeded: () => void;
  readonly signal?: AbortSignal;
}

/**
 * Assembles newline-delimited frames from a byte reader. A complete frame is
 * every span between `0x0a` bytes; leftover bytes after the stream ends are
 * reported as one trailing frame so callers can reject or emit them.
 */
export const readNdjsonByteFrames = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: ReadNdjsonByteFramesOptions,
): Promise<void> => {
  const parts: Uint8Array[] = [];
  let partBytes = 0;
  const append = (part: Uint8Array): void => {
    if (partBytes + part.byteLength > options.maxFrameBytes) options.onLimitExceeded();
    if (part.byteLength > 0) parts.push(part);
    partBytes += part.byteLength;
  };
  const takeFrame = (): Uint8Array => {
    const bytes = new Uint8Array(partBytes);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    parts.length = 0;
    partBytes = 0;
    return bytes;
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (options.signal?.aborted) return;
    let start = 0;
    for (let index = 0; index < chunk.value.byteLength; index += 1) {
      if (chunk.value[index] !== 0x0a) continue;
      append(chunk.value.subarray(start, index));
      options.onFrame(takeFrame());
      if (options.signal?.aborted) return;
      start = index + 1;
    }
    append(chunk.value.subarray(start));
  }
  if (partBytes > 0) options.onIncomplete(takeFrame());
};

export interface ReadNdjsonResponseFramesOptions {
  /** Error for oversized frames and, unless overridden, missing bodies and incomplete trailing frames. */
  readonly invalidFrameError: () => Error;
  readonly maxFrameBytes: number;
  /** Replaces `invalidFrameError` for a response that carries no body. */
  readonly missingBodyError?: () => Error;
  /** Receives trailing bytes with no terminating newline; defaults to throwing `invalidFrameError`. */
  readonly onIncomplete?: (bytes: Uint8Array) => void;
  readonly signal: AbortSignal;
}

/**
 * Reads one NDJSON response body frame by frame: rejects a missing body, owns
 * the reader, cancels it when `signal` aborts so pending reads settle, and
 * always releases it. A trailing incomplete frame after an abort is dropped,
 * matching the frame-drop behavior `readNdjsonByteFrames` applies on abort.
 */
export const readNdjsonResponseFrames = async (
  response: Response,
  onFrame: (bytes: Uint8Array) => void,
  options: ReadNdjsonResponseFramesOptions,
): Promise<void> => {
  if (response.body === null) throw (options.missingBodyError ?? options.invalidFrameError)();
  const reader = response.body.getReader();
  const cancelReader = (): void => { void reader.cancel().catch(() => undefined); };
  options.signal.addEventListener('abort', cancelReader, { once: true });
  if (options.signal.aborted) cancelReader();
  try {
    await readNdjsonByteFrames(reader, {
      maxFrameBytes: options.maxFrameBytes,
      onFrame,
      onIncomplete: (bytes) => {
        if (options.signal.aborted) return;
        if (options.onIncomplete === undefined) throw options.invalidFrameError();
        options.onIncomplete(bytes);
      },
      onLimitExceeded: () => { throw options.invalidFrameError(); },
      signal: options.signal,
    });
  } finally {
    options.signal.removeEventListener('abort', cancelReader);
    try {
      await reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  }
};

export interface NdjsonStream {
  close(): void;
  readonly done: Promise<void>;
}

/**
 * Owns the per-stream AbortController, forwards an optional caller signal into
 * it, and detaches that forwarding once the stream settles.
 */
export const abortableNdjsonStream = (
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<void>,
): NdjsonStream => {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  return Object.freeze({
    close: () => controller.abort(),
    done: run(controller.signal).finally(() => signal?.removeEventListener('abort', forwardAbort)),
  });
};
