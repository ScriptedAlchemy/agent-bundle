import React, { useEffect, useLayoutEffect, useRef, useState, type Ref, type RefCallback } from 'react';

import type { CallToolResult } from '@modelcontextprotocol/client';

import {
  type McpAppClient,
  type McpAppConsentChallenge,
  type McpAppConsentDecision,
  type McpAppHostContext,
  type McpAppJsonObject,
  type McpAppJsonValue,
  type McpAppPreview as McpAppPreviewResponse,
  type McpAppPreviewCreateRequest,
  type McpAppPreviewProfile,
  type McpAppRelayFrame,
  type McpAppRouteClose,
  type McpAppRouteMessages,
  type McpAppRuntimeClient,
  type McpAppTrustedDocumentPolicy,
} from './mcp-app-client.ts';
import {
  SecureAppRenderer,
} from './mcp-app-frame.tsx';
import {
  createMcpAppFrameRelay,
  type McpAppFrameIframe,
  type McpAppFrameRelayOptions,
  type McpAppFrameWindow,
} from '../../../agent-bundle/src/web-host/browser/frame-relay.ts';
import type {
  McpAppPreviewAppsSnapshot,
  McpAppPreviewSnapshot,
  McpAppRuntimeInvalidationDetails,
} from '../../../agent-bundle/src/contracts/mcp-apps.ts';
import type { AppRendererHandle, McpAppRendererTool } from './app-renderer.tsx';
import type { RuntimeAppBridgeFactory, RuntimeAppBridgeOperationTrace } from './runtime-app-bridge.ts';
import type { RuntimeAppPreviewProps } from '../runtime-stage.tsx';
import type { RuntimeAppPreviewLifecycle } from '../runtime-playground.tsx';

import './mcp-app-preview.css';

/** The small browser contract the preview needs; foreground credentials remain client-owned. */
export interface McpAppPreviewClient {
  close(bindingId: string, options: Readonly<{ readonly id: string; readonly reason?: string }>): Promise<McpAppRouteClose>;
  consentChallenges?(bindingId: string): Promise<readonly McpAppConsentChallenge[]>;
  create(sessionId: string, request: McpAppPreviewCreateRequest): Promise<McpAppPreviewResponse>;
  decideConsent?(bindingId: string, challengeId: string, approved: boolean): Promise<McpAppConsentDecision>;
  forceClose(bindingId: string): Promise<boolean>;
  message(bindingId: string, message: McpAppJsonValue, signal?: AbortSignal): Promise<McpAppRouteMessages>;
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
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly toolName: string;
}

export interface McpAppPreviewFallback {
  readonly input: McpAppJsonValue;
  readonly reason: string;
  readonly result: McpAppJsonValue;
}

type McpAppArtifactPreviewState =
  | Readonly<{ readonly phase: 'loading' }>
  | Readonly<{ readonly fallback: McpAppPreviewFallback; readonly message: string; readonly phase: 'error' }>
  | Readonly<{ readonly fallback: McpAppPreviewFallback; readonly phase: 'fallback'; readonly preview: McpAppPreviewResponse }>
  | Readonly<{ readonly phase: 'ready'; readonly preview: McpAppPreviewResponse; readonly resource: McpAppCanonicalResource }>;

export type McpAppRuntimePreviewState =
  | Readonly<{ readonly kind: 'runtime'; readonly phase: 'loading' }>
  | Readonly<{ readonly kind: 'runtime'; readonly phase: 'closing' }>
  | Readonly<{ readonly fallback: McpAppPreviewFallback; readonly kind: 'runtime'; readonly phase: 'fallback' }>
  | Readonly<{ readonly fallback: McpAppPreviewFallback; readonly kind: 'runtime'; readonly message: string; readonly phase: 'error' | 'cleanup-failed' }>
  | Readonly<{
      readonly bridgeFactory: RuntimeAppBridgeFactory;
      readonly documentPolicy: McpAppTrustedDocumentPolicy;
      readonly fallback: McpAppPreviewFallback;
      readonly kind: 'runtime';
      readonly phase: 'ready';
      readonly preview: McpAppPreviewAppsSnapshot;
    }>;

/** Artifact callers retain this exact state union. */
export type McpAppPreviewState = McpAppArtifactPreviewState;

type McpAppPreviewControllerState = McpAppArtifactPreviewState | McpAppRuntimePreviewState;

type RuntimeRendererProps = Readonly<{
  readonly onError: (error: Error) => void;
  readonly ref: RefCallback<AppRendererHandle>;
  readonly tool: McpAppRendererTool;
}>;

type RuntimeInvalidationReason = 'registry-replay-gap' | 'session-restarted';

/** Server-produced App evidence is detached once before it reaches the renderer handle. */
type RuntimeRendererInvocation = Readonly<{
  readonly input: Parameters<AppRendererHandle['sendToolInput']>[0];
  readonly result: CallToolResult;
}>;

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

