import type {
  DevRuntimeAssetRequest,
  DevRuntimeDiagnostic,
  DevRuntimeInspectionEnvelope,
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeRunResponse,
  DevRuntimeRunsResponse,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStateResponse,
  DevRuntimeStatus,
  DevRuntimeStatusResponse,
  DevRuntimeSurface,
  DevRuntimeSurfacesResponse,
  DevRuntimeTreeNode,
  DevRuntimeTraceSpan,
  RuntimeVector,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import { ForegroundRouteClient, ForegroundRouteClientError } from './mcp/mcp-route-client.ts';

export type RuntimeBootstrap =
  | Readonly<{ readonly kind: 'unavailable' }>
  | Readonly<{
      readonly history: readonly DevRuntimeRun[];
      readonly kind: 'available';
      readonly providerSessionId: string;
      readonly status: DevRuntimeStatus;
      readonly surfaces: readonly DevRuntimeSurface[];
    }>;

const runtimeAssetLimit = 4 * 1024 * 1024;
const runtimeAssetContentTypes = new Set(['application/javascript', 'application/json', 'text/css', 'text/html']);
const runtimeErrorCode = 'AB8206';
type RuntimeJsonValue = DevRuntimeInvocationRequest['input'];
type RuntimeJsonObject = NonNullable<DevRuntimeSurface['inputSchema']>;
const diagnosticPhases = new Set([
  'source/build',
  'fixture-validation',
  'hook-wrapper',
  'rsc-render',
  'flight-decode',
  'lowering-contract',
  'mcp-protocol',
  'resource-selection',
  'sandbox/csp',
  'app-bridge',
  'provider-lifecycle',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const hasOnly = (value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !value.includes('\0');

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const nonnegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const jsonValue = (value: unknown, ancestors = new WeakSet<object>()): RuntimeJsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw invalid('Runtime data must contain finite JSON numbers.');
  }
  if (typeof value !== 'object') throw invalid('Runtime data must contain only JSON values.');
  if (ancestors.has(value)) throw invalid('Runtime data must not be cyclic.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => jsonValue(entry, ancestors))) as RuntimeJsonValue;
    if (!isRecord(value)) throw invalid('Runtime data must use ordinary JSON objects.');
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = jsonValue(entry, ancestors);
    return Object.freeze(copy) as RuntimeJsonValue;
  } finally {
    ancestors.delete(value);
  }
};

const record = (value: unknown, message = 'Runtime route returned an invalid response.'): Readonly<Record<string, RuntimeJsonValue>> => {
  if (!isRecord(value)) throw invalid(message);
  return jsonValue(value) as Readonly<Record<string, RuntimeJsonValue>>;
};

const jsonObject = (value: unknown, message = 'Runtime route returned an invalid response.'): RuntimeJsonObject =>
  record(value, message) as RuntimeJsonObject;

const stringArray = (value: unknown, message = 'Runtime route returned an invalid response.'): readonly string[] => {
  if (!Array.isArray(value) || value.some((entry) => !nonemptyString(entry))) throw invalid(message);
  return Object.freeze([...value] as string[]);
};

const requiredDate = (value: unknown, message = 'Runtime route returned an invalid response.'): string => {
  if (!nonemptyString(value) || Number.isNaN(Date.parse(value))) throw invalid(message);
  return value;
};

const vector = (value: unknown): RuntimeVector => {
  const response = record(value);
  if (!hasOnly(response, ['artifactEpochId', 'providerSessionId', 'runtimeGenerationId', 'sourceRevision', 'stateStoreId', 'stateVersion']) ||
    !nonemptyString(response.providerSessionId) || !nonemptyString(response.runtimeGenerationId) ||
    !nonemptyString(response.sourceRevision) || !nonemptyString(response.stateStoreId) ||
    !nonnegativeInteger(response.stateVersion) ||
    (response.artifactEpochId !== undefined && !nonemptyString(response.artifactEpochId))) {
    throw invalid('Runtime route returned an invalid vector.');
  }
  return Object.freeze({
    ...(response.artifactEpochId === undefined ? {} : { artifactEpochId: response.artifactEpochId }),
    providerSessionId: response.providerSessionId,
    runtimeGenerationId: response.runtimeGenerationId,
    sourceRevision: response.sourceRevision,
    stateStoreId: response.stateStoreId,
    stateVersion: response.stateVersion,
  });
};

const stateIdentity = (value: unknown): DevRuntimeStateIdentity => {
  const response = record(value);
  if (!hasOnly(response, ['stateStoreId', 'stateVersion']) || !nonemptyString(response.stateStoreId) ||
    !nonnegativeInteger(response.stateVersion)) {
    throw invalid('Runtime route returned an invalid state identity.');
  }
  return Object.freeze({ stateStoreId: response.stateStoreId, stateVersion: response.stateVersion });
};

const diagnostic = (value: unknown): DevRuntimeDiagnostic => {
  const response = record(value);
  if (!hasOnly(response, ['code', 'message', 'phase', 'severity']) || !nonemptyString(response.code) || !nonemptyString(response.message) ||
    typeof response.phase !== 'string' || !diagnosticPhases.has(response.phase) ||
    (response.severity !== 'error' && response.severity !== 'warning' && response.severity !== 'info')) {
    throw invalid('Runtime route returned an invalid diagnostic.');
  }
  return Object.freeze({ code: response.code, message: response.message, phase: response.phase as DevRuntimeDiagnostic['phase'], severity: response.severity });
};

const status = (value: unknown): DevRuntimeStatus => {
  const response = record(value);
  if (!hasOnly(response, ['activeVector', 'descriptor', 'diagnostics', 'hmrReady', 'lastGoodVector', 'state']) ||
    !isRecord(response.descriptor) || !hasOnly(response.descriptor, ['environmentVariables', 'id', 'label', 'schemaVersion']) ||
    !Array.isArray(response.descriptor.environmentVariables) || response.descriptor.environmentVariables.some((entry) => !nonemptyString(entry)) ||
    !nonemptyString(response.descriptor.id) || !nonemptyString(response.descriptor.label) || response.descriptor.schemaVersion !== 1 ||
    typeof response.hmrReady !== 'boolean' || !Array.isArray(response.diagnostics) ||
    !['starting', 'compiling', 'active', 'degraded', 'failed', 'closed'].includes(response.state as string)) {
    throw invalid('Runtime route returned an invalid status.');
  }
  return Object.freeze({
    ...(response.activeVector === undefined ? {} : { activeVector: vector(response.activeVector) }),
    descriptor: Object.freeze({
      environmentVariables: stringArray(response.descriptor.environmentVariables),
      id: response.descriptor.id,
      label: response.descriptor.label,
      schemaVersion: 1,
    }),
    diagnostics: Object.freeze(response.diagnostics.map(diagnostic)),
    hmrReady: response.hmrReady,
    ...(response.lastGoodVector === undefined ? {} : { lastGoodVector: vector(response.lastGoodVector) }),
    state: response.state as DevRuntimeStatus['state'],
  });
};

const surface = (value: unknown): DevRuntimeSurface => {
  const response = record(value);
  if (!hasOnly(response, ['defaultTarget', 'fixtures', 'id', 'inputSchema', 'kind', 'label', 'readOnly', 'targets']) ||
    (response.defaultTarget !== undefined && !nonemptyString(response.defaultTarget)) || !Array.isArray(response.fixtures) ||
    !nonemptyString(response.id) || !['hook', 'mcp-tool', 'mcp-resource', 'mcp-app'].includes(response.kind as string) ||
    !nonemptyString(response.label) || typeof response.readOnly !== 'boolean' || !Array.isArray(response.targets)) {
    throw invalid('Runtime route returned an invalid surface.');
  }
  const fixtures = response.fixtures.map((fixtureValue) => {
    const fixture = record(fixtureValue);
    if (!hasOnly(fixture, ['id', 'label', 'seed']) || !nonemptyString(fixture.id) || !nonemptyString(fixture.label)) {
      throw invalid('Runtime route returned an invalid fixture.');
    }
    return Object.freeze({ ...(fixture.seed === undefined ? {} : { seed: jsonValue(fixture.seed) }), id: fixture.id, label: fixture.label });
  });
  const targets = stringArray(response.targets);
  if (new Set(targets).size !== targets.length || new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
    throw invalid('Runtime route returned duplicate surface identifiers.');
  }
  if (response.defaultTarget !== undefined && !targets.includes(response.defaultTarget)) throw invalid('Runtime route returned an invalid default target.');
  const inputSchema = response.inputSchema === undefined ? undefined : jsonObject(response.inputSchema, 'Runtime route returned an invalid input schema.');
  return Object.freeze({
    ...(response.defaultTarget === undefined ? {} : { defaultTarget: response.defaultTarget }),
    fixtures: Object.freeze(fixtures),
    id: response.id,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    kind: response.kind as DevRuntimeSurface['kind'],
    label: response.label,
    readOnly: response.readOnly,
    targets,
  });
};

const treeNode = (value: unknown): DevRuntimeTreeNode => {
  const response = record(value);
  if (!hasOnly(response, ['children', 'id', 'kind', 'label', 'props']) || !Array.isArray(response.children) ||
    !nonemptyString(response.id) || !['component', 'element', 'text', 'value'].includes(response.kind as string) || !nonemptyString(response.label)) {
    throw invalid('Runtime route returned an invalid tree node.');
  }
  return Object.freeze({
    children: Object.freeze(response.children.map(treeNode)),
    id: response.id,
    kind: response.kind as DevRuntimeTreeNode['kind'],
    label: response.label,
    ...(response.props === undefined ? {} : { props: jsonObject(response.props, 'Runtime route returned invalid tree props.') }),
  });
};

const traceSpan = (value: unknown): DevRuntimeTraceSpan => {
  const response = record(value);
  const startedAt = requiredDate(response.startedAt);
  if (!hasOnly(response, ['details', 'durationMs', 'id', 'parentId', 'phase', 'startedAt', 'status']) || !nonemptyString(response.id) ||
    !nonemptyString(response.phase) ||
    (response.parentId !== undefined && !nonemptyString(response.parentId)) ||
    (response.durationMs !== undefined && !nonnegativeNumber(response.durationMs)) ||
    (response.status !== 'running' && response.status !== 'succeeded' && response.status !== 'failed')) {
    throw invalid('Runtime route returned an invalid trace span.');
  }
  return Object.freeze({
    ...(response.details === undefined ? {} : { details: jsonObject(response.details, 'Runtime route returned invalid trace details.') }),
    ...(response.durationMs === undefined ? {} : { durationMs: response.durationMs }),
    id: response.id,
    ...(response.parentId === undefined ? {} : { parentId: response.parentId }),
    phase: response.phase,
    startedAt,
    status: response.status,
  });
};

const inspection = (value: unknown): DevRuntimeInspectionEnvelope => {
  const response = record(value);
  if (!hasOnly(response, ['agentVisible', 'app', 'flight', 'modelVisible', 'native', 'protocol', 'state', 'trace', 'tree']) ||
    !isRecord(response.state) || !hasOnly(response.state, ['identity', 'snapshot']) || !Array.isArray(response.trace) || !Array.isArray(response.tree)) {
    throw invalid('Runtime route returned an invalid inspection envelope.');
  }
  const app = response.app === undefined ? undefined : record(response.app, 'Runtime route returned an invalid App inspection.');
  let appSnapshot: DevRuntimeInspectionEnvelope['app'];
  if (app !== undefined) {
    const binding = record(app.mcpBinding, 'Runtime route returned an invalid App inspection.');
    if (!hasOnly(app, ['mcpBinding', 'resourceUri', 'surfaceId']) ||
      !hasOnly(binding, ['definitionDigest', 'registryRevision', 'serverDigest', 'serverName', 'sessionId', 'sessionRevision', 'target', 'transportDigest']) ||
      !nonemptyString(app.resourceUri) || !nonemptyString(app.surfaceId) || !nonemptyString(binding.definitionDigest) ||
      !nonnegativeInteger(binding.registryRevision) || !nonemptyString(binding.serverDigest) || !nonemptyString(binding.serverName) ||
      !nonemptyString(binding.sessionId) || !nonnegativeInteger(binding.sessionRevision) || !nonemptyString(binding.target) || !nonemptyString(binding.transportDigest)) {
      throw invalid('Runtime route returned an invalid App inspection.');
    }
    appSnapshot = Object.freeze({
      mcpBinding: Object.freeze({
        definitionDigest: binding.definitionDigest,
        registryRevision: binding.registryRevision,
        serverDigest: binding.serverDigest,
        serverName: binding.serverName,
        sessionId: binding.sessionId,
        sessionRevision: binding.sessionRevision,
        target: binding.target,
        transportDigest: binding.transportDigest,
      }),
      resourceUri: app.resourceUri,
      surfaceId: app.surfaceId,
    });
  }
  const flight = response.flight === undefined ? undefined : record(response.flight, 'Runtime route returned an invalid Flight inspection.');
  if (flight !== undefined && (!hasOnly(flight, ['bytes', 'downloadPath', 'preview', 'truncated']) || !nonnegativeInteger(flight.bytes) ||
    (flight.downloadPath !== undefined && !nonemptyString(flight.downloadPath)) || !nonemptyString(flight.preview) || typeof flight.truncated !== 'boolean')) {
    throw invalid('Runtime route returned an invalid Flight inspection.');
  }
  return Object.freeze({
    ...(response.agentVisible === undefined ? {} : { agentVisible: jsonValue(response.agentVisible) }),
    ...(appSnapshot === undefined ? {} : { app: appSnapshot }),
    ...(flight === undefined ? {} : { flight: Object.freeze({
      bytes: flight.bytes as number,
      ...(flight.downloadPath === undefined ? {} : { downloadPath: flight.downloadPath as string }),
      preview: flight.preview as string,
      truncated: flight.truncated as boolean,
    }) }),
    ...(response.modelVisible === undefined ? {} : { modelVisible: jsonValue(response.modelVisible) }),
    ...(response.native === undefined ? {} : { native: jsonValue(response.native) }),
    ...(response.protocol === undefined ? {} : { protocol: jsonValue(response.protocol) }),
    state: Object.freeze({
      identity: stateIdentity(response.state.identity),
      ...(response.state.snapshot === undefined ? {} : { snapshot: jsonValue(response.state.snapshot) }),
    }),
    trace: Object.freeze(response.trace.map(traceSpan)),
    tree: Object.freeze(response.tree.map(treeNode)),
  });
};

const run = (value: unknown): DevRuntimeRun => {
  const response = record(value);
  const startedAt = requiredDate(response.startedAt);
  if (!hasOnly(response, ['completedAt', 'diagnostics', 'fixtureId', 'id', 'input', 'result', 'startedAt', 'status', 'surfaceId', 'target', 'vector']) ||
    !nonemptyString(response.id) || !nonemptyString(response.surfaceId) || !nonemptyString(response.target) || response.input === undefined ||
    (response.fixtureId !== undefined && !nonemptyString(response.fixtureId)) ||
    (response.status !== 'running' && response.status !== 'succeeded' && response.status !== 'failed')) {
    throw invalid('Runtime route returned an invalid run.');
  }
  const base = {
    ...(response.fixtureId === undefined ? {} : { fixtureId: response.fixtureId }),
    id: response.id,
    input: jsonValue(response.input),
    startedAt,
    surfaceId: response.surfaceId,
    target: response.target,
    vector: vector(response.vector),
  };
  if (response.status === 'running') {
    if (response.completedAt !== undefined || response.diagnostics !== undefined || response.result !== undefined) throw invalid('Runtime route returned an invalid running run.');
    return Object.freeze({ ...base, status: 'running' });
  }
  const completedAt = requiredDate(response.completedAt, 'Runtime route returned an invalid completed run.');
  if (response.status === 'succeeded') {
    if (response.diagnostics !== undefined || response.result === undefined) throw invalid('Runtime route returned an invalid succeeded run.');
    return Object.freeze({ ...base, completedAt, result: inspection(response.result), status: 'succeeded' });
  }
  if (response.result !== undefined || !Array.isArray(response.diagnostics)) throw invalid('Runtime route returned an invalid failed run.');
  return Object.freeze({ ...base, completedAt, diagnostics: Object.freeze(response.diagnostics.map(diagnostic)), status: 'failed' });
};

const statusResponse = (value: unknown): DevRuntimeStatusResponse => {
  const response = record(value);
  if (!hasOnly(response, ['status']) || (response.status !== null && response.status === undefined)) throw invalid('Runtime route returned an invalid status wrapper.');
  return Object.freeze({ status: response.status === null ? null : status(response.status) });
};

const surfacesResponse = (value: unknown): DevRuntimeSurfacesResponse => {
  const response = record(value);
  if (!hasOnly(response, ['surfaces']) || !Array.isArray(response.surfaces)) throw invalid('Runtime route returned an invalid surfaces wrapper.');
  const surfaces = Object.freeze(response.surfaces.map(surface));
  if (new Set(surfaces.map((item) => item.id)).size !== surfaces.length) throw invalid('Runtime route returned duplicate surface identifiers.');
  return Object.freeze({ surfaces });
};

const runResponse = (value: unknown): DevRuntimeRunResponse => {
  const response = record(value);
  if (!hasOnly(response, ['run']) || response.run === undefined) throw invalid('Runtime route returned an invalid run wrapper.');
  return Object.freeze({ run: run(response.run) });
};

const runsResponse = (value: unknown): DevRuntimeRunsResponse => {
  const response = record(value);
  if (!hasOnly(response, ['providerSessionId', 'runs']) || !nonemptyString(response.providerSessionId) || !Array.isArray(response.runs)) {
    throw invalid('Runtime route returned an invalid runs wrapper.');
  }
  const runs = Object.freeze(response.runs.map(run));
  if (runs.length > 50 || new Set(runs.map((item) => item.id)).size !== runs.length ||
    runs.some((item) => item.vector.providerSessionId !== response.providerSessionId) || !isServerOrdered(runs)) {
    throw invalid('Runtime route returned an invalid run history.');
  }
  return Object.freeze({ providerSessionId: response.providerSessionId, runs });
};

const stateResponse = (value: unknown): DevRuntimeStateResponse => {
  const response = record(value);
  if (!hasOnly(response, ['state']) || response.state === undefined) throw invalid('Runtime route returned an invalid state wrapper.');
  return Object.freeze({ state: stateIdentity(response.state) });
};

const isServerOrdered = (runs: readonly DevRuntimeRun[]): boolean => runs.every((next, index) => {
  const previous = runs[index - 1];
  return previous === undefined || previous.startedAt > next.startedAt ||
    (previous.startedAt === next.startedAt && previous.id.localeCompare(next.id) >= 0);
});

const opaqueSegment = (value: string, label: string): string => {
  if (!nonemptyString(value) || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw invalid(`${label} is not a valid opaque runtime segment.`);
  }
  return encodeURIComponent(value);
};

const invalid = (message: string): RuntimeClientError => new RuntimeClientError({ code: runtimeErrorCode, message });

const runtimeError = (error: unknown): RuntimeClientError => {
  if (error instanceof RuntimeClientError) return error;
  if (error instanceof ForegroundRouteClientError) {
    return new RuntimeClientError({
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      message: error.message,
      ...(error.phase === undefined ? {} : { phase: error.phase }),
    });
  }
  return invalid('Runtime request could not be completed.');
};

/** Typed immutable browser client for the provider-owned runtime routes. */
export class RuntimeClient {
  readonly #foreground: ForegroundRouteClient;
  #providerSessionId: string | undefined;

  constructor(foreground: ForegroundRouteClient) {
    this.#foreground = foreground;
  }

  async bootstrap(): Promise<RuntimeBootstrap> {
    try {
      const statusResult = statusResponse(await this.#foreground.publicJson('/api/runtime/status'));
      if (statusResult.status === null) return Object.freeze({ kind: 'unavailable' });
      const [surfacesResult, historyResult] = await Promise.all([
        this.#foreground.publicJson('/api/runtime/surfaces').then(surfacesResponse),
        this.#foreground.protectedJson('/api/runtime/runs?limit=50').then(runsResponse),
      ]);
      this.#providerSessionId = historyResult.providerSessionId;
      return Object.freeze({
        history: historyResult.runs,
        kind: 'available',
        providerSessionId: historyResult.providerSessionId,
        status: statusResult.status,
        surfaces: surfacesResult.surfaces,
      });
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async createRun(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun> {
    return this.#runRequest('/api/runtime/runs', request, 'POST');
  }

  async readRun(runId: string): Promise<DevRuntimeRun> {
    return this.#readRun(`/api/runtime/runs/${opaqueSegment(runId, 'Runtime run ID')}`);
  }

  async replayRun(request: DevRuntimeReplayRequest): Promise<DevRuntimeRun> {
    const path = `/api/runtime/runs/${opaqueSegment(request.runId, 'Runtime run ID')}/replay`;
    return this.#runRequest(path, request, 'POST');
  }

  async resetState(request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity> {
    try {
      return stateResponse(await this.#foreground.protectedJson('/api/runtime/state/reset', {
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })).state;
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async readAsset(request: DevRuntimeAssetRequest): Promise<Blob> {
    if (request.path.length === 0) throw invalid('Runtime asset path is not valid.');
    try {
      const path = request.path.map((segment) => opaqueSegment(segment, 'Runtime asset path segment')).join('/');
      const response = await this.#foreground.protectedResponse(
        `/api/runtime/assets/${opaqueSegment(request.surfaceId, 'Runtime surface ID')}/${path}?generation=${opaqueSegment(request.runtimeGenerationId, 'Runtime generation ID')}`,
      );
      const contentType = response.headers.get('content-type');
      const declaredLength = response.headers.get('content-length');
      if (contentType === null || !runtimeAssetContentTypes.has(contentType) ||
        (declaredLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) || Number(declaredLength) > runtimeAssetLimit))) {
        throw invalid('Runtime asset response is not valid.');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > runtimeAssetLimit) throw invalid('Runtime asset exceeds the allowed size.');
      return new Blob([bytes], { type: contentType });
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async #readRun(path: string): Promise<DevRuntimeRun> {
    try {
      return this.#assertProvider(runResponse(await this.#foreground.protectedJson(path)).run);
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async #runRequest(path: string, request: DevRuntimeInvocationRequest | DevRuntimeReplayRequest, method: 'POST'): Promise<DevRuntimeRun> {
    try {
      return this.#assertProvider(runResponse(await this.#foreground.protectedJson(path, {
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json' },
        method,
      })).run);
    } catch (error) {
      throw runtimeError(error);
    }
  }

  #assertProvider(value: DevRuntimeRun): DevRuntimeRun {
    if (this.#providerSessionId !== undefined && value.vector.providerSessionId !== this.#providerSessionId) {
      throw invalid('Runtime route returned a run for another provider session.');
    }
    return value;
  }
}

export class RuntimeClientError extends Error {
  readonly code: string;
  readonly details: unknown | undefined;
  readonly phase: string | undefined;

  constructor(diagnostic: Readonly<{ readonly code: string; readonly details?: unknown; readonly message: string; readonly phase?: string }>) {
    super(diagnostic.message);
    this.name = 'RuntimeClientError';
    this.code = diagnostic.code;
    this.details = diagnostic.details === undefined ? undefined : jsonValue(diagnostic.details);
    this.phase = diagnostic.phase;
  }
}
