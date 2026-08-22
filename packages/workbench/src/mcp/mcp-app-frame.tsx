import React, { useEffect, useRef } from 'react';

import type {
  McpAppJsonValue,
  McpAppRelayFrame,
  McpAppRouteClose,
  McpAppRouteMessages,
} from './mcp-app-client.ts';

const proxyReadyMethod = 'ui/notifications/sandbox-proxy-ready';
const resourceReadyMethod = 'ui/notifications/sandbox-resource-ready';
const closedRelay = Promise.resolve();

export interface McpAppFrameMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export type McpAppFrameMessageListener = (event: McpAppFrameMessageEvent) => void;

export interface McpAppFrameTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface McpAppFrameIframe {
  readonly contentWindow: McpAppFrameTarget | null;
}

export interface McpAppFrameWindow {
  addEventListener(type: 'message', listener: McpAppFrameMessageListener): void;
  removeEventListener(type: 'message', listener: McpAppFrameMessageListener): void;
}

export interface McpAppFrameRelayRoutes {
  close(bindingId: string, options: Readonly<{ readonly id: string; readonly reason: string }>): Promise<McpAppRouteClose>;
  forceClose(bindingId: string): Promise<boolean>;
  message(bindingId: string, message: McpAppJsonValue): Promise<McpAppRouteMessages>;
}

export interface McpAppFrameRelayOptions {
  readonly bindingId: string;
  readonly closeTimeoutMs?: number;
  readonly frame: McpAppRelayFrame;
  readonly iframe: McpAppFrameIframe;
  readonly onError?: (error: McpAppFrameRelayError) => void;
  readonly resource: McpAppJsonValue;
  readonly routes: McpAppFrameRelayRoutes;
  readonly window: McpAppFrameWindow;
}

export interface McpAppFrameProps {
  readonly bindingId: string;
  readonly closeTimeoutMs?: number;
  readonly frame: McpAppRelayFrame;
  readonly onError?: (error: McpAppFrameRelayError) => void;
  readonly resource: McpAppJsonValue;
  readonly routes: McpAppFrameRelayRoutes;
  readonly title?: string;
}

type RelayState = 'closed' | 'closing' | 'open';

interface CanonicalResource {
  readonly csp?: McpAppJsonValue;
  readonly html: string;
  readonly permissions?: McpAppJsonValue;
}

interface RpcMessage extends Readonly<Record<string, McpAppJsonValue | undefined>> {
  readonly id?: McpAppJsonValue;
  readonly jsonrpc: '2.0';
  readonly method?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const byteLength = (value: unknown): number | undefined => {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? new TextEncoder().encode(encoded).byteLength : undefined;
  } catch {
    return undefined;
  }
};

const validRequestId = (value: unknown): boolean =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

const asMessage = (value: unknown, maximumBytes: number): RpcMessage | undefined => {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || Object.hasOwn(value, 'bindingId')) return undefined;
  const size = byteLength(value);
  if (size === undefined || size > maximumBytes) return undefined;
  const hasMethod = typeof value.method === 'string' && value.method.length > 0;
  const hasId = Object.hasOwn(value, 'id') && validRequestId(value.id);
  const hasResponse = hasId && !hasMethod && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'));
  if (!hasMethod && !hasResponse) return undefined;
  return value as RpcMessage;
};

const resource = (value: McpAppJsonValue): CanonicalResource => {
  if (!isRecord(value) || value.kind !== 'resource' || typeof value.html !== 'string') {
    throw new McpAppFrameRelayError('MCP App preview does not contain a canonical HTML resource.');
  }
  if (value.csp !== undefined && !isRecord(value.csp)) throw new McpAppFrameRelayError('MCP App preview resource has invalid CSP declarations.');
  if (value.permissions !== undefined && !isRecord(value.permissions)) throw new McpAppFrameRelayError('MCP App preview resource has invalid permission declarations.');
  return Object.freeze({
    ...(value.csp === undefined ? {} : { csp: value.csp as McpAppJsonValue }),
    html: value.html,
    ...(value.permissions === undefined ? {} : { permissions: value.permissions as McpAppJsonValue }),
  });
};

const messageForResource = (value: CanonicalResource): RpcMessage => Object.freeze({
  jsonrpc: '2.0',
  method: resourceReadyMethod,
  params: Object.freeze({
    ...(value.csp === undefined ? {} : { csp: value.csp }),
    html: value.html,
    ...(value.permissions === undefined ? {} : { permissions: value.permissions }),
  }),
});

