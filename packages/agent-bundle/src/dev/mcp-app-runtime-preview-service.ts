import {
  McpAppRuntimeBindingService,
  type McpAppBoundOperationResult,
  type McpAppPublicRuntimeVector,
  type McpAppProfileId,
  type McpAppRuntimeBindingSnapshot,
} from './mcp-app-runtime-binding-service.ts';
import { parseMcpAppResource, type McpAppParsedResource } from './mcp-app-bridge.ts';
import {
  cloneMcpAppFiniteJson,
  inspectMcpAppMetadata,
  isMcpAppToolVisible,
  mergeMcpAppResourceMetadata,
  projectMcpAppResult,
  selectMcpAppResourceReference,
  type McpAppJsonValue,
  type McpAppMetadataInspection,
  type McpAppResultInspection,
} from './mcp-app-metadata.ts';
import {
  resolveMcpAppHostProfile,
  type McpAppAppsHostProfile,
  type McpAppConfigExtensionInspectionOptions,
  type McpAppFallbackHostProfile,
} from './mcp-app-host-profiles.ts';
import {
  createMcpAppConsentActionDigest,
  createMcpAppConsentAuthority,
  createMcpAppDocumentPolicySnapshot,
  type McpAppConsentAuthority,
  type McpAppConsentChallenge,
  type McpAppConsentGrant,
  type McpAppConsentRequest,
  type McpAppDocumentPolicySnapshot,
} from './mcp-app-sandbox.ts';
import type { DevRuntimeClientSurfaceProxyBinding, DevRuntimeMcpRegistryMessage, DevRuntimeMcpSessionView, DevRuntimeSession } from './runtime-provider.ts';
import type { DevRuntimeMcpAppRunBinding, DevRuntimeMcpConnectionState, RuntimeVector } from './runtime-protocol.ts';

export type McpAppBindingOperation =
  | Readonly<{ readonly kind: 'tools/list' }>
  | Readonly<{ readonly kind: 'resources/list' }>
  | Readonly<{ readonly arguments?: McpAppJsonValue; readonly consentId?: string; readonly kind: 'tools/call'; readonly name: string }>
  | Readonly<{ readonly kind: 'resources/read'; readonly uri: string }>;

export interface CreateMcpAppPreviewRequest {
  readonly expectedGenerationId: string;
  readonly profileId: McpAppProfileId;
  readonly runId: string;
}

export interface McpAppPreviewSessionSnapshot {
  readonly binding: DevRuntimeMcpAppRunBinding;
  readonly connection: DevRuntimeMcpConnectionState;
  readonly state: 'ready';
}

export interface McpAppOperationTrace {
  readonly kind: McpAppBindingOperation['kind'];
  readonly operationId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly vector: McpAppPublicRuntimeVector;
}

export interface McpAppPreviewSnapshotBase {
  readonly binding: McpAppRuntimeBindingSnapshot;
  readonly metadata: Readonly<{ readonly resource: McpAppMetadataInspection; readonly result: McpAppMetadataInspection; readonly tool: McpAppMetadataInspection }>;
  readonly operations: readonly McpAppOperationTrace[];
  readonly result: McpAppResultInspection;
  readonly session: McpAppPreviewSessionSnapshot;
}

export interface McpAppPreviewAppsSnapshot extends McpAppPreviewSnapshotBase {
  readonly clientSurface: Readonly<{ readonly bootstrapUrl: string; readonly origin: string; readonly webSocketPath: '/rsbuild-hmr' }>;
  readonly documentPolicy: McpAppDocumentPolicySnapshot;
  readonly kind: 'apps';
  readonly profile: McpAppAppsHostProfile;
  readonly resource: McpAppParsedResource;
}

export interface McpAppPreviewFallbackSnapshot extends McpAppPreviewSnapshotBase {
  readonly kind: 'fallback';
  readonly profile: McpAppFallbackHostProfile;
}

export type McpAppPreviewSnapshot = McpAppPreviewAppsSnapshot | McpAppPreviewFallbackSnapshot;

export interface McpAppOperationResponse { readonly result: McpAppBoundOperationResult; }

export interface McpAppConsentCreatedResponse {
  readonly challenge: McpAppConsentChallenge;
  readonly documentPolicy: McpAppDocumentPolicySnapshot;
}

export interface McpAppConsentDecisionResponse {
  readonly documentPolicy: McpAppDocumentPolicySnapshot;
  readonly grant: McpAppConsentGrant | undefined;
}