/** The runtime arm reuses this preview owner and never accepts an artifact relay. */
export interface McpAppRuntimePreviewProps extends RuntimeAppPreviewProps {
  readonly client: McpAppClient & McpAppRuntimeClient;
  readonly createBridgeFactory: (preview: McpAppPreviewAppsSnapshot) => RuntimeAppBridgeFactory;
  readonly kind: 'runtime';
  /** Validated public operation evidence; it never participates in preview authority. */
  readonly operationTraces?: readonly RuntimeAppBridgeOperationTrace[];
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

const runtimeRendererInvocation = (input: McpAppJsonValue, appVisible: McpAppJsonValue): RuntimeRendererInvocation => {
  if (!isRecord(input)) throw new McpAppPreviewDataError('runtime App tool input must be a JSON object');
  return Object.freeze({
    input: input as Parameters<AppRendererHandle['sendToolInput']>[0],
    // The runtime preview service admits this field as a protocol CallToolResult.
    // Detach its finite-JSON wire representation before handing it to the SDK UI.
    result: detachedJson(appVisible) as unknown as CallToolResult,
  });
};

type RuntimeDocumentPermission = 'camera' | 'clipboardWrite' | 'geolocation' | 'microphone';

const runtimeDocumentPermissionNames = (preview: McpAppPreviewAppsSnapshot): readonly RuntimeDocumentPermission[] => {
  const available: RuntimeDocumentPermission[] = [];
  const permissions = preview.resource.permissions;
  for (const permission of ['camera', 'clipboardWrite', 'geolocation', 'microphone'] as const) {
    if (permissions?.[permission] !== undefined) {
      available.push(permission);
    }
  }
  return Object.freeze(available);
};

const runtimeDocumentPermissionLabel = (permission: RuntimeDocumentPermission): string =>
  permission === 'clipboardWrite' ? 'Clipboard write' : `${permission.slice(0, 1).toUpperCase()}${permission.slice(1)}`;

const isRuntimeOptions = (
  options: McpAppPreviewControllerOptions | McpAppRuntimePreviewProps | PreparedRuntimePreviewControllerOptions,
): options is McpAppRuntimePreviewProps => 'kind' in options && options.kind === 'runtime';

const isRuntimePreviewProps = (
  props: McpAppPreviewProps | McpAppRuntimePreviewProps,
): props is McpAppRuntimePreviewProps => 'kind' in props && props.kind === 'runtime';

const runtimeProfileId = (value: string): 'chatgpt' | 'claude' | 'portable' | undefined =>
  value === 'chatgpt' || value === 'claude' || value === 'portable' ? value : undefined;

const sameStableRuntimeBinding = (
  left: Readonly<{ readonly definitionDigest: string; readonly registryRevision: number; readonly serverDigest: string; readonly serverName: string; readonly sessionId: string; readonly sessionRevision: number; readonly target: string; readonly transportDigest: string }>,
  right: Readonly<{ readonly definitionDigest: string; readonly registryRevision: number; readonly serverDigest: string; readonly serverName: string; readonly sessionId: string; readonly sessionRevision: number; readonly target: string; readonly transportDigest: string }>,
): boolean =>
  left.definitionDigest === right.definitionDigest &&
  left.registryRevision === right.registryRevision &&
  left.serverDigest === right.serverDigest &&
  left.serverName === right.serverName &&
  left.sessionId === right.sessionId &&
  left.sessionRevision === right.sessionRevision &&
  left.target === right.target &&
  left.transportDigest === right.transportDigest;

const sameRuntimeVector = (
  left: Readonly<{ readonly artifactEpochId?: string; readonly runtimeGenerationId: string; readonly sourceRevision: string; readonly stateVersion: number }>,
  right: Readonly<{ readonly artifactEpochId?: string; readonly runtimeGenerationId: string; readonly sourceRevision: string; readonly stateVersion: number }>,
): boolean =>
  left.artifactEpochId === right.artifactEpochId &&
  left.runtimeGenerationId === right.runtimeGenerationId &&
  left.sourceRevision === right.sourceRevision &&
  left.stateVersion === right.stateVersion;

type RuntimePreviewEvidence = Readonly<{
  readonly app: Readonly<{
    readonly mcpBinding: Readonly<{
      readonly definitionDigest: string;
      readonly registryRevision: number;
      readonly serverDigest: string;
      readonly serverName: string;
      readonly sessionId: string;
      readonly sessionRevision: number;
      readonly target: string;
      readonly transportDigest: string;
    }>;
    readonly resourceUri: string;
    readonly surfaceId: string;
  }> | undefined;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly runId: string;
  readonly runSurfaceId: string;
  readonly surfaceId: string;
  readonly vector: Readonly<{
    readonly artifactEpochId?: string;
    readonly runtimeGenerationId: string;
    readonly sourceRevision: string;
    readonly stateVersion: number;
  }>;
}>;

const runtimeEvidence = (options: McpAppRuntimePreviewProps): RuntimePreviewEvidence => {
  const app = options.run.status === 'succeeded' ? options.run.result.app : undefined;
  return Object.freeze({
    app: app === undefined ? undefined : Object.freeze({
      mcpBinding: Object.freeze({
        definitionDigest: app.mcpBinding.definitionDigest,
        registryRevision: app.mcpBinding.registryRevision,
        serverDigest: app.mcpBinding.serverDigest,
        serverName: app.mcpBinding.serverName,
        sessionId: app.mcpBinding.sessionId,
        sessionRevision: app.mcpBinding.sessionRevision,
        target: app.mcpBinding.target,
        transportDigest: app.mcpBinding.transportDigest,
      }),
      resourceUri: app.resourceUri,
      surfaceId: app.surfaceId,
    }),
    profileId: options.profileId,
    profileVersion: options.profile.version,
    runId: options.run.id,
    runSurfaceId: options.run.surfaceId,
    surfaceId: options.surface.id,
    vector: Object.freeze({
      ...(options.run.vector.artifactEpochId === undefined ? {} : { artifactEpochId: options.run.vector.artifactEpochId }),
      runtimeGenerationId: options.run.vector.runtimeGenerationId,
      sourceRevision: options.run.vector.sourceRevision,
      stateVersion: options.run.vector.stateVersion,
    }),
  });
};

type RuntimePreviewAuthority = Readonly<{
  readonly client: McpAppClient & McpAppRuntimeClient;
  readonly createBridgeFactory: McpAppRuntimePreviewProps['createBridgeFactory'];
  readonly evidence: RuntimePreviewEvidence;
}>;

/**
 * The only runtime payload permitted to outlive the commit that admitted it.
 * It deliberately owns every value consumed by a delayed controller start.
 */
type RuntimePreviewPreparedSeed = Readonly<{
  readonly client: McpAppClient & McpAppRuntimeClient;
  readonly createBridgeFactory: McpAppRuntimePreviewProps['createBridgeFactory'];
  readonly evidence: RuntimePreviewEvidence;
  readonly fallback: McpAppPreviewFallback;
  readonly input: McpAppJsonValue;
  readonly registrar: RuntimeAppPreviewProps['registerLifecycle'];
  readonly result: McpAppJsonValue;
}>;

type PreparedRuntimePreviewControllerOptions = Readonly<{
  readonly kind: 'runtime-prepared';
  readonly seed: RuntimePreviewPreparedSeed;
}>;

type RuntimePreviewDependencies = Pick<RuntimePreviewPreparedSeed, 'client' | 'createBridgeFactory'>;

const prepareRuntimePreviewSeed = (options: McpAppRuntimePreviewProps): RuntimePreviewPreparedSeed => {
  const input = detachedJson(options.run.input);
  const result = detachedJson(options.run.status === 'succeeded'
    ? options.run.result.modelVisible ?? options.run.result.agentVisible ?? options.run.result.native ?? null
    : null);
  return Object.freeze({
    client: options.client,
    createBridgeFactory: options.createBridgeFactory,
    evidence: runtimeEvidence(options),
    fallback: fallbackFor(undefined, input, result),
    input,
    registrar: options.registerLifecycle,
    result,
  });
};

const runtimeAuthority = (seed: RuntimePreviewPreparedSeed): RuntimePreviewAuthority => Object.freeze({
  client: seed.client,
  createBridgeFactory: seed.createBridgeFactory,
  evidence: seed.evidence,
});

const isPreparedRuntimePreviewControllerOptions = (
  options: McpAppPreviewControllerOptions | McpAppRuntimePreviewProps | PreparedRuntimePreviewControllerOptions,
): options is PreparedRuntimePreviewControllerOptions => 'kind' in options && options.kind === 'runtime-prepared';

const sameRuntimeEvidence = (left: RuntimePreviewEvidence, right: RuntimePreviewEvidence): boolean =>
  (left.app === undefined) === (right.app === undefined) &&
  left.app?.resourceUri === right.app?.resourceUri &&
  left.app?.surfaceId === right.app?.surfaceId &&
  (left.app === undefined || right.app === undefined || sameStableRuntimeBinding(left.app.mcpBinding, right.app.mcpBinding)) &&
  left.profileId === right.profileId &&
  left.profileVersion === right.profileVersion &&
  left.runId === right.runId &&
  left.runSurfaceId === right.runSurfaceId &&
  left.surfaceId === right.surfaceId &&
  sameRuntimeVector(left.vector, right.vector);

const sameRuntimeAuthority = (left: RuntimePreviewAuthority, right: RuntimePreviewAuthority): boolean =>
  left.client === right.client &&
  left.createBridgeFactory === right.createBridgeFactory &&
  sameRuntimeEvidence(left.evidence, right.evidence);

const runtimeFallbackState = (fallback: McpAppPreviewFallback): McpAppRuntimePreviewState =>
  Object.freeze({ fallback, kind: 'runtime', phase: 'fallback' });

const runtimeErrorState = (fallback: McpAppPreviewFallback, error: unknown, phase: 'error' | 'cleanup-failed' = 'error'): McpAppRuntimePreviewState =>
  Object.freeze({ fallback, kind: 'runtime', message: messageFor(error), phase });

const isRuntimeState = (state: McpAppPreviewControllerState): state is McpAppRuntimePreviewState =>
  'kind' in state && state.kind === 'runtime';

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
export class McpAppPreviewController<State extends McpAppPreviewControllerState = McpAppPreviewState> {
  readonly #client: McpAppPreviewClient | undefined;
  readonly #closeTimeoutMs: number | undefined;
  readonly #frameRelayFactory: McpAppFrameRelayFactory | undefined;
  readonly #input: McpAppJsonValue;
  readonly #request: McpAppPreviewCreateRequest | undefined;
  readonly #result: McpAppJsonValue;
  readonly #runtime: RuntimePreviewDependencies | undefined;
  readonly #runtimeEvidence: RuntimePreviewEvidence | undefined;
  readonly #runtimeFallback: McpAppPreviewFallback | undefined;
  readonly #runtimeLifecycle: RuntimeAppPreviewLifecycle | undefined;
  readonly #runtimeRendererRef: RefCallback<AppRendererHandle> | undefined;
  readonly #sessionId: string | undefined;
  readonly #listeners = new Set<(state: McpAppPreviewControllerState) => void>();
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #preview: McpAppPreviewResponse | undefined;
  #pendingDocumentPreview: McpAppPreviewResponse | undefined;
  #relay: McpAppFrameRelayLike | undefined;
  #runtimeBackendClosed = false;
  #runtimeBridgeClosed = false;
  #runtimeBridgeFactory: RuntimeAppBridgeFactory | undefined;
  #runtimePreview: McpAppPreviewSnapshot | undefined;
  #runtimeInvalidationReason: RuntimeInvalidationReason | undefined;
  #runtimeInvalidationUnsubscribe: (() => void) | undefined;
  #runtimeRenderer: AppRendererHandle | undefined;
  #runtimeRendererClosed = false;
  #runtimeRendererDelivery: Promise<void> | undefined;
  #runtimeRendererInvocation: RuntimeRendererInvocation | undefined;
  #runtimeRendererProps: RuntimeRendererProps | undefined;
  #started = false;
  #startPromise: Promise<void> | undefined;
  #state: McpAppPreviewControllerState = loadingState;

