import React, { useEffect, useRef, useState, type Ref } from 'react';

import {
  type McpAppHostContext,
  type McpAppJsonObject,
  type McpAppJsonValue,
  type McpAppPreview as McpAppPreviewResponse,
  type McpAppPreviewCreateRequest,
  type McpAppPreviewProfile,
  type McpAppRelayFrame,
  type McpAppRouteClose,
  type McpAppRouteMessages,
} from './mcp-app-client.ts';
import {
  createMcpAppFrameRelay,
  type McpAppFrameIframe,
  type McpAppFrameRelayOptions,
  type McpAppFrameWindow,
} from './mcp-app-frame.tsx';

import './mcp-app-preview.css';

/** The small browser contract the preview needs; foreground credentials remain client-owned. */
export interface McpAppPreviewClient {
  close(bindingId: string, options: Readonly<{ readonly id: string; readonly reason?: string }>): Promise<McpAppRouteClose>;
  create(sessionId: string, request: McpAppPreviewCreateRequest): Promise<McpAppPreviewResponse>;
  forceClose(bindingId: string): Promise<boolean>;
  message(bindingId: string, message: McpAppJsonValue, signal?: AbortSignal): Promise<McpAppRouteMessages>;
}

export interface McpAppFrameRelayLike {
  close(): Promise<void>;
  start(): boolean;
}

/** Injectable so the UI lifecycle is testable without weakening the relay boundary. */
export type McpAppFrameRelayFactory = (options: McpAppFrameRelayOptions) => McpAppFrameRelayLike;

export interface McpAppPreviewControllerOptions {
  readonly client: McpAppPreviewClient;
  readonly closeTimeoutMs?: number;
  readonly consent?: McpAppJsonValue;
  readonly frameRelayFactory: McpAppFrameRelayFactory;
  readonly host: McpAppHostContext;
  readonly input: McpAppJsonValue;
  readonly previewProfile?: McpAppPreviewProfile;
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly toolName: string;
}

export interface McpAppPreviewFallback {
  readonly input: McpAppJsonValue;
  readonly reason: string;
  readonly result: McpAppJsonValue;
}

export type McpAppPreviewState =
  | Readonly<{ readonly phase: 'loading' }>
  | Readonly<{ readonly fallback: McpAppPreviewFallback; readonly message: string; readonly phase: 'error' }>
  | Readonly<{ readonly fallback: McpAppPreviewFallback; readonly phase: 'fallback'; readonly preview: McpAppPreviewResponse }>
  | Readonly<{ readonly phase: 'ready'; readonly preview: McpAppPreviewResponse; readonly resource: McpAppCanonicalResource }>;

export type McpAppCanonicalResource = McpAppJsonObject & Readonly<{
  readonly csp?: McpAppJsonValue;
  readonly html: string;
  readonly kind: 'resource';
  readonly permissions?: McpAppJsonValue;
}>;

export interface McpAppPreviewProps extends Omit<McpAppPreviewControllerOptions, 'frameRelayFactory'> {
  readonly frameWindow?: McpAppFrameWindow;
  readonly frameRelayFactory?: McpAppFrameRelayFactory;
  readonly title?: string;
}

export interface McpAppPreviewFrameProps {
  readonly frame: McpAppRelayFrame;
  readonly iframeRef?: Ref<HTMLIFrameElement>;
  readonly title?: string;
}

const loadingState: McpAppPreviewState = Object.freeze({ phase: 'loading' });
const completed = Promise.resolve();

const isRecord = (value: McpAppJsonValue): value is Readonly<Record<string, McpAppJsonValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class McpAppPreviewDataError extends Error {
  constructor(message: string) {
    super(`MCP App preview ${message}.`);
    this.name = 'McpAppPreviewDataError';
  }
}

const detachedJson = (value: unknown, ancestors = new WeakSet<object>()): McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new McpAppPreviewDataError('input and result must contain finite JSON numbers');
  }
  if (typeof value !== 'object') throw new McpAppPreviewDataError('input and result must contain only JSON values');
  if (ancestors.has(value)) throw new McpAppPreviewDataError('input and result must not be cyclic JSON');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => detachedJson(entry, ancestors)));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new McpAppPreviewDataError('input and result must use ordinary JSON objects');
    }
    const copy = Object.create(null) as Record<string, McpAppJsonValue>;
    for (const [key, entry] of Object.entries(value)) copy[key] = detachedJson(entry, ancestors);
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
};

const messageFor = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : 'MCP App preview failed.';

const canonicalResource = (value: McpAppJsonValue): McpAppCanonicalResource | undefined => {
  if (!isRecord(value) || value.kind !== 'resource' || typeof value.html !== 'string') return undefined;
  return Object.freeze({
    ...(value.csp === undefined ? {} : { csp: value.csp }),
    html: value.html,
    kind: 'resource',
    ...(value.permissions === undefined ? {} : { permissions: value.permissions }),
  });
};