export interface McpAppRuntimeInvalidationDetails {
  readonly bindingId: string;
  readonly reason: 'manual-close' | 'registry-replay-gap' | 'restart-failed' | 'runtime-shutdown' | 'session-closed' | 'session-restarted';
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly state: 'revoked';
}

export interface McpAppRuntimeRoutePreviewService {
  close(bindingId: string): Promise<void>;
  create(request: CreateMcpAppPreviewRequest): Promise<McpAppPreviewSnapshot>;
  createConsent(bindingId: string, request: McpAppConsentRequest): Promise<McpAppConsentCreatedResponse>;
  decideConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny'): Promise<McpAppConsentDecisionResponse>;
  /** Server-only mutation barrier for the sole manual runtime MCP route owner. */
  flushRegistry?(): Promise<void>;
  get(bindingId: string): McpAppPreviewSnapshot | undefined;
  /** A bounded local tombstone only; it distinguishes revoked from unknown IDs. */
  isRevoked?(bindingId: string): boolean;
  operate(bindingId: string, operation: McpAppBindingOperation): Promise<McpAppOperationResponse>;
}

/** Closed, phase-safe diagnostics intended for the authenticated runtime App route. */
export class McpAppRuntimePreviewError extends Error {
  readonly code: 'AB8201' | 'AB8203' | 'AB8204';
  readonly status: 400 | 404 | 409;

  constructor(code: McpAppRuntimePreviewError['code'], message: string, status: McpAppRuntimePreviewError['status']) {
    super(message);
    this.name = 'McpAppRuntimePreviewError';
    this.code = code;
    this.status = status;
  }
}

export interface McpAppRuntimePreviewServiceOptions {
  readonly bindingAuthority: McpAppRuntimeBindingService;
  readonly configExtensions: () => McpAppConfigExtensionInspectionOptions;
  /** This opens the foreground-owned proxy; the runtime service never receives a provider endpoint. */
  readonly openRuntimeClientSurface: (surfaceId: string) => Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
  readonly runtime: DevRuntimeSession;
  readonly emit?: (details: McpAppRuntimeInvalidationDetails) => void;
}

interface PreviewEntry {
  readonly binding: McpAppRuntimeBindingSnapshot;
  readonly consent: McpAppConsentAuthority;
  readonly proxy?: DevRuntimeClientSurfaceProxyBinding;
  readonly runBinding: DevRuntimeMcpAppRunBinding;
  readonly session: DevRuntimeMcpSessionView;
  readonly snapshot: McpAppPreviewSnapshot;
  activeOperations: number;
  closed: boolean;
  closeAttempt?: Promise<void>;
  documentPolicyRevision: number;
}

const maxConcurrentOperations = 4;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value;
};

const frozenJson = (value: unknown, label: string): McpAppJsonValue => cloneMcpAppFiniteJson(value, label);

const runBindingEquals = (stored: DevRuntimeMcpAppRunBinding, live: DevRuntimeMcpAppRunBinding): boolean =>
  stored.definitionDigest === live.definitionDigest && stored.registryRevision === live.registryRevision &&
  stored.serverDigest === live.serverDigest && stored.serverName === live.serverName &&
  stored.sessionId === live.sessionId && stored.sessionRevision === live.sessionRevision &&
  stored.target === live.target && stored.transportDigest === live.transportDigest;

const defaultHost = (tool: McpAppJsonValue) => Object.freeze({
  availableDisplayModes: Object.freeze(['inline']),
  containerDimensions: Object.freeze({ height: 720, width: 1_024 }),
  deviceCapabilities: Object.freeze({}),
  displayMode: 'inline',
  locale: 'en-US',
  platform: 'agent-bundle-workbench',
  safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
  styles: Object.freeze({}),
  theme: 'light' as const,
  timeZone: 'UTC',
  toolInfo: Object.freeze({ tool }),
  userAgent: 'agent-bundle-runtime-mcp-app/1',
});

const operation = (value: McpAppBoundOperationResult, kind: McpAppBindingOperation['kind']): McpAppOperationTrace => Object.freeze({
  kind,
  operationId: value.operationId,
  sessionId: value.sessionId,
  sessionRevision: value.sessionRevision,
  vector: value.vector,
});

