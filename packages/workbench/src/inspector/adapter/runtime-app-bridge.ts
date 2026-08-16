import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { ListToolsRequestSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

import type {
  McpAppBridgeMessage,
  McpAppValidatedDownload,
} from '../../../../agent-bundle/src/dev/mcp-app-bridge.ts';
import type { McpAppJsonValue } from '../../../../agent-bundle/src/dev/mcp-app-metadata.ts';
import type { McpAppPreviewAppsSnapshot, McpAppPreviewSnapshot } from '../../../../agent-bundle/src/dev/mcp-app-runtime-preview-service.ts';
import type { McpAppConsentCapability, McpAppConsentChallenge, McpAppConsentRequest } from '../../../../agent-bundle/src/dev/mcp-app-sandbox.ts';
import type { McpAppClient, McpAppRuntimeClient } from '../../mcp/mcp-app-client.ts';
import type { McpSessionController, McpSessionControllerAppAccess } from '../../mcp/mcp-session-controller.ts';

import { snapshotHostContext, type AppRendererBridge, type BridgeFactory } from './closure-spike.ts';

export interface McpAppInstalledHostHandlers {
  readonly downloadFile?: (download: McpAppValidatedDownload) => Promise<void>;
  readonly openExternalLink?: (url: string) => Promise<void>;
  readonly requestDisplayMode?: (mode: 'inline' | 'fullscreen') => Promise<'inline' | 'fullscreen'>;
}

export interface McpAppSimulationFeatures {
  readonly chatGptWidgetState: 'disabled' | 'enabled';
}

export interface RuntimeAppBridgeOptions {
  readonly client: McpAppClient & McpAppRuntimeClient;
  readonly controller: McpSessionController;
  readonly installedHandlers: McpAppInstalledHostHandlers;
  readonly listChanged: Readonly<{ readonly resources: boolean; readonly tools: boolean }>;
  readonly onTrace: (entry: McpAppBridgeMessage) => void;
  readonly persistWidgetState?: (state: unknown) => Promise<void>;
  readonly preview: McpAppPreviewSnapshot;
  readonly requestConsent: (challenge: McpAppConsentChallenge) => Promise<'allow-once' | 'deny'>;
  readonly simulationFeatures: McpAppSimulationFeatures;
}

interface BrowserMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
  stopImmediatePropagation?(): void;
}

interface BrowserWindow {
  addEventListener(type: 'message', listener: (event: BrowserMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: BrowserMessageEvent) => void): void;
}

interface PostMessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface AppBridgeHandlerExtra {
  readonly signal: AbortSignal;
}

type DisplayHandler = (
  params: Readonly<{ readonly mode: 'inline' | 'fullscreen' | 'pip' }>,
  extra?: AppBridgeHandlerExtra,
) => Promise<Readonly<{ readonly mode: 'inline' | 'fullscreen' | 'pip' }>>;

/** The ext-apps 1.7.5 declaration omits inherited runtime members. */
interface RuntimeAppBridge extends AppRendererBridge {
  addEventListener(type: 'initialized', listener: () => void): void;
  addEventListener(
    type: 'loggingmessage',
    listener: (entry: Readonly<{ readonly data: McpAppJsonValue; readonly level: string; readonly logger?: string }>) => void,
  ): void;
  addEventListener(type: 'sizechange', listener: (entry: Readonly<{ readonly height?: number; readonly width?: number }>) => void): void;
  close(): Promise<void>;
  connect(transport: GuardedPostMessageTransport): Promise<void>;
  ondownloadfile: ((params: Readonly<{ readonly contents: unknown }>, extra: AppBridgeHandlerExtra) => Promise<Readonly<{ readonly isError?: true }>>) | undefined;
  onlistprompts: ((params: Readonly<Record<string, McpAppJsonValue>>, extra: AppBridgeHandlerExtra) => Promise<never>) | undefined;
  onlistresourcetemplates: ((params: Readonly<Record<string, McpAppJsonValue>>, extra: AppBridgeHandlerExtra) => Promise<never>) | undefined;
  onopenlink: ((params: Readonly<{ readonly url: unknown }>, extra: AppBridgeHandlerExtra) => Promise<Readonly<{ readonly isError?: true }>>) | undefined;
  onrequestdisplaymode: DisplayHandler | undefined;
  onupdatemodelcontext: ((params: Readonly<{ readonly structuredContent?: McpAppJsonValue }>, extra: AppBridgeHandlerExtra) => Promise<Readonly<Record<string, never>>>) | undefined;
  setRequestHandler(
    schema: typeof ListToolsRequestSchema,
    handler: (request: Readonly<{ readonly params: Readonly<Record<string, McpAppJsonValue>> }>, extra: AppBridgeHandlerExtra) => Promise<unknown>,
  ): void;
}

