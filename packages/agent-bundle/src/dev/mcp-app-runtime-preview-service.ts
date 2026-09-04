import { isPlainRecord } from '../core/strict-json.ts';
import {
  McpAppRuntimeBindingService,
  type McpAppBoundOperationResult,
  type McpAppPublicRuntimeVector,
  type McpAppProfileId,
  type McpAppRuntimeBindingSnapshot,
} from './mcp-app-runtime-binding-service.ts';
import { parseMcpAppResource, type McpAppParsedResource } from './mcp-apps/mcp-app-bridge.ts';
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
} from './mcp-apps/mcp-app-host-profiles.ts';
import {
  createMcpAppConsentActionDigest,
  createMcpAppConsentAuthority,
  createMcpAppDocumentPolicySnapshot,
  deriveMcpAppSandboxPolicy,
  type McpAppConsentAuthority,
  type McpAppConsentChallenge,
  type McpAppConsentGrant,
  type McpAppConsentRequest,
  type McpAppDocumentPolicySnapshot,
  type McpAppSandboxDeclaration,
} from './mcp-apps/mcp-app-sandbox.ts';
import type { RuntimeClientSurfaceContentPolicy } from './runtime-client-surface-proxy.ts';
import type { DevRuntimeClientSurfaceProxyBinding, DevRuntimeMcpRegistryMessage, DevRuntimeMcpSessionView, DevRuntimeSession } from './runtime-provider.ts';
import type { DevRuntimeMcpAppRunBinding, DevRuntimeMcpConnectionState, RuntimeVector } from './runtime-protocol.ts';
import { YieldableFrameworkError } from '../effect/errors.ts';

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
  readonly clientSurface: Readonly<{ readonly bootstrapUrl: string; readonly origin: string }>;
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
  /** Awaits every run-bound App revoke/cleanup attempt for one manually closed session revision. */
  closeSession?(sessionId: string, sessionRevision: number): Promise<void>;
  create(request: CreateMcpAppPreviewRequest): Promise<McpAppPreviewSnapshot>;
  createConsent(bindingId: string, request: McpAppConsentRequest): Promise<McpAppConsentCreatedResponse>;
  decideConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny'): Promise<McpAppConsentDecisionResponse>;
  /** Server-only mutation barrier for the sole manual runtime MCP route owner. */
  flushRegistry?(): Promise<void>;
  get(bindingId: string): McpAppPreviewSnapshot | undefined;
  /** A bounded local tombstone only; it distinguishes revoked from unknown IDs. */
  isRevoked?(bindingId: string): boolean;
  operate(bindingId: string, operation: McpAppBindingOperation, options?: McpAppRuntimeOperationOptions): Promise<McpAppOperationResponse>;
}

export interface McpAppRuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

/** Closed, phase-safe diagnostics intended for the authenticated runtime App route. */
export class McpAppRuntimePreviewError extends YieldableFrameworkError {
  readonly code: 'AB8023' | 'AB8201' | 'AB8203' | 'AB8204';
  readonly status: 400 | 404 | 409 | 502;

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
  readonly openRuntimeClientSurface: (
    surfaceId: string,
    policy: RuntimeClientSurfaceContentPolicy,
  ) => Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
  readonly runtime: DevRuntimeSession;
  readonly emit?: (details: McpAppRuntimeInvalidationDetails) => void;
  /** Injected only by deterministic service tests; production uses the system timer. */
  readonly operationClock?: McpAppRuntimeOperationClock;
}

export interface McpAppRuntimeOperationClock {
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
}