const positiveTimeout = (value: number | undefined): number => {
  const timeout = value ?? 1_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new RangeError('MCP App frame close timeout must be an integer from 1 to 30000 ms.');
  }
  return timeout;
};

const opaqueBindingId = (value: string): string => {
  if (
    value.length === 0 || value.length > 4_096 || value.trim().length === 0 || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')
  ) throw new McpAppFrameRelayError('MCP App frame binding is not available.');
  return value;
};

const isProxyReady = (message: RpcMessage): boolean => message.method === proxyReadyMethod && !Object.hasOwn(message, 'id');

const isTeardownAcknowledgement = (message: RpcMessage, id: string): boolean =>
  !Object.hasOwn(message, 'method') && message.id === id && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'));

/** Security boundary between one sandbox proxy iframe and one opaque App binding. */
export class McpAppFrameRelay {
  readonly #bindingId: string;
  readonly #closeTimeoutMs: number;
  readonly #frame: McpAppRelayFrame;
  readonly #iframe: McpAppFrameIframe;
  readonly #onError: ((error: McpAppFrameRelayError) => void) | undefined;
  readonly #resource: CanonicalResource;
  readonly #routes: McpAppFrameRelayRoutes;
  readonly #window: McpAppFrameWindow;
  readonly #listener: McpAppFrameMessageListener;
  readonly #queue: (() => Promise<void>)[] = [];
  #closePromise: Promise<void> | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #finishClose: (() => void) | undefined;
  #forceClosePromise: Promise<void> | undefined;
  #listening = false;
  #processing = false;
  #resourceProvided = false;
  #state: RelayState = 'open';

  constructor(options: McpAppFrameRelayOptions) {
    this.#bindingId = opaqueBindingId(options.bindingId);
    this.#closeTimeoutMs = positiveTimeout(options.closeTimeoutMs);
    this.#frame = options.frame;
    this.#iframe = options.iframe;
    this.#onError = options.onError;
    this.#resource = resource(options.resource);
    this.#routes = options.routes;
    this.#window = options.window;
    this.#listener = (event) => { this.receive(event); };
  }

  get state(): RelayState {
    return this.#state;
  }