const listItems = (value: McpAppJsonValue, key: 'tools' | 'resources'): readonly McpAppJsonValue[] => {
  if (!isRecord(value) || !Array.isArray(value[key])) throw new Error(`Runtime MCP ${key} response is invalid.`);
  return value[key] as readonly McpAppJsonValue[];
};

const metadataOf = (value: McpAppJsonValue): unknown => isRecord(value) ? value._meta : undefined;

/** Provider-owned preview lane for an already-succeeded runtime App run. */
export class McpAppRuntimePreviewService implements McpAppRuntimeRoutePreviewService {
  readonly #bindingAuthority: McpAppRuntimeBindingService;
  readonly #configExtensions: () => McpAppConfigExtensionInspectionOptions;
  readonly #emit: ((details: McpAppRuntimeInvalidationDetails) => void) | undefined;
  readonly #entries = new Map<string, PreviewEntry>();
  readonly #invalidationReasons = new Map<string, McpAppRuntimeInvalidationDetails['reason']>();
  readonly #openRuntimeClientSurface: McpAppRuntimePreviewServiceOptions['openRuntimeClientSurface'];
  readonly #runtime: DevRuntimeSession;
  readonly #subscription: ReturnType<DevRuntimeSession['mcpRegistry']['subscribe']>;
  readonly #revokedBindings = new Set<string>();
  #closed = false;
  #lastRegistrySequence = 0;
  #registryTail: Promise<void> = Promise.resolve();
  #replayGap = false;