const maximumMessageBytes = 256 * 1024;
const maximumQueuedMessages = 32;
const maximumFailures = 3;

const runtimePreview = (preview: McpAppPreviewSnapshot): McpAppPreviewAppsSnapshot => {
  if (preview.kind !== 'apps') throw new Error('MCP App bridge requires an Apps preview snapshot.');
  return preview;
};

const ordinaryJson = (value: unknown, ancestors = new WeakSet<object>()): value is McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => ordinaryJson(entry, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((entry) => ordinaryJson(entry, ancestors));
  } finally {
    ancestors.delete(value);
  }
};

const messageBytes = (value: unknown): number | undefined => {
  if (!ordinaryJson(value)) return undefined;
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? new TextEncoder().encode(text).byteLength : undefined;
  } catch {
    return undefined;
  }
};

const boundedMessage = (value: unknown): boolean => {
  const bytes = messageBytes(value);
  return bytes !== undefined && bytes <= maximumMessageBytes;
};

const frozenJson = (value: McpAppJsonValue, ancestors = new WeakSet<object>()): McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (ancestors.has(value)) throw new Error('MCP App host context must not be cyclic.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => frozenJson(entry, ancestors)));
    const copy = Object.create(null) as Record<string, McpAppJsonValue>;
    for (const [key, entry] of Object.entries(value)) copy[key] = frozenJson(entry, ancestors);
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
};

const browserWindow = (): BrowserWindow => {
  const candidate = (globalThis as { readonly window?: unknown }).window;
  if (candidate === undefined || candidate === null || typeof (candidate as BrowserWindow).addEventListener !== 'function') {
    throw new Error('MCP App bridge requires a browser window.');
  }
  return candidate as BrowserWindow;
};

/**
 * Composes the public transport with the checks its wildcard sender cannot
 * provide: exact iframe source/origin and a bounded, serial transport queue.
 */
class GuardedPostMessageTransport {
  readonly #delegate: PostMessageTransport;
  readonly #expectedOrigin: string;
  readonly #source: PostMessageTarget;
  readonly #window: BrowserWindow;
  readonly #inbound: (event: BrowserMessageEvent) => void;
  readonly #onFailClosed: () => void;
  #closed = false;
  #consecutiveFailures = 0;
  #listening = false;
  #tail = Promise.resolve();
  #inboundTail = Promise.resolve();
  #inboundQueued = 0;
  #queued = 0;

  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: PostMessageTransport['onmessage'];
  sessionId: string | undefined;
  setProtocolVersion: ((version: string) => void) | undefined;