interface PreviewOperation {
  readonly controller: AbortController;
  dispose(): void;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface PreviewEntry {
  readonly binding: McpAppRuntimeBindingSnapshot;
  readonly catalog: Readonly<{
    readonly resources: McpAppBoundOperationResult;
    readonly resourceUris: readonly string[];
    readonly toolNames: readonly string[];
    readonly tools: McpAppBoundOperationResult;
  }>;
  readonly cleanup: PreviewCleanup;
  readonly consent: McpAppConsentAuthority;
  readonly runBinding: DevRuntimeMcpAppRunBinding;
  readonly session: DevRuntimeMcpSessionView;
  snapshot: McpAppPreviewSnapshot;
  activeOperations: number;
  readonly operations: Set<PreviewOperation>;
  documentGrants: readonly McpAppConsentGrant[];
  documentPolicy: McpAppDocumentPolicySnapshot;
  revoked: boolean;
}

interface PreviewCleanup {
  readonly bindingId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  bindingReleased: boolean;
  bindingReleaseInFlight: boolean;
  closeAttempt?: Promise<void>;
  /** The foreground proxy can be acquired after a concurrent DELETE starts. */
  proxyAcquisition?: Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
  proxy?: DevRuntimeClientSurfaceProxyBinding;
  proxyClosed: boolean;
}

const maxConcurrentOperations = 4;
const operationTimeoutMs = 30_000;
const systemOperationClock: McpAppRuntimeOperationClock = Object.freeze({
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
});

const isRecord = isPlainRecord;

const canonicalCallToolConsentDetails = (
  catalog: PreviewEntry['catalog'],
  details: McpAppJsonValue,
): McpAppJsonValue => {
  if (!isRecord(details) || typeof details.name !== 'string' || !catalog.toolNames.includes(details.name)) {
    throw new Error('Runtime MCP App tool is not in the binding catalog.');
  }
  return frozenJson(Object.freeze({
    arguments: details.arguments ?? Object.freeze({}),
    name: details.name,
  }), 'Runtime MCP App call-tool consent details');
};

const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value;
};

const frozenJson = (value: unknown, label: string): McpAppJsonValue => cloneMcpAppFiniteJson(value, label);

const sandboxDeclaration = (resource: McpAppParsedResource): McpAppSandboxDeclaration => Object.freeze({
  ...(resource.csp === undefined ? {} : { csp: resource.csp }),
  ...(resource.permissions === undefined ? {} : { permissions: resource.permissions }),
});

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
  platform: 'web',
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
  if (Array.isArray(value)) return value;
  if (!isRecord(value) || !Array.isArray(value[key])) throw new Error(`Runtime MCP ${key} response is invalid.`);
  return value[key] as readonly McpAppJsonValue[];
};

const metadataOf = (value: McpAppJsonValue): unknown => isRecord(value) ? value._meta : undefined;

const catalogOperation = (
  value: McpAppBoundOperationResult,
  key: 'resources' | 'tools',
  items: readonly McpAppJsonValue[],
): McpAppBoundOperationResult => Object.freeze({
  ...value,
  value: Object.freeze({ [key]: Object.freeze([...items]) }),
});

const aggregateFailures = (message: string, failures: readonly unknown[]): never => {
  throw new AggregateError(failures, message);
};

const flattenFailures = (failures: readonly unknown[]): readonly unknown[] => failures.flatMap((failure) =>
  failure instanceof AggregateError ? flattenFailures(failure.errors) : [failure],
);

const sameDocumentPolicy = (left: McpAppDocumentPolicySnapshot, right: McpAppDocumentPolicySnapshot): boolean =>
  left.allow === right.allow &&
  JSON.stringify(left.approvedPermissions) === JSON.stringify(right.approvedPermissions) &&
  JSON.stringify(left.warnings) === JSON.stringify(right.warnings);

