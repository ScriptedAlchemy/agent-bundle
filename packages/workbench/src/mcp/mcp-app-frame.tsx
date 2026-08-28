import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import type {
  McpAppJsonValue,
  McpAppRelayFrame,
  McpAppRouteClose,
  McpAppRouteMessages,
} from './mcp-app-client.ts';
import { assertCurrentMcpAppDocumentPolicy, type McpAppRuntimeClient, type McpAppTrustedDocumentPolicy } from './mcp-app-client.ts';
import { finiteOrdinaryJsonByteLength } from './finite-json.ts';
import { AppRenderer, type BridgeFactory, type AppRendererProps } from '../inspector/adapter/inspector-closure-vendor.js';

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

export interface SecureAppRendererProps {
  readonly bindingId: string;
  readonly bootstrapUrl: string;
  readonly bridgeFactory: BridgeFactory;
  readonly documentPolicy: McpAppTrustedDocumentPolicy;
  /** Opaque policy authority; never serialized or passed into the iframe. */
  readonly policyClient: Pick<McpAppRuntimeClient, 'currentDocumentPolicy'>;
  readonly rendererProps: Omit<AppRendererProps, 'bridgeFactory' | 'sandboxPath'>;
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

const validRequestId = (value: unknown): boolean =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

const asMessage = (value: unknown, maximumBytes: number): RpcMessage | undefined => {
  if (finiteOrdinaryJsonByteLength(value, { maximumBytes }) === undefined || !isRecord(value) || value.jsonrpc !== '2.0' || Object.hasOwn(value, 'bindingId')) return undefined;
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

const messageForResource = (frame: McpAppRelayFrame, value: CanonicalResource): RpcMessage => Object.freeze({
  jsonrpc: '2.0',
  method: resourceReadyMethod,
  params: Object.freeze({
    // The proxy accepts its policy only from this server-issued frame.  The
    // resource declaration is intentionally never relayed as an authority.
    allow: frame.allow,
    contentSecurityPolicy: frame.policy.contentSecurityPolicy,
    html: value.html,
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
      return this.#post(messageForResource(this.#frame, this.#resource), false);
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

  /** Detaches one remounted document without closing the server binding. */
  detach(): void {
    if (!this.#listening || this.#state === 'closed') return;
    this.#window.removeEventListener('message', this.#listener);
    this.#listening = false;
    this.#queue.length = 0;
  }

  /** Delivers authenticated route continuations to the exact current proxy. */
  deliverHostMessages(messages: readonly McpAppJsonValue[]): boolean {
    if (this.#state !== 'open' || !this.#listening) return false;
    try {
      this.#postAll(messages);
      return true;
    } catch (cause) {
      this.#report(new McpAppFrameRelayError('MCP App consent continuation delivery failed.', cause));
      return false;
    }
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

  #post(message: RpcMessage, enforceMessageLimit = true): boolean {
    const proxy = this.#iframe.contentWindow;
    if (
      proxy === null ||
      finiteOrdinaryJsonByteLength(message, {
        maximumBytes: enforceMessageLimit ? this.#frame.relay.maxMessageBytes : Number.MAX_SAFE_INTEGER,
      }) === undefined
    ) return false;
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

/** Applies and immediately verifies the non-negotiable outer-frame policy. */
export const applyMcpAppFramePolicy = (iframe: HTMLIFrameElement, policy: McpAppTrustedDocumentPolicy): void => {
  iframe.setAttribute('allow', policy.snapshot.allow);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  if (
    iframe.getAttribute('allow') !== policy.snapshot.allow ||
    iframe.getAttribute('referrerpolicy') !== 'no-referrer' ||
    iframe.getAttribute('sandbox') !== 'allow-scripts allow-same-origin'
  ) throw new McpAppFrameRelayError('MCP App outer frame policy was not applied.');
};

// AppRenderer starts its bridge in a passive effect.  This inert bridge keeps
// the first about:blank commit entirely local while the layout barrier verifies
// the frame attributes; it owns neither a Client nor a runtime binding.
const inertBridgeFactory: BridgeFactory = () => ({
  addEventListener: () => undefined,
  close: async () => undefined,
  sendHostContextChange: async () => undefined,
  sendToolCancelled: async () => undefined,
  sendToolInput: async () => undefined,
  sendToolInputPartial: async () => undefined,
  sendToolResult: async () => undefined,
  teardownResource: async () => Object.freeze({}),
});

/**
 * Renders exactly the official AppRenderer after a synchronous blank-frame
 * policy barrier.  A trusted policy handle is deliberately checked during
 * render, before React can create or navigate the iframe.
 */
export const SecureAppRenderer = ({ bindingId, bootstrapUrl, bridgeFactory, documentPolicy, policyClient, rendererProps }: SecureAppRendererProps): ReactNode => {
  const policy = assertCurrentMcpAppDocumentPolicy(policyClient, documentPolicy);
  if (policy.bindingId !== bindingId) throw new McpAppFrameRelayError('MCP App document policy belongs to another binding.');
  if (policyClient.currentDocumentPolicy(bindingId) !== policy) throw new McpAppFrameRelayError('MCP App document policy is no longer current.');
  let parsed: URL;
  try { parsed = new URL(bootstrapUrl); } catch { throw new McpAppFrameRelayError('MCP App bootstrap URL is invalid.'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new McpAppFrameRelayError('MCP App bootstrap URL is invalid.');

  const policyKey = `${bindingId}:${policy.snapshot.revision}:${bootstrapUrl}`;
  const root = useRef<HTMLDivElement>(null);
  const [armedKey, setArmedKey] = useState<string>();
  const armed = armedKey === policyKey;
  useLayoutEffect(() => {
    // The second assertion fences a policy replacement between render and DOM
    // mutation.  It is intentionally before the first resource navigation.
    const current = assertCurrentMcpAppDocumentPolicy(policyClient, documentPolicy);
    if (current !== policy || current.bindingId !== bindingId || current.snapshot.revision !== policy.snapshot.revision) {
      throw new McpAppFrameRelayError('MCP App document policy changed before the frame could arm.');
    }
    const iframe = root.current?.querySelector('iframe');
    if (iframe === null || iframe === undefined) throw new McpAppFrameRelayError('MCP App outer frame is unavailable.');
    applyMcpAppFramePolicy(iframe, current);
    setArmedKey(policyKey);
  }, [bindingId, documentPolicy, policy, policyClient, policyKey]);

  return (
    <div ref={root}>
      <AppRenderer
        {...rendererProps}
        bridgeFactory={armed ? bridgeFactory : inertBridgeFactory}
        key={policyKey}
        sandboxPath={armed ? bootstrapUrl : 'about:blank'}
      />
    </div>
  );
};

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