  constructor(options: Readonly<{ readonly expectedOrigin: string; readonly source: PostMessageTarget; readonly onFailClosed: () => void }>) {
    this.#expectedOrigin = options.expectedOrigin;
    this.#source = options.source;
    this.#window = browserWindow();
    this.#onFailClosed = options.onFailClosed;
    // The public transport always sends '*'.  The small target proxy narrows
    // that one send operation to the server-issued client-surface origin.
    const target = Object.freeze({
      postMessage: (message: unknown) => {
        if (!boundedMessage(message)) throw new Error('MCP App outbound message is invalid or exceeds its bound.');
        this.#source.postMessage(message, this.#expectedOrigin);
      },
    }) as unknown as Window;
    this.#delegate = new PostMessageTransport(target, options.source as unknown as MessageEventSource);
    this.#inbound = (event) => {
      if (this.#closed || event.source !== this.#source || event.origin !== this.#expectedOrigin) {
        event.stopImmediatePropagation?.();
        return;
      }
      // Stop the public transport's independent listener.  The guarded queue
      // below is the single admission path, so matching traffic preserves
      // arrival order rather than racing on the window event loop.
      event.stopImmediatePropagation?.();
      if (!boundedMessage(event.data)) {
        this.#failure(new Error('MCP App inbound message is invalid or exceeds its bound.'));
        return;
      }
      if (this.#inboundQueued >= maximumQueuedMessages) {
        this.#failure(new Error('MCP App inbound message queue is full.'));
        return;
      }
      this.#inboundQueued += 1;
      this.#inboundTail = this.#inboundTail.then(() => {
        if (!this.#closed) this.#delegate.onmessage?.(event.data as Parameters<NonNullable<PostMessageTransport['onmessage']>>[0]);
      }).catch((error: unknown) => { this.#failure(error instanceof Error ? error : new Error(String(error))); })
        .finally(() => { this.#inboundQueued -= 1; });
    };
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('MCP App transport is closed.');
    if (!this.#listening) {
      this.#window.addEventListener('message', this.#inbound);
      this.#listening = true;
    }
    this.#delegate.onclose = () => { this.#close(false); };
    this.#delegate.onerror = (error: Error) => { this.#failure(error); };
    this.#delegate.onmessage = (message: Parameters<NonNullable<PostMessageTransport['onmessage']>>[0], extra: Parameters<NonNullable<PostMessageTransport['onmessage']>>[1]) => {
      this.#consecutiveFailures = 0;
      this.onmessage?.(message, extra);
    };
    this.#delegate.setProtocolVersion = (version: string) => { this.setProtocolVersion?.(version); };
    await this.#delegate.start();
  }

  send(...args: Parameters<PostMessageTransport['send']>): Promise<void> {
    if (this.#closed || !boundedMessage(args[0])) {
      this.#failure(new Error('MCP App outbound message is invalid or exceeds its bound.'));
      return Promise.reject(new Error('MCP App transport is closed.'));
    }
    if (this.#queued >= maximumQueuedMessages) {
      this.#failure(new Error('MCP App outbound message queue is full.'));
      return Promise.reject(new Error('MCP App transport queue is full.'));
    }
    this.#queued += 1;
    const send = this.#tail.then(async () => {
      if (this.#closed) throw new Error('MCP App transport is closed.');
      await this.#delegate.send(...args);
      this.#consecutiveFailures = 0;
    });
    this.#tail = send.catch((error: unknown) => { this.#failure(error instanceof Error ? error : new Error(String(error))); });
    return send.finally(() => { this.#queued -= 1; });
  }

  close(): Promise<void> {
    return this.#close(true);
  }

  #failure(error: Error): void {
    try { this.onerror?.(error); } catch { /* observers cannot weaken isolation */ }
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= maximumFailures) {
      void this.#close(true);
      try { this.#onFailClosed(); } catch { /* fail-closed cleanup is best effort */ }
    }
  }

  async #close(notify: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#listening) this.#window.removeEventListener('message', this.#inbound);
    this.#listening = false;
    try { await this.#delegate.close(); } finally {
      if (notify) {
        try { this.onclose?.(); } catch { /* observer isolation */ }
      }
    }
  }
}

const bridgeCapabilities = (
  options: RuntimeAppBridgeOptions,
  preview: McpAppPreviewAppsSnapshot,
  server: Readonly<{ readonly resources?: unknown; readonly tools?: unknown }> | undefined,
) => Object.freeze({
  ...(options.installedHandlers.openExternalLink === undefined ? {} : { openLinks: Object.freeze({}) }),
  ...(options.installedHandlers.downloadFile === undefined ? {} : { downloadFile: Object.freeze({}) }),
  logging: Object.freeze({}),
  sandbox: Object.freeze({
    ...(preview.resource.csp === undefined ? {} : { csp: preview.resource.csp }),
    permissions: preview.documentPolicy.approvedPermissions,
  }),
  ...(server?.tools === undefined ? {} : { serverTools: Object.freeze({ ...(options.listChanged.tools ? { listChanged: true } : {}) }) }),
  ...(server?.resources === undefined ? {} : { serverResources: Object.freeze({ ...(options.listChanged.resources ? { listChanged: true } : {}) }) }),
  ...(options.simulationFeatures.chatGptWidgetState === 'enabled' && options.persistWidgetState !== undefined
    ? { updateModelContext: Object.freeze({ structuredContent: Object.freeze({}) }) }
    : {}),
});

