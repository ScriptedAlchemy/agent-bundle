import type {
  McpAppJsonValue,
  McpAppRelayFrame,
  McpAppRouteClose,
  McpAppRouteMessages,
} from '../../contracts/mcp-apps.ts';
import { isPlainRecord } from '../../contracts/strict-json.ts';
import { finiteOrdinaryJsonByteLength } from './finite-json.ts';

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
  /** A DOM iframe publishes the relay lifecycle through this (`relayStateAttribute`); fakes may omit it. */
  setAttribute?(name: string, value: string): void;
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

type RelayState = 'closed' | 'closing' | 'open';

/**
 * Relay lifecycle as published on the outer iframe's `data-mcp-app-relay-state`
 * attribute, so the host UI and browser tests observe the state the relay is
 * in instead of inferring it from route traffic. `loading`: listening, but the
 * proxy has not signalled readiness, so `close()` releases the binding with a
 * forced DELETE. `ready`: the proxy holds the resource, so `close()` runs the
 * graceful `POST …/close` teardown handshake. `closing` and `closed` mirror
 * `RelayState`.
 */
type RelayFrameState = 'closed' | 'closing' | 'loading' | 'ready';
const relayStateAttribute = 'data-mcp-app-relay-state';

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

const validRequestId = (value: unknown): boolean =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

const asMessage = (value: unknown, maximumBytes: number): RpcMessage | undefined => {
  if (
    finiteOrdinaryJsonByteLength(value, { maximumBytes }) === undefined ||
    !isPlainRecord(value) ||
    value.jsonrpc !== '2.0' ||
    Object.hasOwn(value, 'bindingId')
  ) return undefined;
  const hasMethod = typeof value.method === 'string' && value.method.length > 0;
  const hasId = Object.hasOwn(value, 'id') && validRequestId(value.id);
  const hasResponse = hasId && !hasMethod && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'));
  if (!hasMethod && !hasResponse) return undefined;
  return value as RpcMessage;
};

const resource = (value: McpAppJsonValue): CanonicalResource => {
  if (!isPlainRecord(value) || value.kind !== 'resource' || typeof value.html !== 'string') {
    throw new McpAppFrameRelayError('MCP App preview does not contain a canonical HTML resource.');
  }
  if (value.csp !== undefined && !isPlainRecord(value.csp)) {
    throw new McpAppFrameRelayError('MCP App preview resource has invalid CSP declarations.');
  }
  if (value.permissions !== undefined && !isPlainRecord(value.permissions)) {
    throw new McpAppFrameRelayError('MCP App preview resource has invalid permission declarations.');
  }
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
    // The proxy accepts its policy only from this server-issued frame. The
    // resource declaration is intentionally never relayed as an authority.
    allow: frame.allow,
    contentSecurityPolicy: frame.policy.contentSecurityPolicy,
    html: value.html,
  }),
});

const positiveTimeout = (value: number | undefined): number => {
  const timeout = value ?? 5_000;
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

const isProxyReady = (message: RpcMessage): boolean =>
  message.method === proxyReadyMethod && !Object.hasOwn(message, 'id');

const isTeardownAcknowledgement = (message: RpcMessage, id: string): boolean =>
  !Object.hasOwn(message, 'method') &&
  message.id === id &&
  (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'));

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
    this.#publishFrameState();
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
      this.#publishFrameState();
      return this.#post(messageForResource(this.#frame, this.#resource), false);
    }
    if (!this.#resourceProvided) return false;
    return this.#enqueue(() => this.#deliver(message));
  }

  close(): Promise<void> {
    if (this.#state === 'closed') return closedRelay;
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = 'closing';
    this.#publishFrameState();
    this.#closePromise = new Promise<void>((resolve) => { this.#finishClose = resolve; });
    // Before the proxy signals readiness there is no app to tear down and no
    // window that can acknowledge a teardown frame: the proxy document is
    // still loading (or is the initial about:blank, whose origin never matches
    // targetOrigin, so postMessage drops the frame silently). The graceful
    // handshake could only wait out the force timer, so release the binding
    // now instead of holding the closing state for the whole budget.
    if (!this.#resourceProvided) {
      void this.#forceClose();
      return this.#closePromise;
    }
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
    for (const message of messages) this.#postOne(message);
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
    this.#publishFrameState();
    this.#queue.length = 0;
    if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer);
    this.#closeTimer = undefined;
    if (this.#listening) this.#window.removeEventListener('message', this.#listener);
    this.#listening = false;
    this.#finishClose?.();
    this.#finishClose = undefined;
  }

  /** Mirrors `#state` and `#resourceProvided` onto the iframe on the same event that changes them. */
  #publishFrameState(): void {
    const state: RelayFrameState = this.#state === 'open' ? (this.#resourceProvided ? 'ready' : 'loading') : this.#state;
    this.#iframe.setAttribute?.(relayStateAttribute, state);
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

export const createMcpAppFrameRelay = (
  options: McpAppFrameRelayOptions,
): McpAppFrameRelay => new McpAppFrameRelay(options);
