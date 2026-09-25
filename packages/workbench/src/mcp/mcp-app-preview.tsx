import React, { useEffect, useRef, useState, type Ref } from 'react';

import {
  type McpAppConsentChallenge,
  type McpAppConsentDecision,
  type McpAppHostContext,
  type McpAppJsonObject,
  type McpAppJsonValue,
  type McpAppPreview as McpAppPreviewResponse,
  type McpAppPreviewCreateRequest,
  type McpAppPreviewProfile,
  type McpAppPreviewTerminal,
  type McpAppRelayFrame,
  type McpAppRouteClose,
  type McpAppRouteMessages,
} from './mcp-app-client.ts';
import {
  createMcpAppFrameRelay,
  type McpAppFrameIframe,
  type McpAppFrameRelayOptions,
  type McpAppFrameWindow,
} from '../../../agent-bundle/src/web-host/browser/frame-relay.ts';

import './mcp-app-preview.css';

/** The small browser contract the preview needs; foreground credentials remain client-owned. */
export interface McpAppPreviewClient {
  close(bindingId: string, options: Readonly<{ readonly id: string; readonly reason?: string }>): Promise<McpAppRouteClose>;
  consentChallenges?(bindingId: string): Promise<readonly McpAppConsentChallenge[]>;
  create(sessionId: string, request: McpAppPreviewCreateRequest): Promise<McpAppPreviewResponse>;
  decideConsent?(bindingId: string, challengeId: string, approved: boolean): Promise<McpAppConsentDecision>;
  forceClose(bindingId: string): Promise<boolean>;
  message(bindingId: string, message: McpAppJsonValue, signal?: AbortSignal): Promise<McpAppRouteMessages>;
  settle?(bindingId: string, terminal: McpAppPreviewTerminal): Promise<McpAppRouteMessages>;
}

export interface McpAppFrameRelayLike {
  close(): Promise<void>;
  detach?(): void;
  deliverHostMessages?(messages: readonly McpAppJsonValue[]): boolean;
  start(): boolean;
}

/** Injectable so the UI lifecycle is testable without weakening the relay boundary. */
export type McpAppFrameRelayFactory = (options: McpAppFrameRelayOptions) => McpAppFrameRelayLike;

export interface McpAppPreviewControllerOptions {
  readonly client: McpAppPreviewClient;
  readonly closeTimeoutMs?: number;
  readonly frameRelayFactory: McpAppFrameRelayFactory;
  readonly host: McpAppHostContext;
  readonly input: McpAppJsonValue;
  readonly previewProfile?: McpAppPreviewProfile;
  /**
   * Omitted while the opening call is in flight (#751): the App renders from
   * its input and `settle` publishes the one terminal outcome later.
   */
  readonly result?: McpAppJsonValue;
  readonly sessionId: string;
  readonly toolName: string;
}

export interface McpAppPreviewFallback {
  readonly input: McpAppJsonValue;
  readonly reason: string;
  /** Absent while the opening call is still pending or once it was cancelled. */
  readonly result?: McpAppJsonValue;
  /** The reason the opening call was cancelled instead of producing a result. */
  readonly cancelled?: string;
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
  /** The opening call's outcome once it lands, for a preview mounted without `result`. */
  readonly terminal?: McpAppPreviewTerminal;
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
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
        throw new McpAppPreviewDataError('input and result must use ordinary JSON arrays');
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const copy: McpAppJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new McpAppPreviewDataError('input and result must use enumerable JSON data properties');
        }
        copy.push(detachedJson(descriptor.value, ancestors));
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === 'length') continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key || !descriptor.enumerable || !('value' in descriptor)) {
          throw new McpAppPreviewDataError('input and result must use enumerable JSON data properties');
        }
      }
      return Object.freeze(copy);
    }
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new McpAppPreviewDataError('input and result must use ordinary JSON objects');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy = Object.create(null) as Record<string, McpAppJsonValue>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new McpAppPreviewDataError('input and result must use enumerable JSON data properties');
      }
      copy[key] = detachedJson(descriptor.value, ancestors);
    }
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
  outcome: McpAppPreviewTerminal | undefined,
  reason = 'invalid-resource',
): McpAppPreviewFallback => {
  const cancelled = outcome !== undefined && 'cancelled' in outcome ? { cancelled: outcome.cancelled } : {};
  if (resource !== undefined && isRecord(resource) && resource.kind === 'fallback' && typeof resource.reason === 'string') {
    const fallbackResult = resource.result ?? resultOf(outcome);
    return Object.freeze({
      input: resource.input ?? input,
      reason: resource.reason,
      ...(fallbackResult === undefined ? {} : { result: fallbackResult }),
      ...cancelled,
    });
  }
  return Object.freeze({ input, reason, result: resultOf(outcome), ...cancelled });
};