const safeHostContext = (preview: McpAppPreviewAppsSnapshot): Readonly<Record<string, unknown>> => {
  const profile = preview.profile.hostContext;
  const displayModes = profile.availableDisplayModes ?? ['inline'];
  const dynamic = snapshotHostContext(null, displayModes as ('inline' | 'fullscreen' | 'pip')[]);
  const combined = { ...profile, ...dynamic };
  if (!ordinaryJson(combined)) throw new Error('MCP App host context is not finite JSON.');
  return frozenJson(combined) as Readonly<Record<string, unknown>>;
};

const validExternalUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

const validDisplayMode = (value: unknown): value is 'inline' | 'fullscreen' => value === 'inline' || value === 'fullscreen';

const download = (value: unknown): McpAppValidatedDownload | undefined => {
  if (!Array.isArray(value) || value.length > 128 || !ordinaryJson(value)) return undefined;
  const encoded = messageBytes(value);
  if (encoded === undefined || encoded > maximumMessageBytes) return undefined;
  return Object.freeze({ contents: Object.freeze([...value]), embeddedBytes: encoded, itemCount: value.length });
};

const sideEffectConsent = async (
  options: RuntimeAppBridgeOptions,
  preview: McpAppPreviewAppsSnapshot,
  capability: McpAppConsentCapability,
  details: McpAppJsonValue,
  summary: string,
): Promise<boolean> => {
  const request: McpAppConsentRequest = Object.freeze({
    actionFingerprint: `runtime-app:${preview.binding.id}:${capability}:${JSON.stringify(details)}`,
    capability,
    details,
    scope: 'action',
    summary,
  });
  const created = await options.client.createRuntimeConsent(preview.binding.id, request);
  const decision = await options.requestConsent(created.challenge);
  const resolved = await options.client.decideRuntimeConsent(preview.binding.id, created.challenge.id, decision);
  return resolved.grant !== undefined;
};

/** Obtains the one controller-owned SDK client only when it still matches the App snapshot. */
export const createBindingMcpClient = async (
  controller: McpSessionController,
  client: McpAppClient & McpAppRuntimeClient,
  preview: McpAppPreviewAppsSnapshot,
): Promise<McpSessionControllerAppAccess> => {
  const policy = client.currentDocumentPolicy(preview.binding.id);
  if (policy.bindingId !== preview.binding.id || policy.snapshot.revision !== preview.documentPolicy.revision) {
    throw new Error('MCP App document policy is stale.');
  }
  const access = await controller.attachApp();
  if (access.sessionId !== preview.binding.sessionId || access.sessionRevision !== preview.binding.sessionRevision) {
    await access.close().catch(() => undefined);
    throw new Error('MCP App controller attachment does not match the preview session identity.');
  }
  return access;
};