  constructor(options: McpAppRuntimePreviewServiceOptions) {
    this.#bindingAuthority = options.bindingAuthority;
    this.#configExtensions = options.configExtensions;
    this.#emit = options.emit;
    this.#openRuntimeClientSurface = options.openRuntimeClientSurface;
    this.#runtime = options.runtime;
    this.#subscription = this.#runtime.mcpRegistry.subscribe({ afterSequence: 0 }, (message) => {
      const operation = this.#registryTail.then(
        async () => this.#onRegistry(message),
        async () => this.#onRegistry(message),
      );
      // Registry listeners are deliberately synchronous.  Keep their async
      // consequences ordered, and fail closed rather than leaving an
      // unhandled rejection that can let a later create bypass a bad replay.
      this.#registryTail = operation.catch(async () => {
        this.#replayGap = true;
        await Promise.allSettled([...this.#entries.keys()].map(async (id) => this.#closeEntry(id, 'registry-replay-gap')));
      });
    });
  }

  get(bindingId: string): McpAppPreviewSnapshot | undefined {
    return this.#entries.get(bindingId)?.snapshot;
  }

  isRevoked(bindingId: string): boolean { return this.#revokedBindings.has(bindingId); }

  async flushRegistry(): Promise<void> { await this.#registryTail; }

  async create(request: CreateMcpAppPreviewRequest): Promise<McpAppPreviewSnapshot> {
    if (this.#closed || this.#replayGap) throw new Error('Runtime MCP App previews are not available.');
    const runId = nonempty(request.runId, 'Runtime MCP App run id');
    const expectedGenerationId = nonempty(request.expectedGenerationId, 'Runtime MCP App expected generation');
    if (request.profileId !== 'portable' && request.profileId !== 'chatgpt' && request.profileId !== 'claude') throw new TypeError('Unsupported MCP App profile.');
    const run = this.#runtime.run(runId);
    if (run === undefined || run.status !== 'succeeded' || run.result.app === undefined) {
      throw new McpAppRuntimePreviewError('AB8201', 'Runtime MCP App run is not available.', 404);
    }
    if (run.vector.runtimeGenerationId !== expectedGenerationId) {
      throw new McpAppRuntimePreviewError('AB8204', 'Runtime MCP App run generation does not match the expected generation.', 409);
    }
    const runBinding = run.result.app.mcpBinding;
    const session = this.#runtime.mcpRegistry.session(runBinding.sessionId);
    if (session === undefined) throw new Error('Runtime MCP App stable session is not available.');
    const live = session.snapshot();
    if (live.state !== 'ready' || !runBindingEquals(runBinding, live.binding)) throw new Error('Runtime MCP App stable session does not match stored run evidence.');
    if (live.binding.providerSessionId !== run.vector.providerSessionId || live.binding.stateStoreId !== run.vector.stateStoreId) {
      throw new Error('Runtime MCP App stable session has foreign provider/state authority.');
    }
    if (live.connection.protocolEra === undefined || live.connection.protocolVersion === undefined || live.connection.capabilities === undefined) {
      throw new Error('Runtime MCP App stable session has incomplete negotiation.');
    }
    const result = projectMcpAppResult(run.result.protocol);
    const createdBinding = { id: undefined as string | undefined };
    const binding = await this.#bindingAuthority.createBinding({
      // This callback is invoked by the binding authority while its own
      // release is in flight. It must never call closeBinding recursively.
      onTeardown: () => createdBinding.id === undefined ? undefined : this.#bindingReleased(
        createdBinding.id,
        this.#invalidationReasons.get(createdBinding.id) ?? 'session-closed',
      ),
      profileId: request.profileId,
      runBinding,
      runVector: run.vector,
      session,
    });
    createdBinding.id = binding.id;
    let proxy: DevRuntimeClientSurfaceProxyBinding | undefined;
    try {
      await this.#registryTail;
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
      const tools = await this.#bindingAuthority.execute(binding.id, { kind: 'list-tools' });
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
      const resources = await this.#bindingAuthority.execute(binding.id, { kind: 'list-resources' });
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
      const appTools = listItems(tools.value, 'tools').filter((candidate) =>
        isRecord(candidate) && isMcpAppToolVisible(candidate)
          && selectMcpAppResourceReference(metadataOf(candidate))?.uri === run.result.app!.resourceUri,
      );
      if (appTools.length !== 1) throw new Error('Stored Runtime MCP App tool is not uniquely App-visible in the stable session.');
      const appTool = appTools[0]!;
      const resource = listItems(resources.value, 'resources').find((candidate) => isRecord(candidate) && candidate.uri === run.result.app!.resourceUri);
      if (resource === undefined) throw new Error('Stored Runtime MCP App resource is not visible in the stable session.');
      const read = await this.#bindingAuthority.execute(binding.id, { kind: 'read-resource', uri: run.result.app.resourceUri });
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
      const parsed = parseMcpAppResource(read.value, run.result.app.resourceUri);
      if (parsed === undefined) throw new Error('Stored Runtime MCP App resource is not canonical Apps HTML.');
      const listedMetadata = metadataOf(resource);
      const contents = isRecord(read.value) && Array.isArray(read.value.contents) ? read.value.contents : [];
      const readContent = contents.find((candidate) => isRecord(candidate) && candidate.uri === run.result.app!.resourceUri);
      const resourceMetadata = mergeMcpAppResourceMetadata(listedMetadata, metadataOf(readContent as McpAppJsonValue));
      const profile = resolveMcpAppHostProfile({
        configExtensions: this.#configExtensions(),
        host: defaultHost(frozenJson(appTool, 'Runtime MCP App tool')),
        profile: request.profileId,
        // The immutable merged inspection is exposed separately below. Profile
        // metadata is tool-owned here so duplicate standard `ui` keys never
        // become an authority-merging input.
        resource: { mimeType: 'text/html;profile=mcp-app', uri: run.result.app.resourceUri },
        toolMetadata: metadataOf(appTool),
      });
      proxy = profile.kind === 'apps' ? await this.#openRuntimeClientSurface(run.result.app.surfaceId) : undefined;
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
      const documentPolicy = createMcpAppDocumentPolicySnapshot(1, { permissions: parsed.permissions }, []);
      const base = Object.freeze({
        binding,
        metadata: Object.freeze({ resource: resourceMetadata.merged, result: inspectMcpAppMetadata(result.appVisible), tool: inspectMcpAppMetadata(metadataOf(appTool)) }),
        operations: Object.freeze([operation(tools, 'tools/list'), operation(resources, 'resources/list'), operation(read, 'resources/read')]),
        result,
        session: Object.freeze({ binding: runBinding, connection: live.connection, state: 'ready' as const }),
      });
      let snapshot: McpAppPreviewSnapshot;
      if (profile.kind === 'apps' && proxy !== undefined) {
        snapshot = Object.freeze({
          ...base,
          clientSurface: Object.freeze({ bootstrapUrl: proxy.bootstrapUrl, origin: proxy.origin, webSocketPath: '/rsbuild-hmr' as const }),
          documentPolicy,
          kind: 'apps' as const,
          profile,
          resource: parsed,
        });
      } else {
        const fallback = profile.kind === 'fallback'
          ? profile
          : resolveMcpAppHostProfile({
            configExtensions: this.#configExtensions(),
            host: defaultHost(frozenJson(appTool, 'Runtime MCP App tool')),
            profile: request.profileId,
          });
        if (fallback.kind !== 'fallback') throw new Error('Runtime MCP App fallback profile is invalid.');
        snapshot = Object.freeze({ ...base, kind: 'fallback' as const, profile: fallback });
      }
      await this.#registryTail;
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
      this.#entries.set(binding.id, { activeOperations: 0, binding, consent: createMcpAppConsentAuthority(), documentPolicyRevision: 1, proxy, runBinding, session, snapshot, closed: false });
      return snapshot;
    } catch (error) {
      await Promise.allSettled([proxy?.close() ?? Promise.resolve(), this.#bindingAuthority.closeBinding(binding.id)]);
      throw error;
    }
  }

  async operate(bindingId: string, request: McpAppBindingOperation): Promise<McpAppOperationResponse> {
    const entry = this.#entry(bindingId);
    if (entry.activeOperations >= maxConcurrentOperations) throw new Error('Runtime MCP App operation limit reached.');
    entry.activeOperations += 1;
    try {
      let result: McpAppBoundOperationResult;
      if (request.kind === 'tools/list') result = await this.#bindingAuthority.execute(bindingId, { kind: 'list-tools' });
      else if (request.kind === 'resources/list') result = await this.#bindingAuthority.execute(bindingId, { kind: 'list-resources' });
      else if (request.kind === 'resources/read') result = await this.#bindingAuthority.execute(bindingId, { kind: 'read-resource', uri: nonempty(request.uri, 'Runtime MCP App resource URI') });
      else {
        const name = nonempty(request.name, 'Runtime MCP App tool name');
        if (request.consentId === undefined || !entry.consent.consume({ actionDigest: createMcpAppConsentActionDigest('call-tool', Object.freeze({ arguments: request.arguments ?? {}, name })), authorizationId: request.consentId, bindingId, capability: 'call-tool', profile: entry.binding.profileId })) {
          throw new Error('Runtime MCP App tool call requires an approved consent grant.');
        }
        result = await this.#bindingAuthority.execute(bindingId, { arguments: request.arguments, kind: 'call-tool', name });
      }
      return Object.freeze({ result });
    } finally {
      entry.activeOperations -= 1;
    }
  }

  async createConsent(bindingId: string, request: McpAppConsentRequest): Promise<McpAppConsentCreatedResponse> {
    const entry = this.#entry(bindingId);
    if (!isRecord(request) || typeof request.actionFingerprint !== 'string' || typeof request.summary !== 'string') {
      throw new TypeError('Runtime MCP App consent request is invalid.');
    }
    const details = frozenJson(request.details, 'Runtime MCP App consent details');
    const capability = request.capability;
    const valid = new Set(['call-tool', 'download-file', 'open-external-link', 'clipboard-write', 'camera', 'microphone', 'geolocation', 'request-display-mode']);
    const documentScoped = capability === 'clipboard-write' || capability === 'camera' || capability === 'microphone' || capability === 'geolocation';
    if (!valid.has(capability)
      || request.actionFingerprint.length === 0 || request.actionFingerprint.length > 256
      || request.summary.length === 0 || request.summary.length > 512
      || request.scope !== (documentScoped ? 'document' : 'action')) {
      throw new TypeError('Runtime MCP App consent request is invalid.');
    }
    const challenge = entry.consent.challenge({ actionDigest: createMcpAppConsentActionDigest(capability, details), bindingId, capability, details, profile: entry.binding.profileId });
    if (challenge === undefined) throw new Error('Runtime MCP App consent challenge limit reached.');
    return Object.freeze({ challenge, documentPolicy: this.#documentPolicy(entry) });
  }

  async decideConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny'): Promise<McpAppConsentDecisionResponse> {
    const entry = this.#entry(bindingId);
    if (decision !== 'allow-once' && decision !== 'deny') throw new TypeError('Runtime MCP App consent decision is invalid.');
    const resolution = entry.consent.resolve(nonempty(consentId, 'Runtime MCP App consent id'), decision === 'allow-once');
    const grant = resolution.status === 'approved' ? resolution.grant : undefined;
    if (grant?.scope === 'document') entry.documentPolicyRevision += 1;
    return Object.freeze({ documentPolicy: this.#documentPolicy(entry), grant });
  }

  async close(bindingId: string): Promise<void> { await this.#closeEntry(bindingId, 'manual-close'); }

  async closeAll(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#subscription.unsubscribe();
    }
    const results = await Promise.allSettled([...this.#entries.keys()].map(async (id) => this.#closeEntry(id, 'runtime-shutdown')));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected !== undefined) throw rejected.reason;
  }

  #entry(bindingId: string): PreviewEntry {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined || entry.closed) throw new Error('Runtime MCP App preview is not available.');
    return entry;
  }

  #documentPolicy(entry: PreviewEntry): McpAppDocumentPolicySnapshot {
    const permissions = entry.snapshot.kind === 'apps' ? entry.snapshot.resource.permissions : undefined;
    return createMcpAppDocumentPolicySnapshot(entry.documentPolicyRevision, { permissions }, entry.consent.documentGrants(entry.binding.id, entry.binding.profileId));
  }

  async #onRegistry(message: DevRuntimeMcpRegistryMessage): Promise<void> {
    if (this.#closed) return;
    if ('type' in message) {
      this.#replayGap = true;
      await Promise.allSettled([...this.#entries.keys()].map(async (id) => this.#closeEntry(id, 'registry-replay-gap')));
      return;
    }
    if (message.sequence <= this.#lastRegistrySequence) return;
    this.#lastRegistrySequence = message.sequence;
    if (message.action === 'implementation-updated') return;
    const reason = message.action === 'restart-failed' ? 'restart-failed' : 'session-restarted';
    await Promise.allSettled(message.invalidatedBindings.map(async (binding) => {
      for (const [id, entry] of this.#entries) {
        if (entry.binding.sessionId === binding.sessionId && entry.binding.sessionRevision === binding.sessionRevision) {
          this.#invalidationReasons.set(id, reason);
        }
      }
      await this.#bindingAuthority.invalidateBindings(binding);
    }));
  }

  #assertCreateStillValid(
    bindingId: string,
    runBinding: DevRuntimeMcpAppRunBinding,
    runVector: RuntimeVector,
    session: DevRuntimeMcpSessionView,
  ): void {
    if (this.#closed || this.#replayGap || this.#bindingAuthority.get(bindingId) === undefined) {
      throw new Error('Runtime MCP App stable session changed while its preview was being created.');
    }
    const live = session.snapshot();
    if (live.state !== 'ready' || !runBindingEquals(runBinding, live.binding)
      || live.binding.providerSessionId !== runVector.providerSessionId
      || live.binding.stateStoreId !== runVector.stateStoreId) {
      throw new Error('Runtime MCP App stable session changed while its preview was being created.');
    }
  }

  async #closeEntry(bindingId: string, reason: McpAppRuntimeInvalidationDetails['reason']): Promise<void> {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined || entry.closed) return;
    if (entry.closeAttempt !== undefined) return entry.closeAttempt;
    const attempt = (async () => {
      await this.#bindingAuthority.closeBinding(bindingId);
      await entry.proxy?.close();
      this.#revoke(entry, reason);
    })();
    entry.closeAttempt = attempt;
    void attempt.then(
      () => undefined,
      () => { if (entry.closeAttempt === attempt) entry.closeAttempt = undefined; },
    );
    return attempt;
  }

  async #bindingReleased(bindingId: string, reason: McpAppRuntimeInvalidationDetails['reason']): Promise<void> {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined || entry.closed || entry.closeAttempt !== undefined) return;
    const attempt = (async () => {
      await entry.proxy?.close();
      this.#revoke(entry, reason);
    })();
    entry.closeAttempt = attempt;
    void attempt.then(
      () => undefined,
      () => { if (entry.closeAttempt === attempt) entry.closeAttempt = undefined; },
    );
    return attempt;
  }

  #revoke(entry: PreviewEntry, reason: McpAppRuntimeInvalidationDetails['reason']): void {
    if (entry.closed) return;
    entry.closed = true;
    this.#invalidationReasons.delete(entry.binding.id);
    this.#revokedBindings.add(entry.binding.id);
    while (this.#revokedBindings.size > 128) this.#revokedBindings.delete(this.#revokedBindings.values().next().value as string);
    // Publication happens while the frozen snapshot remains reachable; the
    // subscriber may tear down its bridge before the lookup disappears.
    this.#emit?.(Object.freeze({ bindingId: entry.binding.id, reason, sessionId: entry.binding.sessionId, sessionRevision: entry.binding.sessionRevision, state: 'revoked' }));
    this.#entries.delete(entry.binding.id);
  }
}