/** Provider-owned preview lane for an already-succeeded runtime App run. */
export class McpAppRuntimePreviewService implements McpAppRuntimeRoutePreviewService {
  readonly #bindingAuthority: McpAppRuntimeBindingService;
  readonly #configExtensions: () => McpAppConfigExtensionInspectionOptions;
  /** Retained until every fallible proxy and lease release has succeeded. */
  readonly #cleanups = new Map<string, PreviewCleanup>();
  readonly #emit: ((details: McpAppRuntimeInvalidationDetails) => void) | undefined;
  readonly #entries = new Map<string, PreviewEntry>();
  readonly #invalidationReasons = new Map<string, McpAppRuntimeInvalidationDetails['reason']>();
  readonly #openRuntimeClientSurface: McpAppRuntimePreviewServiceOptions['openRuntimeClientSurface'];
  readonly #operationClock: McpAppRuntimeOperationClock;
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
    this.#operationClock = options.operationClock ?? systemOperationClock;
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
    if (
      live.connection.protocolEra === undefined || live.connection.protocolVersion === undefined ||
      live.connection.capabilities === undefined || live.connection.server === undefined
    ) {
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
    // Retain cleanup ownership before any subsequent provider/proxy operation
    // can fail.  A failed create has no public binding, but shutdown must still
    // be able to retry every lease and proxy release.
    const cleanup: PreviewCleanup = {
      bindingId: binding.id,
      bindingReleased: false,
      bindingReleaseInFlight: false,
      proxyClosed: false,
      sessionId: runBinding.sessionId,
      sessionRevision: runBinding.sessionRevision,
    };
    this.#cleanups.set(binding.id, cleanup);
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
      if (!isRecord(appTool)) throw new Error('Stored Runtime MCP App tool is invalid.');
      const appToolName = nonempty(appTool.name, 'Stored Runtime MCP App tool name');
      const resource = listItems(resources.value, 'resources').find((candidate) => isRecord(candidate) && candidate.uri === run.result.app!.resourceUri);
      if (!isRecord(resource) || resource.mimeType !== 'text/html;profile=mcp-app') {
        throw new Error('Stored Runtime MCP App resource is not visible in the stable session.');
      }
      const read = await this.#bindingAuthority.execute(binding.id, { kind: 'read-resource', uri: run.result.app.resourceUri });
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
      const parsed = parseMcpAppResource(read.value, run.result.app.resourceUri);
      if (parsed === undefined) throw new Error('Stored Runtime MCP App resource is not canonical Apps HTML.');
      const declaration = sandboxDeclaration(parsed);
      const documentPolicy = createMcpAppDocumentPolicySnapshot(1, declaration, []);
      const clientSurfacePolicy: RuntimeClientSurfaceContentPolicy = Object.freeze({
        contentSecurityPolicy: deriveMcpAppSandboxPolicy(
          declaration,
          Object.freeze({ permissions: documentPolicy.approvedPermissions }),
        ).contentSecurityPolicy,
      });
      const listedMetadata = metadataOf(resource);
      const contents = isRecord(read.value) && Array.isArray(read.value.contents) ? read.value.contents : [];
      const readContent = contents.find((candidate) =>
        isRecord(candidate) && candidate.uri === run.result.app!.resourceUri && candidate.mimeType === 'text/html;profile=mcp-app');
      if (readContent === undefined) throw new Error('Stored Runtime MCP App resource read is not canonical Apps HTML.');
      const resourceMetadata = mergeMcpAppResourceMetadata(listedMetadata, metadataOf(readContent as McpAppJsonValue));
      const configExtensions = this.#configExtensions();
      const profile = resolveMcpAppHostProfile({
        configExtensions,
        host: defaultHost(frozenJson(appTool, 'Runtime MCP App tool')),
        profile: request.profileId,
        // The immutable merged inspection is exposed separately below. Profile
        // metadata is tool-owned here so duplicate standard `ui` keys never
        // become an authority-merging input.
        declaredCapabilities: Object.keys(parsed.permissions ?? {}),
        resource: { metadata: resourceMetadata.merged, mimeType: 'text/html;profile=mcp-app', uri: run.result.app.resourceUri },
        toolMetadata: metadataOf(appTool),
      });
      if (profile.kind === 'apps') {
        // Store the promise before yielding. A concurrent DELETE therefore
        // joins the acquisition and closes a proxy that resolves afterward.
        const proxyAcquisition = this.#openRuntimeClientSurface(run.result.app.surfaceId, clientSurfacePolicy);
        cleanup.proxyAcquisition = proxyAcquisition;
        proxy = await proxyAcquisition;
        cleanup.proxy = proxy;
      }
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
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
          clientSurface: Object.freeze({ bootstrapUrl: proxy.bootstrapUrl, origin: proxy.origin }),
          documentPolicy,
          kind: 'apps' as const,
          profile,
          resource: parsed,
        });
      } else {
        const fallback = profile.kind === 'fallback'
          ? profile
          : resolveMcpAppHostProfile({
            configExtensions,
            host: defaultHost(frozenJson(appTool, 'Runtime MCP App tool')),
            profile: request.profileId,
          });
        if (fallback.kind !== 'fallback') throw new Error('Runtime MCP App fallback profile is invalid.');
        snapshot = Object.freeze({ ...base, kind: 'fallback' as const, profile: fallback });
      }
      await this.#registryTail;
      this.#assertCreateStillValid(binding.id, runBinding, run.vector, session);
      this.#entries.set(binding.id, {
        activeOperations: 0,
        binding,
        catalog: Object.freeze({
          resources: catalogOperation(resources, 'resources', [resource]),
          resourceUris: Object.freeze([run.result.app.resourceUri]),
          toolNames: Object.freeze([appToolName]),
          tools: catalogOperation(tools, 'tools', [appTool]),
        }),
        cleanup,
        consent: createMcpAppConsentAuthority(),
        documentGrants: Object.freeze([]),
        documentPolicy,
        operations: new Set(),
        revoked: false,
        runBinding,
        session,
        snapshot,
      });
      return snapshot;
    } catch (error) {
      cleanup.proxy = proxy;
      const release = await Promise.allSettled([this.#cleanup(cleanup)]);
      const failures = release.flatMap((result) => result.status === 'rejected'
        ? [error, ...flattenFailures([result.reason])]
        : [error]);
      if (failures.length > 1) aggregateFailures('Runtime MCP App preview creation and cleanup failed.', failures);
      throw error;
    }
  }

  async operate(
    bindingId: string,
    request: McpAppBindingOperation,
    options: McpAppRuntimeOperationOptions = {},
  ): Promise<McpAppOperationResponse> {
    const entry = this.#entry(bindingId);
    if (entry.activeOperations >= maxConcurrentOperations) throw new Error('Runtime MCP App operation limit reached.');
    entry.activeOperations += 1;
    const operation = this.#startOperation(entry, options.signal);
    try {
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason ?? new Error('Runtime MCP App operation was cancelled.');
      let result: McpAppBoundOperationResult;
      if (request.kind === 'tools/list') result = entry.catalog.tools;
      else if (request.kind === 'resources/list') result = entry.catalog.resources;
      else if (request.kind === 'resources/read') {
        const uri = nonempty(request.uri, 'Runtime MCP App resource URI');
        if (!entry.catalog.resourceUris.includes(uri)) throw new Error('Runtime MCP App resource is not in the binding catalog.');
        result = await this.#bindingAuthority.execute(bindingId, { kind: 'read-resource', uri }, Object.freeze({ signal: operation.controller.signal }));
      }
      else {
        const name = nonempty(request.name, 'Runtime MCP App tool name');
        if (!entry.catalog.toolNames.includes(name)) throw new Error('Runtime MCP App tool is not in the binding catalog.');
        if (request.consentId === undefined || !entry.consent.consume({ actionDigest: createMcpAppConsentActionDigest('call-tool', Object.freeze({ arguments: request.arguments ?? {}, name })), authorizationId: request.consentId, bindingId, capability: 'call-tool', profile: entry.binding.profileId })) {
          throw new Error('Runtime MCP App tool call requires an approved consent grant.');
        }
        result = await this.#bindingAuthority.execute(bindingId, { arguments: request.arguments, kind: 'call-tool', name }, Object.freeze({ signal: operation.controller.signal }));
      }
      return Object.freeze({ result });
    } catch (error) {
      if (operation.timedOut) {
        throw new McpAppRuntimePreviewError('AB8023', 'Runtime MCP App operation exceeded its 30 second deadline.', 502);
      }
      throw error;
    } finally {
      operation.dispose();
      entry.activeOperations -= 1;
    }
  }

  async createConsent(bindingId: string, request: McpAppConsentRequest): Promise<McpAppConsentCreatedResponse> {
    const entry = this.#entry(bindingId);
    if (!isRecord(request) || typeof request.actionFingerprint !== 'string' || typeof request.summary !== 'string') {
      throw new TypeError('Runtime MCP App consent request is invalid.');
    }
    const suppliedDetails = frozenJson(request.details, 'Runtime MCP App consent details');
    const capability = request.capability;
    const valid = new Set(['call-tool', 'download-file', 'open-external-link', 'clipboard-write', 'camera', 'microphone', 'geolocation', 'request-display-mode']);
    const documentScoped = capability === 'clipboard-write' || capability === 'camera' || capability === 'microphone' || capability === 'geolocation';
    if (!valid.has(capability)
      || request.actionFingerprint.length === 0 || request.actionFingerprint.length > 256
      || request.summary.length === 0 || request.summary.length > 512
      || request.scope !== (documentScoped ? 'document' : 'action')) {
      throw new TypeError('Runtime MCP App consent request is invalid.');
    }
    const details = capability === 'call-tool'
      ? canonicalCallToolConsentDetails(entry.catalog, suppliedDetails)
      : suppliedDetails;
    const challenge = entry.consent.challenge({ actionDigest: createMcpAppConsentActionDigest(capability, details), bindingId, capability, details, profile: entry.binding.profileId });
    if (challenge === undefined) throw new Error('Runtime MCP App consent challenge limit reached.');
    return Object.freeze({ challenge, documentPolicy: this.#documentPolicy(entry) });
  }

  async decideConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny'): Promise<McpAppConsentDecisionResponse> {
    const entry = this.#entry(bindingId);
    if (decision !== 'allow-once' && decision !== 'deny') throw new TypeError('Runtime MCP App consent decision is invalid.');
    const resolution = entry.consent.resolve(nonempty(consentId, 'Runtime MCP App consent id'), decision === 'allow-once');
    const grant = resolution.status === 'approved' ? resolution.grant : undefined;
    if (grant?.scope === 'document') {
      const documentGrants = Object.freeze([...entry.documentGrants, grant]);
      const candidate = createMcpAppDocumentPolicySnapshot(entry.documentPolicy.revision + 1, {
        ...(entry.snapshot.kind !== 'apps' || entry.snapshot.resource.csp === undefined ? {} : { csp: entry.snapshot.resource.csp }),
        ...(entry.snapshot.kind !== 'apps' || entry.snapshot.resource.permissions === undefined ? {} : { permissions: entry.snapshot.resource.permissions }),
      }, documentGrants);
      if (!sameDocumentPolicy(entry.documentPolicy, candidate)) {
        entry.documentGrants = documentGrants;
        this.#replaceDocumentPolicy(entry, candidate);
      }
    }
    return Object.freeze({ documentPolicy: this.#documentPolicy(entry), grant });
  }

  async close(bindingId: string): Promise<void> { await this.#closeEntry(bindingId, 'manual-close'); }

  /** Emits all terminal invalidations before foreground SSE/proxy teardown. */
  async prepareClose(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#subscription.unsubscribe();
    }
    for (const entry of [...this.#entries.values()]) this.#revoke(entry, 'runtime-shutdown');
  }

  async closeSession(sessionId: string, sessionRevision: number): Promise<void> {
    await this.#registryTail;
    const matching = [...this.#cleanups.values()]
      .filter((cleanup) => cleanup.sessionId === sessionId && cleanup.sessionRevision === sessionRevision);
    const results = await Promise.allSettled(matching.map(async (cleanup) => this.#closeEntry(cleanup.bindingId, 'session-closed')));
    const failures = flattenFailures(results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    if (failures.length > 0) aggregateFailures('Runtime MCP App session cleanup failed.', failures);
  }

  async closeAll(): Promise<void> {
    await this.prepareClose();
    const results = await Promise.allSettled([...this.#cleanups.keys()].map(async (id) => this.#closeEntry(id, 'runtime-shutdown')));
    const failures = flattenFailures(results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    if (failures.length > 0) aggregateFailures('Runtime MCP App previews could not close every resource.', failures);
  }

  #entry(bindingId: string): PreviewEntry {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined || entry.revoked) throw new Error('Runtime MCP App preview is not available.');
    return entry;
  }

  #documentPolicy(entry: PreviewEntry): McpAppDocumentPolicySnapshot { return entry.documentPolicy; }

  #replaceDocumentPolicy(entry: PreviewEntry, documentPolicy: McpAppDocumentPolicySnapshot): void {
    entry.documentPolicy = documentPolicy;
    if (entry.snapshot.kind === 'apps') entry.snapshot = Object.freeze({ ...entry.snapshot, documentPolicy });
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
    if (entry !== undefined) this.#revoke(entry, reason);
    const cleanup = this.#cleanups.get(bindingId);
    if (cleanup === undefined) return;
    await this.#cleanup(cleanup);
  }

  async #bindingReleased(bindingId: string, reason: McpAppRuntimeInvalidationDetails['reason']): Promise<void> {
    const entry = this.#entries.get(bindingId);
    if (entry !== undefined) this.#revoke(entry, reason);
    const cleanup = this.#cleanups.get(bindingId);
    if (cleanup === undefined) return;
    cleanup.bindingReleased = true;
    // The binding authority awaits its teardown callback. Joining its current
    // release attempt here would recurse into that same promise forever.
    if (cleanup.bindingReleaseInFlight) return;
    await this.#cleanup(cleanup);
  }

  #revoke(entry: PreviewEntry, reason: McpAppRuntimeInvalidationDetails['reason']): void {
    if (entry.revoked) return;
    for (const operation of entry.operations) {
      operation.controller.abort(new Error('Runtime MCP App operation was cancelled.'));
    }
    entry.revoked = true;
    this.#invalidationReasons.delete(entry.binding.id);
    this.#revokedBindings.add(entry.binding.id);
    while (this.#revokedBindings.size > 128) this.#revokedBindings.delete(this.#revokedBindings.values().next().value as string);
    // Publication happens while the frozen snapshot remains reachable; the
    // subscriber may tear down its bridge before the lookup disappears.
    this.#emit?.(Object.freeze({ bindingId: entry.binding.id, reason, sessionId: entry.binding.sessionId, sessionRevision: entry.binding.sessionRevision, state: 'revoked' }));
    this.#entries.delete(entry.binding.id);
  }

  #startOperation(entry: PreviewEntry, external: AbortSignal | undefined): PreviewOperation {
    const controller = new AbortController();
    const abort = (): void => {
      if (!controller.signal.aborted) controller.abort(external?.reason ?? new Error('Runtime MCP App operation was cancelled.'));
    };
    if (external?.aborted) abort();
    else external?.addEventListener('abort', abort, { once: true });
    const operation: PreviewOperation = {
      controller,
      dispose: () => {
        external?.removeEventListener('abort', abort);
        if (operation.timer !== undefined) this.#operationClock.clearTimeout(operation.timer);
        entry.operations.delete(operation);
      },
      timedOut: false,
      timer: undefined,
    };
    operation.timer = this.#operationClock.setTimeout(() => {
      operation.timedOut = true;
      controller.abort(new Error('Runtime MCP App operation exceeded its 30 second deadline.'));
    }, operationTimeoutMs);
    entry.operations.add(operation);
    return operation;
  }

  async #cleanup(cleanup: PreviewCleanup): Promise<void> {
    if (cleanup.closeAttempt !== undefined) return cleanup.closeAttempt;
    const attempt = (async () => {
      const failures: unknown[] = [];
      if (!cleanup.bindingReleased) {
        cleanup.bindingReleaseInFlight = true;
        try {
          await this.#bindingAuthority.closeBinding(cleanup.bindingId);
          cleanup.bindingReleased = true;
        } catch (error) {
          failures.push(error);
        } finally {
          cleanup.bindingReleaseInFlight = false;
        }
      }
      if (!cleanup.proxyClosed) {
        if (cleanup.proxyAcquisition !== undefined) {
          try {
            cleanup.proxy ??= await cleanup.proxyAcquisition;
          } catch {
            // The acquisition itself failed, so no proxy resource exists to
            // close. Creation reports that failure through its own promise.
            cleanup.proxyClosed = true;
          }
        }
      }
      if (!cleanup.proxyClosed) {
        try {
          await cleanup.proxy?.close();
          cleanup.proxyClosed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) aggregateFailures('Runtime MCP App preview cleanup failed.', failures);
      this.#cleanups.delete(cleanup.bindingId);
    })();
    cleanup.closeAttempt = attempt;
    void attempt.then(
      () => undefined,
      () => { if (cleanup.closeAttempt === attempt) cleanup.closeAttempt = undefined; },
    );
    return attempt;
  }
}