/** Creates the sole official bridge over the controller-owned attachment. */
export const createRuntimeAppBridgeFactory = (options: RuntimeAppBridgeOptions): BridgeFactory => {
  const preview = runtimePreview(options.preview);
  const surface = new URL(preview.clientSurface.bootstrapUrl);
  if (surface.origin !== preview.clientSurface.origin) throw new Error('MCP App preview client surface origin is invalid.');
  return async (iframe) => {
    const target = iframe.contentWindow as unknown as PostMessageTarget | null;
    if (target === null) throw new Error('MCP App iframe is not available.');
    const policy = options.client.currentDocumentPolicy(preview.binding.id);
    if (policy.bindingId !== preview.binding.id || policy.snapshot !== preview.documentPolicy) {
      throw new Error('MCP App document policy is stale.');
    }
    const access = await createBindingMcpClient(options.controller, options.client, preview);
    if (options.client.currentDocumentPolicy(preview.binding.id) !== policy) {
      await access.close().catch(() => undefined);
      throw new Error('MCP App document policy changed while the controller attachment opened.');
    }
    const serverCapabilities = access.client.getServerCapabilities();
    const transport = new GuardedPostMessageTransport({
      expectedOrigin: preview.clientSurface.origin,
      onFailClosed: () => {
        void options.client.closeRuntime(preview.binding.id).catch(() => undefined);
        void bridge.close().catch(() => undefined);
      },
      source: target,
    });
    // This is the one intentionally isolated compatibility cast: ext-apps
    // 1.x consumes the SDK-v1 Client shape, while the controller owns v2.
    const officialClient = Object.freeze({
      getServerCapabilities: () => {
        const capabilities = access.client.getServerCapabilities();
        return Object.freeze({
          ...(capabilities?.tools === undefined ? {} : { tools: capabilities.tools }),
          ...(capabilities?.resources === undefined ? {} : { resources: capabilities.resources }),
        });
      },
      request: access.client.request.bind(access.client),
      setNotificationHandler: access.client.setNotificationHandler.bind(access.client),
    }) as unknown as NonNullable<ConstructorParameters<typeof AppBridge>[0]>;
    const bridge = new AppBridge(officialClient, { name: 'Agent Bundle Workbench', version: preview.binding.profileVersion }, bridgeCapabilities(options, preview, serverCapabilities), {
      hostContext: safeHostContext(preview),
    }) as unknown as RuntimeAppBridge;
    if (serverCapabilities?.tools !== undefined) {
      bridge.setRequestHandler(ListToolsRequestSchema, async (request, extra) => officialClient.request(
        { method: 'tools/list', params: request.params },
        ListToolsResultSchema,
        { signal: extra.signal },
      ));
    }
    bridge.addEventListener('loggingmessage', (entry) => {
      const data = ordinaryJson(entry.data) ? entry.data : undefined;
      options.onTrace(Object.freeze({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: Object.freeze({
          ...(data === undefined ? {} : { data }),
          level: entry.level,
          ...(entry.logger === undefined ? {} : { logger: entry.logger }),
        }),
      }) as McpAppBridgeMessage);
    });
    bridge.onopenlink = async ({ url }) => {
      if (!validExternalUrl(url) || options.installedHandlers.openExternalLink === undefined) return { isError: true };
      const approved = await sideEffectConsent(options, preview, 'open-external-link', Object.freeze({ url }), 'Open MCP App link');
      if (!approved) return { isError: true };
      await options.installedHandlers.openExternalLink(url);
      return {};
    };
    bridge.ondownloadfile = async ({ contents }) => {
      const candidate = download(contents);
      if (candidate === undefined || options.installedHandlers.downloadFile === undefined) return { isError: true };
      const approved = await sideEffectConsent(options, preview, 'download-file', candidate.contents, 'Download MCP App file');
      if (!approved) return { isError: true };
      await options.installedHandlers.downloadFile(candidate);
      return {};
    };
    let displayFallback = bridge.onrequestdisplaymode;
    const protectedDisplayHandler: DisplayHandler = async ({ mode }) => {
      if (!validDisplayMode(mode) || options.installedHandlers.requestDisplayMode === undefined) {
        return displayFallback === undefined ? { mode: 'inline' } : displayFallback({ mode } as never, {} as never);
      }
      const approved = await sideEffectConsent(options, preview, 'request-display-mode', Object.freeze({ mode }), 'Change MCP App display mode');
      if (!approved) return displayFallback === undefined ? { mode: 'inline' } : displayFallback({ mode } as never, {} as never);
      return { mode: await options.installedHandlers.requestDisplayMode(mode) };
    };
    // Register the protected handler through the official accessor before
    // shielding that accessor from AppRenderer's later fallback assignment.
    bridge.onrequestdisplaymode = protectedDisplayHandler as never;
    Object.defineProperty(bridge, 'onrequestdisplaymode', {
      configurable: false,
      get: () => protectedDisplayHandler,
      set: (fallback: unknown) => {
        if (typeof fallback === 'function') {
          // AppRenderer sets this after the bridge is constructed.  Preserve
          // its behavior as the unapproved/unsupported fallback.
          displayFallback = fallback as typeof displayFallback;
        }
      },
    });
    if (options.simulationFeatures.chatGptWidgetState === 'enabled' && options.persistWidgetState !== undefined) {
      bridge.onupdatemodelcontext = async ({ structuredContent }) => {
        if (!ordinaryJson(structuredContent)) return {};
        await options.persistWidgetState!(structuredContent);
        return {};
      };
    }
    await bridge.connect(transport);
    // ext-apps automatically installs this handler if resources exist.  The
    // runtime dispatcher intentionally has no template route, so visibly
    // reject it instead of allowing an arbitrary method to reach the client.
    bridge.onlistresourcetemplates = async () => { throw new Error('MCP App resource templates are unsupported.'); };
    bridge.onlistprompts = async () => { throw new Error('MCP App prompts are unsupported.'); };
    return bridge;
  };
};