/** The route settled the binding but this frame could not take the terminal message; nothing to retry. */
export class McpAppOutcomeDeliveryError extends Error {
  constructor() {
    super('The App frame could not receive the outcome.');
    this.name = 'McpAppOutcomeDeliveryError';
  }
}

const resultOf = (outcome: McpAppPreviewTerminal | undefined): McpAppJsonValue | undefined =>
  outcome !== undefined && 'result' in outcome ? outcome.result : undefined;

const fallbackOutcome = (fallback: McpAppPreviewFallback): string =>
  fallback.cancelled !== undefined ? `Cancelled: ${fallback.cancelled}` : fallback.result === undefined ? 'Pending…' : json(fallback.result);

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

const stateFor = (preview: McpAppPreviewResponse, input: McpAppJsonValue, outcome: McpAppPreviewTerminal | undefined): McpAppPreviewState => {
  const resource = canonicalResource(preview.resource);
  if (preview.frame !== undefined && resource !== undefined && hasCanonicalAppsProfile(preview.profile)) {
    return Object.freeze({ phase: 'ready', preview, resource });
  }
  return Object.freeze({ fallback: fallbackFor(preview.resource, input, outcome), phase: 'fallback', preview });
};

const createRequest = (
  options: McpAppPreviewControllerOptions,
  input: McpAppJsonValue,
  result: McpAppJsonValue | undefined,
): McpAppPreviewCreateRequest => Object.freeze({
  host: options.host,
  input,
  previewProfile: options.previewProfile ?? 'portable',
  ...(result === undefined ? {} : { result }),
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
  /** The opening call's outcome as this preview knows it; absent while the call is still in flight. */
  #outcome: McpAppPreviewTerminal | undefined;
  /** The one terminal publish in flight or accepted; cleared when it failed so the outcome can be offered again. */
  #settling: Promise<boolean> | undefined;
  readonly #sessionId: string;
  readonly #listeners = new Set<(state: McpAppPreviewState) => void>();
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #preview: McpAppPreviewResponse | undefined;
  #pendingDocumentPreview: McpAppPreviewResponse | undefined;
  #relay: McpAppFrameRelayLike | undefined;
  #started = false;
  #startPromise: Promise<void> | undefined;
  #state: McpAppPreviewState = loadingState;

  constructor(options: McpAppPreviewControllerOptions) {
    this.#client = options.client;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#frameRelayFactory = options.frameRelayFactory;
    this.#input = detachedJson(options.input);
    this.#outcome = options.result === undefined ? undefined : Object.freeze({ result: detachedJson(options.result) });
    this.#settling = options.result === undefined ? undefined : Promise.resolve(false);
    this.#request = createRequest(options, this.#input, resultOf(this.#outcome));
    this.#sessionId = options.sessionId;
  }

  get state(): McpAppPreviewState {
    return this.#state;
  }

  get pendingDocumentPolicyRevision(): number | undefined {
    return this.#pendingDocumentPreview?.frame?.documentPolicy?.revision;
  }

  async consentChallenges(): Promise<readonly McpAppConsentChallenge[]> {
    const bindingId = this.#preview?.bindingId;
    const client = this.#client;
    const list = client.consentChallenges;
    return bindingId === undefined || this.#closed || list === undefined ? Object.freeze([]) : list.call(client, bindingId);
  }

  /**
   * Publishes the opening call's one terminal outcome to a preview created
   * without `result` (#751). Waits for the binding to exist; `false` when there
   * is nothing to settle (a second outcome, a closed preview, one created with
   * its result). A publish the route refused or that threw rejects and leaves
   * the preview unsettled — mounted as it was — so the caller can show the
   * failure and offer the same outcome again. Once the route accepted it the
   * binding is settled for good, so a frame that could not take the message
   * rejects with `McpAppOutcomeDeliveryError` and nothing is offered again.
   * ponytail: a response lost after the route accepted reads as a refusal on
   * retry; replaying the accepted terminal would need the route to retain it.
   */
  async settle(terminal: McpAppPreviewTerminal): Promise<boolean> {
    if (this.#settling !== undefined || this.#closed) return false;
    this.#settling = this.#publishTerminal(terminal);
    try {
      return await this.#settling;
    } catch (error) {
      if (!(error instanceof McpAppOutcomeDeliveryError)) this.#settling = undefined;
      throw error;
    }
  }

  async #publishTerminal(terminal: McpAppPreviewTerminal): Promise<boolean> {
    await this.#startPromise;
    const preview = this.#preview;
    const client = this.#client;
    const settle = client.settle;
    if (preview === undefined || this.#closed || settle === undefined) return false;
    const response = await settle.call(client, preview.bindingId, terminal);
    if (this.#closed) return false;
    if (!response.accepted) throw new Error('The App preview did not accept the outcome.');
    this.#outcome = 'result' in terminal ? Object.freeze({ result: detachedJson(terminal.result) }) : terminal;
    this.#setState(stateFor(preview, this.#input, this.#outcome));
    if (response.messages.length > 0 && this.#relay?.deliverHostMessages?.(response.messages) !== true) {
      throw new McpAppOutcomeDeliveryError();
    }
    return true;
  }

  async decideConsent(challengeId: string, approved: boolean): Promise<boolean> {
    const previous = this.#preview;
    const client = this.#client;
    const decide = client.decideConsent;
    if (previous === undefined || this.#closed || decide === undefined) return false;
    const decision = await decide.call(client, previous.bindingId, challengeId, approved);
    if (this.#closed) return false;
    if (!decision.approved) return decision.messages.length > 0 && this.#relay?.deliverHostMessages?.(decision.messages) === true;
    const documentChanged = previous.frame?.documentPolicy?.revision !== decision.preview.frame?.documentPolicy?.revision;
    if (documentChanged) {
      this.#relay?.detach?.();
      this.#relay = undefined;
      this.#pendingDocumentPreview = decision.preview;
      return true;
    } else if (!this.#relay?.deliverHostMessages?.(decision.messages)) {
      return false;
    }
    this.#preview = decision.preview;
    this.#setState(stateFor(decision.preview, this.#input, this.#outcome));
    return true;
  }

  /** Publishes a refreshed document only after the browser committed its blank barrier. */
  commitDocumentRemount(revision: number): boolean {
    const preview = this.#pendingDocumentPreview;
    if (preview === undefined || preview.frame?.documentPolicy?.revision !== revision || this.#closed) return false;
    this.#pendingDocumentPreview = undefined;
    this.#preview = preview;
    this.#setState(stateFor(preview, this.#input, this.#outcome));
    return true;
  }

  subscribe(listener: (state: McpAppPreviewState) => void): () => void {
    this.#listeners.add(listener);
    try {
      listener(this.#state);
    } catch {
      // A display subscriber must never disrupt route cleanup.
    }
    return () => { this.#listeners.delete(listener); };
  }

  start(): Promise<void> {
    if (this.#started) return this.#startPromise ?? completed;
    if (this.#closed) return completed;
    this.#started = true;
    this.#startPromise = this.#startPreview();
    return this.#startPromise;
  }

  async #startPreview(): Promise<void> {
    try {
      const preview = await this.#client.create(this.#sessionId, this.#request);
      this.#preview = preview;
      if (this.#closed) return;
      this.#setState(stateFor(preview, this.#input, this.#outcome));
    } catch (error) {
      if (!this.#closed) {
        this.#setState(Object.freeze({
          fallback: fallbackFor(undefined, this.#input, this.#outcome, 'preview-error'),
          message: messageFor(error),
          phase: 'error',
        }));
      }
    }
  }

  attachFrame(iframe: McpAppFrameIframe, frameWindow: McpAppFrameWindow): boolean {
    const state = this.#state;
    if (this.#closed || this.#relay !== undefined || state.phase !== 'ready') return false;
    const { preview, resource } = state;
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
      fallback: fallbackFor(this.#preview?.resource, this.#input, this.#outcome, 'preview-error'),
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
    data-mcp-app-document-revision={frame.documentPolicy?.revision ?? 0}
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

export function McpAppPreview(props: McpAppPreviewProps): React.ReactNode {
  const terminal = props.terminal;
  const controller = useRef<McpAppPreviewController | undefined>(undefined);
  const [state, setState] = useState<McpAppPreviewState>(loadingState);
  const iframe = useRef<HTMLIFrameElement>(null);
  const frameRelayFactory = props.frameRelayFactory ?? createMcpAppFrameRelay;
  const browserWindow = props.frameWindow ?? (typeof window === 'undefined' ? undefined : window);
  const title = props.title ?? 'MCP App preview';

  useEffect(() => {
    const current = createMcpAppPreviewController({
      client: props.client,
      ...(props.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: props.closeTimeoutMs }),
      frameRelayFactory,
      host: props.host,
      input: props.input,
      ...(props.previewProfile === undefined ? {} : { previewProfile: props.previewProfile }),
      result: props.result,
      sessionId: props.sessionId,
      toolName: props.toolName,
    });
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
  }, [props.client, props.closeTimeoutMs, props.host, props.input, props.previewProfile, props.result, props.sessionId, props.toolName, frameRelayFactory]);

  // The opening call's outcome lands once; the controller refuses any second
  // one. A publish that failed is shown here and can be offered again.
  const [settleError, setSettleError] = useState<{ readonly message: string; readonly retryable: boolean }>();
  const offerTerminal = (outcome: McpAppPreviewTerminal): void => {
    setSettleError(undefined);
    controller.current?.settle(outcome).catch((error: unknown) => {
      setSettleError({ message: messageFor(error), retryable: !(error instanceof McpAppOutcomeDeliveryError) });
    });
  };
  useEffect(() => {
    if (terminal !== undefined) offerTerminal(terminal);
  }, [terminal]);

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
      {settleError === undefined || terminal === undefined ? null : <p role="alert">
        The App did not receive the call's outcome: {settleError.message}{' '}
        {settleError.retryable ? <button onClick={() => offerTerminal(terminal)} type="button">Retry</button> : null}
      </p>}
      {fallback === undefined ? null : (
        <section aria-label="MCP App fallback" className="mcp-app-preview__fallback">
          <p role="status">Interactive App rendering is unavailable ({fallback.reason}). Showing the ordinary tool result instead.</p>
          <details open><summary>Tool input</summary><pre>{json(fallback.input)}</pre></details>
          <details open><summary>Tool result</summary><pre>{fallbackOutcome(fallback)}</pre></details>
        </section>
      )}
      {state.phase === 'ready' && state.preview.frame !== undefined
        ? <McpAppPreviewFrame key={state.preview.frame.documentPolicy?.revision ?? 0} frame={state.preview.frame} iframeRef={iframe} title={title} />
        : null}
    </section>
  );
}