  constructor(options: McpAppPreviewControllerOptions | McpAppRuntimePreviewProps | PreparedRuntimePreviewControllerOptions) {
    if (isRuntimeOptions(options) || isPreparedRuntimePreviewControllerOptions(options)) {
      const seed = isPreparedRuntimePreviewControllerOptions(options) ? options.seed : prepareRuntimePreviewSeed(options);
      this.#runtime = Object.freeze({
        client: seed.client,
        createBridgeFactory: seed.createBridgeFactory,
      });
      this.#runtimeEvidence = seed.evidence;
      this.#input = seed.input;
      this.#result = seed.result;
      this.#runtimeFallback = seed.fallback;
      this.#runtimeLifecycle = Object.freeze({ close: () => this.close() });
      this.#runtimeRendererRef = (handle) => {
        if (handle === null) return;
        if (this.#runtimeRenderer === undefined || this.#runtimeRendererClosed) {
          this.#runtimeRenderer = handle;
          this.#runtimeRendererClosed = false;
          this.#deliverRuntimeRendererInvocation(handle);
        }
      };
      this.#runtimeRendererProps = undefined;
      this.#state = Object.freeze({ kind: 'runtime', phase: 'loading' });
      this.#client = undefined;
      this.#closeTimeoutMs = undefined;
      this.#frameRelayFactory = undefined;
      this.#request = undefined;
      this.#sessionId = undefined;
      return;
    }
    this.#runtime = undefined;
    this.#runtimeEvidence = undefined;
    this.#client = options.client;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#frameRelayFactory = options.frameRelayFactory;
    this.#input = detachedJson(options.input);
    this.#result = detachedJson(options.result);
    this.#request = createRequest(options, this.#input, this.#result);
    this.#sessionId = options.sessionId;
  }

  get state(): State {
    return this.#state as State;
  }

  /** The mounted runtime branch exposes only this stable close handle to its host. */
  get runtimeLifecycle(): RuntimeAppPreviewLifecycle | undefined {
    return this.#runtimeLifecycle;
  }

  /** The one AppRenderer ref is retained by this owner for canonical teardown. */
  get runtimeRendererRef(): RefCallback<AppRendererHandle> | undefined {
    return this.#runtimeRendererRef;
  }

  /** Stable renderer inputs prevent a same-authority parent render from recreating the official bridge. */
  get runtimeRendererProps(): RuntimeRendererProps | undefined {
    return this.#runtimeRendererProps;
  }

  get pendingDocumentPolicyRevision(): number | undefined {
    return this.#pendingDocumentPreview?.frame?.documentPolicy?.revision;
  }

  async consentChallenges(): Promise<readonly McpAppConsentChallenge[]> {
    const bindingId = this.#preview?.bindingId;
    const client = this.#client;
    const list = client?.consentChallenges;
    return bindingId === undefined || this.#closed || list === undefined || client === undefined ? Object.freeze([]) : list.call(client, bindingId);
  }

  async decideConsent(challengeId: string, approved: boolean): Promise<boolean> {
    const previous = this.#preview;
    const client = this.#client;
    const decide = client?.decideConsent;
    if (previous === undefined || this.#closed || decide === undefined || client === undefined) return false;
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
    this.#setState(stateFor(decision.preview, this.#input, this.#result));
    return true;
  }

  /** Publishes a refreshed document only after the browser committed its blank barrier. */
  commitDocumentRemount(revision: number): boolean {
    const preview = this.#pendingDocumentPreview;
    if (preview === undefined || preview.frame?.documentPolicy?.revision !== revision || this.#closed) return false;
    this.#pendingDocumentPreview = undefined;
    this.#preview = preview;
    this.#setState(stateFor(preview, this.#input, this.#result));
    return true;
  }

  subscribe(listener: (state: State) => void): () => void {
    const published = listener as (state: McpAppPreviewControllerState) => void;
    this.#listeners.add(published);
    try {
      listener(this.#state as State);
    } catch {
      // A display subscriber must never disrupt route cleanup.
    }
    return () => { this.#listeners.delete(published); };
  }

  start(): Promise<void> {
    if (this.#started) return this.#startPromise ?? completed;
    if (this.#closed) return completed;
    this.#started = true;
    this.#startPromise = this.#runtime === undefined ? this.#startArtifact() : this.#startRuntime();
    return this.#startPromise;
  }

  async #startArtifact(): Promise<void> {
    try {
      const client = this.#client;
      const request = this.#request;
      const sessionId = this.#sessionId;
      if (client === undefined || request === undefined || sessionId === undefined) return;
      const preview = await client.create(sessionId, request);
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

  #runtimeRequest(): Readonly<{ readonly expectedGenerationId: string; readonly profileId: 'chatgpt' | 'claude' | 'portable'; readonly runId: string }> | undefined {
    const evidence = this.#runtimeEvidence;
    const profileId = evidence === undefined ? undefined : runtimeProfileId(evidence.profileId);
    if (evidence === undefined || evidence.app === undefined || profileId === undefined || evidence.runSurfaceId !== evidence.surfaceId) return undefined;
    return Object.freeze({ expectedGenerationId: evidence.vector.runtimeGenerationId, profileId, runId: evidence.runId });
  }

  #runtimeReady(preview: McpAppPreviewSnapshot): preview is McpAppPreviewAppsSnapshot {
    const evidence = this.#runtimeEvidence;
    if (evidence === undefined || preview.kind !== 'apps') return false;
    const app = evidence.app;
    if (app === undefined || !canonicalUiResourceUri(app.resourceUri) || !canonicalUiResourceUri(preview.profile.resourceUri)) return false;
    return preview.profile.resourceUri === app.resourceUri &&
      preview.binding.profileId === evidence.profileId &&
      preview.binding.profileVersion === evidence.profileVersion &&
      preview.profile.descriptor.id === evidence.profileId &&
      preview.profile.descriptor.version === evidence.profileVersion &&
      preview.binding.runVector.runtimeGenerationId === evidence.vector.runtimeGenerationId &&
      preview.session.state === 'ready' &&
      sameRuntimeVector(preview.binding.runVector, evidence.vector) &&
      sameStableRuntimeBinding(preview.binding, app.mcpBinding) &&
      sameStableRuntimeBinding(preview.session.binding, app.mcpBinding);
  }

  #runtimeFailure(reason: string, error: unknown, phase: 'error' | 'cleanup-failed' = 'error'): void {
    this.#setState(runtimeErrorState(fallbackFor(undefined, this.#input, this.#result, reason), error, phase));
  }

  async #startRuntime(): Promise<void> {
    const runtime = this.#runtime;
    const request = this.#runtimeRequest();
    if (runtime === undefined || request === undefined) {
      if (!this.#closed) this.#setState(runtimeFallbackState(this.#runtimeFallback ?? fallbackFor(undefined, this.#input, this.#result)));
      return;
    }
    try {
      const preview = await runtime.client.createRuntime(request);
      this.#runtimePreview = preview;
      if (this.#closed) {
        await this.#cleanupRuntime();
        return;
      }
      if (!this.#runtimeReady(preview)) {
        if (!this.#closed) this.#setState(runtimeFallbackState(this.#runtimeFallback ?? fallbackFor(undefined, this.#input, this.#result)));
        await this.#cleanupRuntime();
        return;
      }
      this.#subscribeRuntimeInvalidations(preview);
      if (this.#closed) return;
      const policy = runtime.client.currentDocumentPolicy(preview.binding.id);
      if (policy.bindingId !== preview.binding.id || policy.snapshot !== preview.documentPolicy) {
        throw new McpAppPreviewDataError('runtime document policy does not match the created binding');
      }
      const bridgeFactory = runtime.createBridgeFactory(preview);
      this.#runtimeBridgeFactory = bridgeFactory;
      if (this.#closed) {
        await this.#cleanupRuntime();
        return;
      }
      const ref = this.#runtimeRendererRef;
      if (ref === undefined) throw new McpAppPreviewDataError('runtime renderer ref is unavailable');
      this.#runtimeRendererInvocation = runtimeRendererInvocation(this.#input, preview.result.appVisible);
      this.#runtimeRendererProps = Object.freeze({
        onError: (error) => { this.reportRuntimeRendererError(error); },
        ref,
        tool: Object.freeze({ inputSchema: Object.freeze({ type: 'object' }), name: preview.binding.serverName }) as McpAppRendererTool,
      });
      this.#setState(Object.freeze({
        bridgeFactory,
        documentPolicy: policy,
        fallback: this.#runtimeFallback ?? fallbackFor(undefined, this.#input, this.#result),
        kind: 'runtime',
        phase: 'ready',
        preview,
      }));
    } catch (error) {
      if (!this.#closed) this.#runtimeFailure('preview-error', error);
      if (this.#runtimePreview !== undefined) {
        try {
          await this.#cleanupRuntime();
        } catch (cleanupError) {
          if (!this.#closed) this.#runtimeFailure('preview-error', cleanupError, 'cleanup-failed');
        }
      }
    }
  }

  attachFrame(iframe: McpAppFrameIframe, frameWindow: McpAppFrameWindow): boolean {
    const state = this.#state;
    if (this.#closed || this.#relay !== undefined || isRuntimeState(state) || state.phase !== 'ready') return false;
    const { preview, resource } = state;
    const frame = preview.frame;
    if (frame === undefined) return false;
    try {
      const factory = this.#frameRelayFactory;
      const client = this.#client;
      if (factory === undefined || client === undefined) return false;
      const relay = factory({
        bindingId: preview.bindingId,
        ...(this.#closeTimeoutMs === undefined ? {} : { closeTimeoutMs: this.#closeTimeoutMs }),
        frame,
        iframe,
        onError: (error) => { this.#relayError(error); },
        resource,
        routes: client,
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
    if (this.#runtime !== undefined) {
      const attempt = this.#closePromise;
      void attempt.catch(() => {
        if (this.#closePromise === attempt) this.#closePromise = undefined;
      });
    }
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    await this.#startPromise;
    if (this.#runtime !== undefined) {
      try {
        await this.#cleanupRuntime();
      } catch (error) {
        this.#runtimeFailure(this.#runtimeInvalidationReason ?? 'preview-error', error, 'cleanup-failed');
        throw error;
      }
      return;
    }
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
      await this.#client?.forceClose(bindingId);
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

  #clearRuntimeInvalidationSubscription(): void {
    const unsubscribe = this.#runtimeInvalidationUnsubscribe;
    this.#runtimeInvalidationUnsubscribe = undefined;
    unsubscribe?.();
  }

  #matchesRuntimeInvalidation(
    preview: McpAppPreviewSnapshot,
    details: McpAppRuntimeInvalidationDetails,
  ): details is McpAppRuntimeInvalidationDetails & Readonly<{ readonly reason: RuntimeInvalidationReason }> {
    return details.bindingId === preview.binding.id &&
      (details.reason === 'session-restarted' || details.reason === 'registry-replay-gap') &&
      details.sessionId === preview.binding.sessionId &&
      details.sessionRevision === preview.binding.sessionRevision &&
      details.state === 'revoked';
  }

  /** A server-side revocation owns the backend binding; only local resources remain to close. */
  #subscribeRuntimeInvalidations(preview: McpAppPreviewSnapshot): void {
    const runtime = this.#runtime;
    if (runtime === undefined || this.#closed || this.#runtimeInvalidationUnsubscribe !== undefined) return;
    const unsubscribe = runtime.client.subscribeInvalidations((details) => {
      if (!this.#matchesRuntimeInvalidation(preview, details) || this.#runtimeBackendClosed) return;
      const closing = this.#closed && this.#closePromise !== undefined;
      if (this.#closed && !closing) return;
      this.#runtimeBackendClosed = true;
      this.#runtimeInvalidationReason = details.reason;
      if (closing) return;
      this.#closed = true;
      this.#runtimeFailure(details.reason, new Error(
        details.reason === 'registry-replay-gap'
          ? 'Runtime MCP App event replay gap. Run again to create a new preview.'
          : 'Runtime MCP App session restarted. Run again to create a new preview.',
      ));
      const cleanup = this.#cleanupRuntime();
      this.#closePromise = cleanup;
      void cleanup.catch((error: unknown) => {
        if (this.#closePromise !== cleanup) return;
        this.#runtimeFailure(details.reason, error, 'cleanup-failed');
        this.#closePromise = undefined;
      });
    });
    this.#runtimeInvalidationUnsubscribe = unsubscribe;
    if (this.#closed) this.#clearRuntimeInvalidationSubscription();
  }

  /** AppRenderer error callbacks flow through the same immutable fallback and close authority. */
  reportRuntimeRendererError(error: unknown): void {
    if (this.#runtime === undefined || this.#closed) return;
    this.#runtimeFailure('preview-error', error);
    void this.close().catch(() => undefined);
  }

  /** Delivers the admitted invocation once, in protocol order, to the first mounted renderer. */
  #deliverRuntimeRendererInvocation(handle: AppRendererHandle): void {
    const invocation = this.#runtimeRendererInvocation;
    if (this.#closed || invocation === undefined || this.#runtimeRendererDelivery !== undefined) return;
    const delivery = (async () => {
      await handle.sendToolInput(invocation.input);
      if (this.#closed || this.#runtimeRenderer !== handle || this.#runtimeRendererClosed) return;
      await handle.sendToolResult(invocation.result);
    })();
    this.#runtimeRendererDelivery = delivery;
    void delivery.catch((error: unknown) => {
      if (this.#runtimeRendererDelivery === delivery) this.reportRuntimeRendererError(error);
    });
  }

  async #cleanupRuntime(): Promise<void> {
    const failures: unknown[] = [];
    const delivery = this.#runtimeRendererDelivery;
    if (delivery !== undefined) await delivery.catch(() => undefined);
    const renderer = this.#runtimeRenderer;
    if (!this.#runtimeRendererClosed && renderer !== undefined) {
      try {
        await renderer.teardown();
        this.#runtimeRendererClosed = true;
        if (this.#runtimeRenderer === renderer) this.#runtimeRenderer = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.#runtimeBridgeClosed && this.#runtimeBridgeFactory !== undefined) {
      try {
        await this.#runtimeBridgeFactory.close();
        this.#runtimeBridgeClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    const bindingId = this.#runtimePreview?.binding.id;
    if (!this.#runtimeBackendClosed && bindingId !== undefined && this.#runtime !== undefined) {
      try {
        const state = this.#state;
        if (isRuntimeState(state) && state.phase === 'ready') {
          this.#setState(Object.freeze({ kind: 'runtime', phase: 'closing' }));
        }
        await this.#runtime.client.closeRuntime(bindingId);
        this.#runtimeBackendClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'MCP App runtime preview cleanup failed.');
    this.#clearRuntimeInvalidationSubscription();
  }

  #setState(state: McpAppPreviewControllerState): void {
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

export function createMcpAppPreviewController(options: McpAppPreviewControllerOptions): McpAppPreviewController<McpAppPreviewState>;
export function createMcpAppPreviewController(options: McpAppRuntimePreviewProps): McpAppPreviewController<McpAppRuntimePreviewState>;
export function createMcpAppPreviewController(options: McpAppPreviewControllerOptions | McpAppRuntimePreviewProps): McpAppPreviewController<McpAppPreviewState> | McpAppPreviewController<McpAppRuntimePreviewState> {
  return isRuntimeOptions(options)
    ? new McpAppPreviewController<McpAppRuntimePreviewState>(options)
    : new McpAppPreviewController<McpAppPreviewState>(options);
}

type RuntimePreviewComponentOwner = {
  readonly authority: RuntimePreviewAuthority;
  readonly controller: McpAppPreviewController<McpAppRuntimePreviewState>;
  readonly lifecycle: RuntimeAppPreviewLifecycle;
  readonly seed: RuntimePreviewPreparedSeed;
  readonly registrar: RuntimeAppPreviewProps['registerLifecycle'];
  readonly completion: Promise<void>;
  readonly complete: () => void;
  readonly resolvedClose: Promise<void>;
  closeAttempt: Promise<void> | undefined;
  cleanupToken: { cancelled: boolean } | undefined;
  completed: boolean;
  registered: boolean;
  unregistered: boolean;
  unregister: (() => void) | undefined;
};

type MutableRuntimePreviewComponentOwner = Omit<RuntimePreviewComponentOwner, 'lifecycle'> & {
  lifecycle: RuntimeAppPreviewLifecycle;
};

const createPreparedRuntimePreviewController = (seed: RuntimePreviewPreparedSeed): McpAppPreviewController<McpAppRuntimePreviewState> =>
  new McpAppPreviewController<McpAppRuntimePreviewState>(Object.freeze({ kind: 'runtime-prepared', seed }));

const createRuntimePreviewComponentOwner = (seed: RuntimePreviewPreparedSeed): RuntimePreviewComponentOwner => {
  const controller = createPreparedRuntimePreviewController(seed);
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const owner: MutableRuntimePreviewComponentOwner = {
    authority: runtimeAuthority(seed),
    closeAttempt: undefined,
    cleanupToken: undefined,
    complete: () => { resolveCompletion?.(); },
    completed: false,
    completion,
    controller,
    lifecycle: undefined as unknown as RuntimeAppPreviewLifecycle,
    seed,
    registrar: seed.registrar,
    registered: false,
    resolvedClose: completed,
    unregistered: false,
    unregister: undefined,
  };
  const lifecycle: RuntimeAppPreviewLifecycle = Object.freeze({
    close: () => {
      if (owner.completed) return owner.resolvedClose;
      if (owner.closeAttempt !== undefined) return owner.closeAttempt;
      const attempt = owner.controller.close();
      owner.closeAttempt = attempt;
      void attempt.then(
        () => {
          if (owner.closeAttempt !== attempt) return;
          owner.closeAttempt = undefined;
          owner.completed = true;
          try {
            if (!owner.unregistered) {
              owner.unregistered = true;
              const unregister = owner.unregister;
              owner.unregister = undefined;
              unregister?.();
            }
          } catch {
            // Host unregister errors cannot retain the completed resource owner.
          } finally {
            owner.complete();
          }
        },
        () => {
          if (owner.closeAttempt === attempt) owner.closeAttempt = undefined;
        },
      );
      return attempt;
    },
  });
  owner.lifecycle = lifecycle;
  return owner;
};

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

/** Runtime configuration is already admitted and is rendered as inspection-only evidence. */
const RuntimeProfileInspection = ({
  configuration,
  descriptor,
}: Readonly<{
  readonly configuration: McpAppPreviewAppsSnapshot['profile']['configExtensions'];
  readonly descriptor: McpAppPreviewAppsSnapshot['profile']['descriptor'];
}>) => {
  return <>
    <section aria-label="Simulated MCP App profile" className="mcp-app-preview__runtime-inspection">
      <h3>Simulated MCP App profile</h3>
      <dl className="mcp-app-preview__runtime-inspection-details">
        <div><dt>Profile</dt><dd>{descriptor.label}</dd></div>
        <div><dt>Version</dt><dd>{descriptor.version}</dd></div>
        <div><dt>Evidence</dt><dd>{descriptor.evidence === 'simulated' ? 'Simulated' : descriptor.evidence}</dd></div>
        <div><dt>Host parity</dt><dd>{descriptor.claimsRealHostParity ? 'Claims real-host parity' : 'Not certified for real-host parity'}</dd></div>
      </dl>
    </section>
    <section aria-label="Registered configuration" className="mcp-app-preview__runtime-inspection">
      <h3>Registered configuration</h3>
      <dl className="mcp-app-preview__runtime-inspection-details">
        <div><dt>Source revision</dt><dd>{configuration.sourceRevision}</dd></div>
      </dl>
      <ol className="mcp-app-preview__runtime-configurations">
        {configuration.entries.map((entry) => <li key={entry.key} className="mcp-app-preview__runtime-configuration">
          <dl className="mcp-app-preview__runtime-inspection-details">
            <div><dt>Key</dt><dd>{entry.key}</dd></div>
            <div><dt>Target</dt><dd>{entry.target}</dd></div>
            <div><dt>ID</dt><dd>{entry.id}</dd></div>
            <div><dt>Provenance</dt><dd>{entry.provenance.kind}</dd></div>
            <div><dt>Source path</dt><dd>{entry.provenance.sourcePath}</dd></div>
          </dl>
        </li>)}
      </ol>
    </section>
  </>;
};

/** Renders only the validated public result from the currently admitted App binding. */
const RuntimeOperationInspection = ({
  preview,
  traces,
}: Readonly<{
  readonly preview: McpAppPreviewAppsSnapshot;
  readonly traces: readonly RuntimeAppBridgeOperationTrace[];
}>) => {
  const trace = [...traces].reverse().find((candidate) =>
    candidate.bindingId === preview.binding.id &&
    candidate.sessionId === preview.binding.sessionId &&
    candidate.sessionRevision === preview.binding.sessionRevision &&
    candidate.registryRevision === preview.binding.registryRevision &&
    candidate.vector.artifactEpochId === preview.binding.runVector.artifactEpochId &&
    candidate.vector.runtimeGenerationId === preview.binding.runVector.runtimeGenerationId &&
    candidate.vector.sourceRevision === preview.binding.runVector.sourceRevision &&
    candidate.vector.stateVersion === preview.binding.runVector.stateVersion,
  );
  if (trace === undefined) return null;
  return <section aria-label="Executed by current implementation" className="mcp-app-preview__runtime-inspection">
    <h3>Executed by current implementation</h3>
    <dl className="mcp-app-preview__runtime-inspection-details">
      <div><dt>Operation ID</dt><dd>{trace.operationId}</dd></div>
      <div><dt>Operation</dt><dd>{trace.kind}</dd></div>
      {trace.name === undefined ? null : <div><dt>Tool</dt><dd>{trace.name}</dd></div>}
      <div><dt>Session ID</dt><dd>{trace.sessionId}</dd></div>
      <div><dt>Session revision</dt><dd>{trace.sessionRevision}</dd></div>
      <div><dt>Registry revision</dt><dd>{trace.registryRevision}</dd></div>
      <div><dt>Generation ID</dt><dd>{trace.vector.runtimeGenerationId}</dd></div>
      <div><dt>Source revision</dt><dd>{trace.vector.sourceRevision}</dd></div>
      {trace.vector.artifactEpochId === undefined ? null : <div><dt>Artifact epoch</dt><dd>{trace.vector.artifactEpochId}</dd></div>}
      <div><dt>State version</dt><dd>{trace.vector.stateVersion}</dd></div>
    </dl>
  </section>;
};

export function McpAppPreview(props: McpAppPreviewProps): React.ReactNode;
export function McpAppPreview(props: McpAppRuntimePreviewProps): React.ReactNode;
export function McpAppPreview(props: McpAppPreviewProps | McpAppRuntimePreviewProps): React.ReactNode;
export function McpAppPreview(props: McpAppPreviewProps | McpAppRuntimePreviewProps): React.ReactNode {
  const runtimeProps = isRuntimePreviewProps(props) ? props : undefined;
  const artifactProps = isRuntimePreviewProps(props) ? undefined : props;
  const controller = useRef<McpAppPreviewController<McpAppPreviewControllerState> | undefined>(undefined);
  const [runtimeOwner, setRuntimeOwner] = useState<RuntimePreviewComponentOwner | undefined>(undefined);
  const latestRuntimeProps = useRef<McpAppRuntimePreviewProps | undefined>(undefined);
  const latestRuntimeSeed = useRef<RuntimePreviewPreparedSeed | undefined>(undefined);
  const runtimeManagerMounted = useRef(false);
  const runtimeRetiringOwner = useRef<RuntimePreviewComponentOwner | undefined>(undefined);
  const runtimeStateOwner = useRef<McpAppPreviewController<McpAppRuntimePreviewState> | undefined>(undefined);
  const runtimeController = runtimeOwner?.controller;
  const [state, setState] = useState<McpAppPreviewControllerState>(runtimeController?.state ?? loadingState);
  const iframe = useRef<HTMLIFrameElement>(null);
  const frameRelayFactory = artifactProps?.frameRelayFactory ?? createMcpAppFrameRelay;
  const browserWindow = artifactProps?.frameWindow ?? (typeof window === 'undefined' ? undefined : window);
  const title = artifactProps?.title ?? 'MCP App preview';

  useLayoutEffect(() => {
    runtimeManagerMounted.current = true;
    return () => { runtimeManagerMounted.current = false; };
  }, []);

  useLayoutEffect(() => {
    if (latestRuntimeProps.current !== runtimeProps) {
      latestRuntimeProps.current = runtimeProps;
      latestRuntimeSeed.current = runtimeProps === undefined ? undefined : prepareRuntimePreviewSeed(runtimeProps);
    }
    const incomingRuntimeSeed = latestRuntimeSeed.current;
    if (runtimeOwner === undefined) {
      if (incomingRuntimeSeed !== undefined) {
        setRuntimeOwner(createRuntimePreviewComponentOwner(incomingRuntimeSeed));
      }
      return;
    }
    if (incomingRuntimeSeed !== undefined && sameRuntimeAuthority(runtimeOwner.authority, runtimeAuthority(incomingRuntimeSeed))) return;
    if (runtimeRetiringOwner.current === runtimeOwner) return;
    runtimeRetiringOwner.current = runtimeOwner;
    void runtimeOwner.lifecycle.close().catch(() => undefined);
    void runtimeOwner.completion.then(() => {
      if (!runtimeManagerMounted.current || runtimeRetiringOwner.current !== runtimeOwner) return;
      runtimeRetiringOwner.current = undefined;
      const next = latestRuntimeSeed.current;
      setRuntimeOwner(next === undefined ? undefined : createRuntimePreviewComponentOwner(next));
    });
  }, [runtimeProps, runtimeOwner]);

  useLayoutEffect(() => {
    if (runtimeOwner === undefined) return;
    if (runtimeOwner.cleanupToken !== undefined) {
      runtimeOwner.cleanupToken.cancelled = true;
      runtimeOwner.cleanupToken = undefined;
    }
    if (!runtimeOwner.registered) {
      runtimeOwner.unregister = runtimeOwner.registrar?.(runtimeOwner.lifecycle);
      runtimeOwner.registered = true;
    }
    return () => {
      const token = { cancelled: false };
      runtimeOwner.cleanupToken = token;
      setTimeout(() => {
        if (token.cancelled) return;
        void runtimeOwner.lifecycle.close().catch(() => undefined);
      }, 0);
    };
  }, [runtimeOwner]);

  useEffect(() => {
    if (runtimeOwner !== undefined) {
      let subscribed = true;
      const unsubscribe = runtimeOwner.controller.subscribe((next) => {
        if (subscribed) {
          runtimeStateOwner.current = runtimeOwner.controller;
          setState(next);
        }
      });
      void runtimeOwner.controller.start().catch(() => undefined);
      return () => {
        subscribed = false;
        unsubscribe();
      };
    }
    if (artifactProps === undefined) return;
    const current = createMcpAppPreviewController({
      client: artifactProps.client,
      ...(artifactProps.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: artifactProps.closeTimeoutMs }),
      frameRelayFactory,
      host: artifactProps.host,
      input: artifactProps.input,
      ...(artifactProps.previewProfile === undefined ? {} : { previewProfile: artifactProps.previewProfile }),
      result: artifactProps.result,
      sessionId: artifactProps.sessionId,
      toolName: artifactProps.toolName,
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
  }, [artifactProps?.client, artifactProps?.closeTimeoutMs, artifactProps?.host, artifactProps?.input, artifactProps?.previewProfile, artifactProps?.result, artifactProps?.sessionId, artifactProps?.toolName, frameRelayFactory, runtimeOwner]);

  useEffect(() => {
    if (runtimeController !== undefined || isRuntimeState(state) || state.phase !== 'ready' || browserWindow === undefined || iframe.current === null) return;
    controller.current?.attachFrame(iframe.current, browserWindow);
  }, [browserWindow, runtimeController, state]);

  if (runtimeProps !== undefined || runtimeOwner !== undefined) {
    const runtimeState = runtimeController !== undefined && runtimeStateOwner.current !== runtimeController
      ? runtimeController.state
      : isRuntimeState(state) ? state : runtimeController?.state;
    const documentPermissions = runtimeState?.phase === 'ready'
      ? runtimeDocumentPermissionNames(runtimeState.preview)
      : Object.freeze([]) as readonly RuntimeDocumentPermission[];
    const fallback = runtimeState !== undefined && (runtimeState.phase === 'fallback' || runtimeState.phase === 'error' || runtimeState.phase === 'cleanup-failed')
      ? runtimeState.fallback
      : undefined;
    return (
      <section aria-busy={runtimeState?.phase === 'loading' || runtimeState?.phase === 'closing'} aria-label={title} className="mcp-app-preview">
        <header className="mcp-app-preview__header"><h2>{title}</h2></header>
        {runtimeState?.phase === 'loading' ? <p role="status">Creating MCP App preview…</p> : null}
        {runtimeState?.phase === 'closing' ? <p role="status">Closing MCP App preview…</p> : null}
        {runtimeState?.phase === 'error' || runtimeState?.phase === 'cleanup-failed' ? <p role="alert">{runtimeState.message}</p> : null}
        {runtimeState?.phase === 'ready' && documentPermissions.length > 0 ? <section aria-label="Runtime App document permissions" className="mcp-app-preview__runtime-inspection">
          <h3>Runtime App permissions</h3>
          <p>Declared document permissions are unavailable in this isolated Runtime App surface.</p>
          <ul>{documentPermissions.map((permission) => <li key={permission}>{runtimeDocumentPermissionLabel(permission)} unavailable</li>)}</ul>
        </section> : null}
        {fallback === undefined ? null : (
          <section aria-label="MCP App fallback" className="mcp-app-preview__fallback">
            <p role="status">Interactive App rendering is unavailable ({fallback.reason}). Showing the ordinary tool result instead.</p>
            <details open><summary>Tool input</summary><pre>{json(fallback.input)}</pre></details>
            <details open><summary>Tool result</summary><pre>{json(fallback.result)}</pre></details>
          </section>
        )}
        {runtimeState?.phase === 'ready' && runtimeController !== undefined && runtimeOwner !== undefined && runtimeController.runtimeRendererProps !== undefined ? <>
          <SecureAppRenderer
            bindingId={runtimeState.preview.binding.id}
            bootstrapUrl={runtimeState.preview.clientSurface.bootstrapUrl}
            bridgeFactory={runtimeState.bridgeFactory}
            documentPolicy={runtimeState.documentPolicy}
            policyClient={runtimeOwner.seed.client}
            rendererProps={runtimeController.runtimeRendererProps}
          />
          <RuntimeProfileInspection
            configuration={runtimeState.preview.profile.configExtensions}
            descriptor={runtimeState.preview.profile.descriptor}
          />
          <RuntimeOperationInspection
            preview={runtimeState.preview}
            traces={runtimeProps?.operationTraces ?? []}
          />
          <section aria-label="Runtime App result" className="mcp-app-preview__fallback">
            <details open><summary>Tool input</summary><pre>{json(runtimeState.fallback.input)}</pre></details>
            <details open><summary>Tool result</summary><pre>{json(runtimeState.fallback.result)}</pre></details>
          </section>
        </> : null}
      </section>
    );
  }

  const artifactState = state as McpAppArtifactPreviewState;
  const fallback = artifactState.phase === 'fallback' || artifactState.phase === 'error' ? artifactState.fallback : undefined;
  const profile = artifactState.phase === 'ready' || artifactState.phase === 'fallback' ? <Profile profile={artifactState.preview.profile} /> : null;
  return (
    <section aria-busy={artifactState.phase === 'loading'} aria-label={title} className="mcp-app-preview">
      <header className="mcp-app-preview__header"><h2>{title}</h2>{profile}</header>
      {artifactState.phase === 'loading' ? <p role="status">Creating MCP App preview…</p> : null}
      {artifactState.phase === 'error' ? <p role="alert">{artifactState.message}</p> : null}
      {fallback === undefined ? null : (
        <section aria-label="MCP App fallback" className="mcp-app-preview__fallback">
          <p role="status">Interactive App rendering is unavailable ({fallback.reason}). Showing the ordinary tool result instead.</p>
          <details open><summary>Tool input</summary><pre>{json(fallback.input)}</pre></details>
          <details open><summary>Tool result</summary><pre>{json(fallback.result)}</pre></details>
        </section>
      )}
      {artifactState.phase === 'ready' && artifactState.preview.frame !== undefined
        ? <McpAppPreviewFrame key={artifactState.preview.frame.documentPolicy?.revision ?? 0} frame={artifactState.preview.frame} iframeRef={iframe} title={title} />
        : null}
    </section>
  );
}