const fallbackFor = (
  resource: McpAppJsonValue | undefined,
  input: McpAppJsonValue,
  result: McpAppJsonValue,
  reason = 'invalid-resource',
): McpAppPreviewFallback => {
  if (resource !== undefined && isRecord(resource) && resource.kind === 'fallback' && typeof resource.reason === 'string') {
    return Object.freeze({
      input: resource.input ?? input,
      reason: resource.reason,
      result: resource.result ?? result,
    });
  }
  return Object.freeze({ input, reason, result });
};

const canonicalUiResourceUri = (value: McpAppJsonValue): boolean => {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const uri = new URL(value);
    return uri.protocol === 'ui:' && uri.hostname.length > 0 && uri.href === value;
  } catch {
    return false;
  }
};

const hasCanonicalAppsProfile = (value: McpAppJsonValue): boolean =>
  isRecord(value) && value.kind === 'apps' && value.resourceUri !== undefined && canonicalUiResourceUri(value.resourceUri);

const stateFor = (preview: McpAppPreviewResponse, input: McpAppJsonValue, result: McpAppJsonValue): McpAppPreviewState => {
  const resource = canonicalResource(preview.resource);
  if (preview.frame !== undefined && resource !== undefined && hasCanonicalAppsProfile(preview.profile)) {
    return Object.freeze({ phase: 'ready', preview, resource });
  }
  return Object.freeze({ fallback: fallbackFor(preview.resource, input, result), phase: 'fallback', preview });
};

const createRequest = (
  options: McpAppPreviewControllerOptions,
  input: McpAppJsonValue,
  result: McpAppJsonValue,
): McpAppPreviewCreateRequest => Object.freeze({
  ...(options.consent === undefined ? {} : { consent: options.consent }),
  host: options.host,
  input,
  previewProfile: options.previewProfile ?? 'portable',
  result,
  toolName: options.toolName,
});

/**
 * Owns one browser preview binding. The generated foreground client keeps its
 * session credential private; the relay receives only the server-issued frame
 * and canonical resource.
 */
export class McpAppPreviewController {
  readonly #client: McpAppPreviewClient;
  readonly #closeTimeoutMs: number | undefined;
  readonly #frameRelayFactory: McpAppFrameRelayFactory;
  readonly #input: McpAppJsonValue;
  readonly #request: McpAppPreviewCreateRequest;
  readonly #result: McpAppJsonValue;
  readonly #sessionId: string;
  readonly #listeners = new Set<(state: McpAppPreviewState) => void>();
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #preview: McpAppPreviewResponse | undefined;
  #relay: McpAppFrameRelayLike | undefined;
  #started = false;
  #startPromise: Promise<void> | undefined;
  #state: McpAppPreviewState = loadingState;

  constructor(options: McpAppPreviewControllerOptions) {
    this.#client = options.client;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#frameRelayFactory = options.frameRelayFactory;
    this.#input = detachedJson(options.input);
    this.#result = detachedJson(options.result);
    this.#request = createRequest(options, this.#input, this.#result);
    this.#sessionId = options.sessionId;
  }

  get state(): McpAppPreviewState {
    return this.#state;
  }

  subscribe(listener: (state: McpAppPreviewState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => { this.#listeners.delete(listener); };
  }

  start(): Promise<void> {
    if (this.#started) return this.#startPromise ?? completed;
    if (this.#closed) return completed;
    this.#started = true;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    try {
      const preview = await this.#client.create(this.#sessionId, this.#request);
      this.#preview = preview;
      if (this.#closed) return;
      this.#setState(stateFor(preview, this.#input, this.#result));
    } catch (error) {
      if (!this.#closed) {
        this.#setState(Object.freeze({
          fallback: fallbackFor(undefined, this.#input, this.#result, 'preview-error'),
          message: messageFor(error),
          phase: 'error',
        }));
      }
    }
  }

  attachFrame(iframe: McpAppFrameIframe, frameWindow: McpAppFrameWindow): boolean {
    if (this.#closed || this.#relay !== undefined || this.#state.phase !== 'ready') return false;
    const { preview, resource } = this.#state;
    const frame = preview.frame;
    if (frame === undefined) return false;
    try {
      const relay = this.#frameRelayFactory({
        bindingId: preview.bindingId,
        ...(this.#closeTimeoutMs === undefined ? {} : { closeTimeoutMs: this.#closeTimeoutMs }),
        frame,
        iframe,
        onError: (error) => { this.#relayError(error); },
        resource,
        routes: this.#client,
        window: frameWindow,
      });
      this.#relay = relay;
      if (relay.start()) return true;
      this.#relayError(new Error('MCP App frame relay did not start.'));
    } catch (error) {
      this.#relayError(error);
    }
    return false;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    await this.#startPromise;
    const bindingId = this.#preview?.bindingId;
    if (bindingId === undefined) return;
    if (this.#relay !== undefined) {
      try {
        await this.#relay.close();
        return;
      } catch {
        // The approved relay normally performs this fallback itself. Preserve
        // cleanup for a custom relay that rejects before it can do so.
      }
    }
    await this.#forceClose(bindingId);
  }

  async #forceClose(bindingId: string): Promise<void> {
    try {
      await this.#client.forceClose(bindingId);
    } catch {
      // Unmount cleanup must not create an unhandled rejection.
    }
  }

  #relayError(error: unknown): void {
    if (this.#closed) return;
    this.#setState(Object.freeze({
      fallback: fallbackFor(this.#preview?.resource, this.#input, this.#result, 'preview-error'),
      message: messageFor(error),
      phase: 'error',
    }));
    void this.close();
  }