  start(): boolean {
    if (this.#state !== 'open' || this.#listening) return false;
    this.#window.addEventListener('message', this.#listener);
    this.#listening = true;
    return true;
  }

  receive(event: McpAppFrameMessageEvent): boolean {
    const proxy = this.#iframe.contentWindow;
    if (proxy === null || event.source !== proxy || event.origin !== this.#frame.targetOrigin || this.#state === 'closed') return false;
    const message = asMessage(event.data, this.#frame.relay.maxMessageBytes);
    if (message === undefined) return false;
    if (this.#state === 'closing') {
      const teardownId = this.#teardownId();
      if (!isTeardownAcknowledgement(message, teardownId)) return false;
      return this.#enqueue(() => this.#deliver(message));
    }
    if (isProxyReady(message)) {
      if (this.#resourceProvided) return false;
      this.#resourceProvided = true;
      return this.#post(messageForResource(this.#resource));
    }
    if (!this.#resourceProvided) return false;
    return this.#enqueue(() => this.#deliver(message));
  }

  close(): Promise<void> {
    if (this.#state === 'closed') return closedRelay;
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = 'closing';
    this.#closePromise = new Promise<void>((resolve) => { this.#finishClose = resolve; });
    this.#closeTimer = setTimeout(() => { void this.#forceClose(); }, this.#closeTimeoutMs);
    this.#enqueue(() => this.#beginClose(), true);
    return this.#closePromise;
  }

  #enqueue(operation: () => Promise<void>, essential = false): boolean {
    if (this.#state === 'closed') return false;
    const occupied = this.#queue.length + Number(this.#processing);
    if (!essential && occupied >= this.#frame.relay.maxQueuedMessages) {
      this.#report(new McpAppFrameRelayError('MCP App frame relay queue is full.'));
      return false;
    }
    this.#queue.push(operation);
    void this.#drain();
    return true;
  }

  async #drain(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#queue.length > 0) {
        const operation = this.#queue.shift();
        if (operation === undefined) continue;
        try {
          await operation();
        } catch (cause) {
          this.#report(new McpAppFrameRelayError('MCP App frame relay operation failed.', cause));
          if (this.#state === 'closing') await this.#forceClose();
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  async #deliver(message: RpcMessage): Promise<void> {
    const response = await this.#routes.message(this.#bindingId, message as McpAppJsonValue);
    if (this.#state === 'closed') return;
    this.#postAll(response.messages);
    if (response.lifecycle === 'closed') this.#completeClose();
  }

  async #beginClose(): Promise<void> {
    try {
      const response = await this.#routes.close(this.#bindingId, {
        id: this.#teardownId(),
        reason: 'MCP App frame unmounted.',
      });
      if (this.#state === 'closed') return;
      if (response.message !== undefined) this.#postOne(response.message);
      if (response.lifecycle === 'closed') {
        this.#completeClose();
        return;
      }
    } catch (cause) {
      if (this.#state === 'closed') return;
      this.#report(new McpAppFrameRelayError('MCP App graceful close failed.', cause));
      await this.#forceClose();
    }
  }

  #forceClose(): Promise<void> {
    if (this.#state === 'closed') return closedRelay;
    if (this.#forceClosePromise !== undefined) return this.#forceClosePromise;
    if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer);
    this.#closeTimer = undefined;
    this.#forceClosePromise = Promise.resolve().then(async () => {
      try {
        await this.#routes.forceClose(this.#bindingId);
      } catch (cause) {
        this.#report(new McpAppFrameRelayError('MCP App force close failed.', cause));
      } finally {
        this.#completeClose();
      }
    });
    return this.#forceClosePromise;
  }

  #postAll(messages: readonly McpAppJsonValue[]): void {
    for (const message of messages) {
      this.#postOne(message);
    }
  }

  #postOne(message: McpAppJsonValue): void {
    const validated = asMessage(message, this.#frame.relay.maxMessageBytes);
    if (validated === undefined) throw new McpAppFrameRelayError('MCP App route returned an invalid frame.');
    if (!this.#post(validated)) throw new McpAppFrameRelayError('MCP App proxy window is not available.');
  }

  #post(message: RpcMessage): boolean {
    const proxy = this.#iframe.contentWindow;
    const size = byteLength(message);
    if (proxy === null || size === undefined || size > this.#frame.relay.maxMessageBytes) return false;
    try {
      proxy.postMessage(message, this.#frame.targetOrigin);
      return true;
    } catch (cause) {
      this.#report(new McpAppFrameRelayError('MCP App proxy postMessage failed.', cause));
      return false;
    }
  }

  #completeClose(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#queue.length = 0;
    if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer);
    this.#closeTimer = undefined;
    if (this.#listening) this.#window.removeEventListener('message', this.#listener);
    this.#listening = false;
    this.#finishClose?.();
    this.#finishClose = undefined;
  }

  #teardownId(): string {
    return `mcp-app-frame-close:${this.#bindingId}`;
  }

  #report(error: McpAppFrameRelayError): void {
    try {
      this.#onError?.(error);
    } catch {
      // Error observers never disrupt isolation or cleanup.
    }
  }
}

export class McpAppFrameRelayError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'McpAppFrameRelayError';
    this.cause = cause;
  }
}

export const createMcpAppFrameRelay = (options: McpAppFrameRelayOptions): McpAppFrameRelay => new McpAppFrameRelay(options);

/** A browser-owned iframe that receives only the server-issued proxy URL. */
export const McpAppFrame = ({ bindingId, closeTimeoutMs, frame, onError, resource: previewResource, routes, title = 'MCP App preview' }: McpAppFrameProps) => {
  const iframe = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const current = iframe.current;
    if (current === null) return undefined;
    const relay = createMcpAppFrameRelay({
      bindingId,
      ...(closeTimeoutMs === undefined ? {} : { closeTimeoutMs }),
      frame,
      iframe: current,
      ...(onError === undefined ? {} : { onError }),
      resource: previewResource,
      routes,
      window,
    });
    relay.start();
    return () => { void relay.close(); };
  }, [bindingId, closeTimeoutMs, frame, onError, previewResource, routes]);
  return <iframe allow={frame.allow} ref={iframe} referrerPolicy={frame.referrerPolicy} sandbox={frame.sandbox} src={frame.src} title={title} />;
};
