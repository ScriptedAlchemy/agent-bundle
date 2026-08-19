export interface ReadNdjsonByteFramesOptions {
  readonly maxFrameBytes: number;
  readonly onFrame: (bytes: Uint8Array) => void;
  /** Called when the stream ends with bytes that never saw a terminating newline. */
  readonly onIncomplete: () => void;
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
  if (partBytes > 0) options.onIncomplete();
};
