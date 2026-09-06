import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';

import { isLoopbackHttpOrigin } from '../../core/loopback-origin.ts';
import {
  EVENT_TRACE_RECEIPT_MAX_BYTES,
  EVENT_TRACE_RECEIPT_PATH,
  EVENT_TRACE_RECEIPT_TOKEN_ENV,
  EVENT_TRACE_RECEIPT_URL_ENV,
  eventTraceReceiptEndpointPath,
  type EventTraceReceiptEndpoint,
} from '../../events/trace-receipt.ts';
import { diagnostic, rawPathname, readJsonBody, requestError, responseDiagnostic, singleHeader } from '../http.ts';
import type { TraceEntryInput } from '../trace/trace-entry.ts';
import type { TracePublisher } from '../trace/trace-hub.ts';
import {
  decodeHookReceipt,
  HOOK_RECEIPT_MALFORMED_CODE,
  HOOK_RECEIPT_TOO_LARGE_CODE,
  HOOK_RECEIPT_UNAUTHORIZED_CODE,
  HookReceiptDecodeError,
  lowerHookReceipt,
} from './hook-receipts.ts';

/**
 * Host hook receipts use a per-server bearer token published in the
 * owner-only endpoint record. Browser origins and non-loopback peers are
 * refused independently of the Workbench session guard.
 */

const loopbackAddresses: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const unauthorized = (message: string): never => {
  throw requestError(diagnostic(HOOK_RECEIPT_UNAUTHORIZED_CODE, message, 403));
};

const bearerToken = (request: IncomingMessage): string | undefined => {
  const header = singleHeader(request.headers.authorization);
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/u.exec(header);
  return match?.[1];
};

const sameToken = (expected: string, actual: string): boolean => {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

export interface HookReceiptRoutesOptions {
  readonly token: string;
  readonly trace: TracePublisher;
}

export class HookReceiptRoutes {
  readonly #token: string;
  readonly #trace: TracePublisher;
  #closed = false;

  constructor(options: HookReceiptRoutesOptions) {
    this.#token = options.token;
    this.#trace = options.trace;
  }

  close(): void {
    this.#closed = true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (rawPathname(request.url) !== EVENT_TRACE_RECEIPT_PATH) return false;
    this.#authorize(request);
    if ((request.method ?? 'GET') !== 'POST') {
      responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return true;
    }
    if (this.#closed) throw requestError(diagnostic(HOOK_RECEIPT_UNAUTHORIZED_CODE, 'Hook receipts are not accepted.', 409));
    if (new URL(request.url ?? '/', 'http://localhost').searchParams.size > 0) {
      throw requestError(diagnostic(HOOK_RECEIPT_MALFORMED_CODE, 'Hook receipt request has an invalid shape.', 400));
    }
    const body = await readJsonBody(request, {
      invalidShape: () => {
        throw requestError(diagnostic(HOOK_RECEIPT_MALFORMED_CODE, 'Hook receipt request has an invalid shape.', 400));
      },
      read: {
        code: HOOK_RECEIPT_TOO_LARGE_CODE,
        limit: EVENT_TRACE_RECEIPT_MAX_BYTES,
        message: 'Hook receipt exceeds 16 KiB.',
      },
    });
    let entries: readonly TraceEntryInput[];
    try {
      entries = lowerHookReceipt(decodeHookReceipt(body));
    } catch (error) {
      if (error instanceof HookReceiptDecodeError) {
        throw requestError(diagnostic(HOOK_RECEIPT_MALFORMED_CODE, error.message, 400));
      }
      throw error;
    }
    for (const entry of entries) this.#trace.publish(entry);
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return true;
  }

  #authorize(request: IncomingMessage): void {
    const peer = request.socket.remoteAddress;
    if (peer === undefined || !loopbackAddresses.has(peer)) unauthorized('Hook receipts are accepted from loopback only.');
    if (singleHeader(request.headers.origin) !== undefined) unauthorized('Hook receipts are not accepted from a browser.');
    const token = bearerToken(request);
    if (token === undefined || !sameToken(this.#token, token)) unauthorized('A valid hook receipt token is required.');
  }
}

export interface AttachHookReceiptsOptions {
  /** The project whose dev server this is; the endpoint record lands under its `.agent-bundle/`. */
  readonly projectRoot: string;
  /** Test seam; production mints 32 random bytes. */
  readonly token?: string;
  readonly trace: TracePublisher;
}

export interface HookReceiptAttachment {
  /** Closes the route (further posts are refused) and removes the endpoint record. */
  close(): Promise<void>;
  /** Environment a dev-server-spawned hook simulation inherits so its wrapper reports here. */
  environment(url: string): Readonly<Record<string, string>>;
  /**
   * Writes `<projectRoot>/.agent-bundle/hook-receipts.json` so the wrappers of
   * attached hosts find this server. Call once the foreground URL is known
   * (beside `devLock.publishServerUrl`); rewrite on a new URL.
   */
  publishEndpoint(url: string): Promise<void>;
  readonly routes: HookReceiptRoutes;
  readonly token: string;
}

export const attachHookReceipts = (options: AttachHookReceiptsOptions): HookReceiptAttachment => {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const routes = new HookReceiptRoutes({ token, trace: options.trace });
  const recordPath = eventTraceReceiptEndpointPath(resolve(options.projectRoot));
  const endpoint = (url: string): EventTraceReceiptEndpoint => {
    if (!isLoopbackHttpOrigin(url)) {
      throw new TypeError(`Hook receipt endpoint must be a loopback HTTP origin, got ${JSON.stringify(url)}.`);
    }
    return { token, url };
  };
  const attachment: HookReceiptAttachment = {
    close: async () => {
      routes.close();
      await rm(recordPath, { force: true });
    },
    environment: (url) => {
      const target = endpoint(url);
      return Object.freeze({
        [EVENT_TRACE_RECEIPT_TOKEN_ENV]: target.token,
        [EVENT_TRACE_RECEIPT_URL_ENV]: target.url,
      });
    },
    publishEndpoint: async (url) => {
      const target = endpoint(url);
      await mkdir(dirname(recordPath), { recursive: true });
      // `mode` applies on creation only: replace rather than overwrite a record with wider permissions.
      await rm(recordPath, { force: true });
      await writeFile(recordPath, `${JSON.stringify({ token: target.token, url: target.url })}\n`, { mode: 0o600 });
    },
    routes,
    token,
  };
  return Object.freeze(attachment);
};
