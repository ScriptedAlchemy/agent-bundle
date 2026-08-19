import { Buffer } from 'node:buffer';
import type { ServerResponse } from 'node:http';

const encodedFrames = new WeakMap<object, string>();

export type StreamCacheControl = 'no-cache' | 'no-store';
export type BackpressuredWriteResult = 'ok' | 'closed' | 'overflow';

export interface KeepAliveStreamHeadOptions {
  readonly cacheControl: StreamCacheControl;
  readonly contentType: string;
}

export interface BackpressuredWriteOptions {
  readonly byteLimit: number;
  /** When true, a frame already handed to `write()` but not yet drained counts toward `byteLimit`. */
  readonly countInFlightBytes?: boolean;
  readonly recordLimit?: number;
  /** When true, a single frame larger than `byteLimit` overflows instead of being written. */
  readonly rejectOversizedFrame?: boolean;
}

export interface BackpressuredWriter {
  readonly closed: boolean;
  enqueue(frame: string): BackpressuredWriteResult;
  markClosed(): void;
}

/** Writes keep-alive / no-store stream headers and flushes them before the first frame. */
export const writeKeepAliveStreamHead = (
  response: ServerResponse,
  options: KeepAliveStreamHeadOptions,
): void => {
  response.writeHead(200, {
    'cache-control': options.cacheControl,
    connection: 'keep-alive',
    'content-type': options.contentType,
  });
  response.flushHeaders();
};

/**
 * Cache the encoded frame for a frozen message so each subscriber does not
 * restringify the same object.
 */
export const encodedFrame = (message: object, encode: () => string): string => {
  const cached = encodedFrames.get(message);
  if (cached !== undefined) return cached;
  const frame = encode();
  encodedFrames.set(message, frame);
  return frame;
};

export const encodedNdjsonFrame = (message: unknown): string => {
  if (typeof message === 'object' && message !== null) {
    return encodedFrame(message, () => `${JSON.stringify(message)}\n`);
  }
  return `${JSON.stringify(message)}\n`;
};

/**
 * Immediate-write-or-queue backpressure used by NDJSON/SSE route streams.
 * Lifecycle (end vs destroy vs awaited finish) stays with the caller.
 */
export const createBackpressuredWriter = (
  response: ServerResponse,
  options: BackpressuredWriteOptions,
): BackpressuredWriter => {
  let backpressured = false;
  let closed = false;
  let inFlightBytes = 0;
  let queuedBytes = 0;
  const queued: Array<{ readonly bytes: number; readonly frame: string }> = [];

  const drain = (): void => {
    if (closed || response.writableEnded || response.destroyed) return;
    backpressured = false;
    inFlightBytes = 0;
    while (queued.length > 0) {
      const next = queued.shift();
      if (next === undefined) continue;
      queuedBytes -= next.bytes;
      if (!response.write(next.frame)) {
        backpressured = true;
        inFlightBytes = next.bytes;
        response.once('drain', drain);
        return;
      }
    }
  };

  return {
    get closed(): boolean {
      return closed;
    },
    markClosed(): void {
      closed = true;
      queued.length = 0;
      queuedBytes = 0;
      inFlightBytes = 0;
    },
    enqueue(frame: string): BackpressuredWriteResult {
      if (closed || response.writableEnded || response.destroyed) return 'closed';
      const bytes = Buffer.byteLength(frame, 'utf8');
      if (options.rejectOversizedFrame === true && bytes > options.byteLimit) return 'overflow';
      if (!backpressured) {
        if (!response.write(frame)) {
          backpressured = true;
          inFlightBytes = bytes;
          response.once('drain', drain);
        }
        return 'ok';
      }
      const used = (options.countInFlightBytes === true ? inFlightBytes : 0) + queuedBytes + bytes;
      if (used > options.byteLimit) return 'overflow';
      if (options.recordLimit !== undefined && queued.length >= options.recordLimit) return 'overflow';
      queued.push(Object.freeze({ bytes, frame }));
      queuedBytes += bytes;
      return 'ok';
    },
  };
};