  #setState(state: McpAppPreviewState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch {
        // A display subscriber must never disrupt route cleanup.
      }
    }
  }
}

export const createMcpAppPreviewController = (options: McpAppPreviewControllerOptions): McpAppPreviewController =>
  new McpAppPreviewController(options);

const profileDisplay = (profile: McpAppJsonValue): Readonly<{ readonly extension: boolean; readonly name: string }> => {
  if (!isRecord(profile)) return Object.freeze({ extension: false, name: 'portable' });
  const name = typeof profile.profile === 'string' ? profile.profile : 'portable';
  const extensions = isRecord(profile.extensions) ? profile.extensions : undefined;
  return Object.freeze({ extension: profile.kind === 'apps' && extensions !== undefined, name });
};

const json = (value: McpAppJsonValue): string => JSON.stringify(value, undefined, 2);

/** A server-issued sandbox document. It never receives the foreground session token. */
export const McpAppPreviewFrame = ({ frame, iframeRef, title = 'MCP App preview' }: McpAppPreviewFrameProps) =>
  <iframe
    allow={frame.allow}
    className="mcp-app-preview__frame"
    ref={iframeRef}
    referrerPolicy="no-referrer"
    sandbox="allow-scripts allow-same-origin"
    src={frame.src}
    title={title}
  />;

const Profile = ({ profile }: Readonly<{ readonly profile: McpAppJsonValue }>) => {
  const display = profileDisplay(profile);
  return (
    <dl className="mcp-app-preview__profile">
      <div><dt>Profile</dt><dd>{display.name}</dd></div>
      {display.extension ? <div><dt>Host extension</dt><dd>available</dd></div> : null}
    </dl>
  );
};

export const McpAppPreview = ({
  frameRelayFactory = createMcpAppFrameRelay,
  frameWindow,
  title = 'MCP App preview',
  ...options
}: McpAppPreviewProps) => {
  const [state, setState] = useState<McpAppPreviewState>(loadingState);
  const controller = useRef<McpAppPreviewController | undefined>(undefined);
  const iframe = useRef<HTMLIFrameElement>(null);
  const browserWindow = frameWindow ?? (typeof window === 'undefined' ? undefined : window);

  useEffect(() => {
    const current = createMcpAppPreviewController({ ...options, frameRelayFactory });
    controller.current = current;
    let subscribed = true;
    const unsubscribe = current.subscribe((next) => {
      if (subscribed) setState(next);
    });
    void current.start();
    return () => {
      subscribed = false;
      unsubscribe();
      if (controller.current === current) controller.current = undefined;
      void current.close();
    };
  }, [frameRelayFactory, options.client, options.closeTimeoutMs, options.consent, options.host, options.input, options.previewProfile, options.result, options.sessionId, options.toolName]);

  useEffect(() => {
    if (state.phase !== 'ready' || browserWindow === undefined || iframe.current === null) return;
    controller.current?.attachFrame(iframe.current, browserWindow);
  }, [browserWindow, state]);

  const fallback = state.phase === 'fallback' || state.phase === 'error' ? state.fallback : undefined;
  const profile = state.phase === 'ready' || state.phase === 'fallback' ? <Profile profile={state.preview.profile} /> : null;
  return (
    <section aria-busy={state.phase === 'loading'} aria-label={title} className="mcp-app-preview">
      <header className="mcp-app-preview__header"><h2>{title}</h2>{profile}</header>
      {state.phase === 'loading' ? <p role="status">Creating MCP App preview…</p> : null}
      {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
      {fallback === undefined ? null : (
        <section aria-label="MCP App fallback" className="mcp-app-preview__fallback">
          <p role="status">Interactive App rendering is unavailable ({fallback.reason}). Showing the ordinary tool result instead.</p>
          <details open><summary>Tool input</summary><pre>{json(fallback.input)}</pre></details>
          <details open><summary>Tool result</summary><pre>{json(fallback.result)}</pre></details>
        </section>
      )}
      {state.phase === 'ready' && state.preview.frame !== undefined ? <McpAppPreviewFrame frame={state.preview.frame} iframeRef={iframe} title={title} /> : null}
    </section>
  );
};
