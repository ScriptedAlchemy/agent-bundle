import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import { snapshotStrictJsonValue } from '../../../agent-bundle/src/contracts/strict-json.ts';
import type { ArtifactEpochDiff, ArtifactInspection } from '../../../agent-bundle/src/contracts/artifacts.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';
import { hasAllowedKeys, isRecord } from '../client-helpers.ts';

export interface ArtifactClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

const noDiagnostics: readonly Diagnostic[] = Object.freeze([]);

/** Carries the artifact validation diagnostics of a refused epoch, which are the point of AB8064. */
export class ArtifactClientError extends Error {
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[];

  constructor(code: string, message: string, diagnostics: readonly Diagnostic[] = noDiagnostics) {
    super(message);
    this.name = 'ArtifactClientError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

const invalidResponse = (): ArtifactClientError =>
  new ArtifactClientError('AB8063', 'Artifact route returned an invalid response.');

const detachedRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  try {
    const detached = snapshotStrictJsonValue(value);
    if (!isRecord(detached)) throw invalidResponse();
    return detached;
  } catch {
    throw invalidResponse();
  }
};

const exactRecord = hasAllowedKeys;

const arrayOf = (value: unknown, predicate: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(predicate);

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isSourceInput = (value: unknown): boolean =>
  exactRecord(value, ['path', 'sha256']) && typeof value.path === 'string' && typeof value.sha256 === 'string';

const isArtifactFile = (value: unknown): boolean =>
  exactRecord(value, ['bytes', 'kind', 'path', 'sha256', 'sourceInputs'], ['mode']) &&
  finiteNumber(value.bytes) && (value.kind === 'bundle' || value.kind === 'copy' || value.kind === 'generated' || value.kind === 'prebuilt') &&
  typeof value.path === 'string' && typeof value.sha256 === 'string' && arrayOf(value.sourceInputs, isSourceInput) &&
  (!Object.hasOwn(value, 'mode') || finiteNumber(value.mode));

const isTreeNode = (value: unknown): boolean => {
  if (exactRecord(value, ['children', 'kind', 'name', 'path'])) {
    return value.kind === 'directory' && typeof value.name === 'string' && typeof value.path === 'string' &&
      arrayOf(value.children, isTreeNode);
  }
  return exactRecord(value, ['file', 'kind', 'name', 'path']) && value.kind === 'file' &&
    isArtifactFile(value.file) && typeof value.name === 'string' && typeof value.path === 'string';
};

const isProject = (value: unknown): boolean =>
  exactRecord(value, ['configDigest', 'configPath', 'modelDigest', 'revision', 'sourceInputs'], ['packageName', 'packageVersion']) &&
  typeof value.configDigest === 'string' && typeof value.configPath === 'string' &&
  typeof value.modelDigest === 'string' && typeof value.revision === 'string' && arrayOf(value.sourceInputs, isSourceInput) &&
  (!Object.hasOwn(value, 'packageName') || typeof value.packageName === 'string') &&
  (!Object.hasOwn(value, 'packageVersion') || typeof value.packageVersion === 'string');

const isProvenance = (value: unknown): boolean =>
  exactRecord(value, ['outputPath', 'sourceInputs']) && typeof value.outputPath === 'string' &&
  arrayOf(value.sourceInputs, isSourceInput);

const isApplication = (value: unknown): boolean =>
  exactRecord(value, ['id', 'name', 'version'], ['description']) &&
  typeof value.id === 'string' && typeof value.name === 'string' && typeof value.version === 'string' &&
  (!Object.hasOwn(value, 'description') || typeof value.description === 'string');

const isDistribution = (value: unknown): boolean => {
  if (!exactRecord(value, ['channels'], ['install']) ||
    !arrayOf(value.channels, (channel) => channel === 'local' || channel === 'npm')) return false;
  if (!Object.hasOwn(value, 'install')) return true;
  return exactRecord(value.install, [], ['instructions', 'script']) &&
    (!Object.hasOwn(value.install, 'instructions') || typeof value.install.instructions === 'string') &&
    (!Object.hasOwn(value.install, 'script') || typeof value.install.script === 'string');
};

const isExplorerDocument = (value: unknown): boolean =>
  exactRecord(value, ['kind', 'path']) &&
  (value.kind === 'hooks' || value.kind === 'marketplace' || value.kind === 'mcp' || value.kind === 'plugin') &&
  typeof value.path === 'string';

const isExplorerHost = (value: unknown): boolean =>
  exactRecord(value, ['builtIn', 'documents', 'host'], ['marketplace']) &&
  typeof value.builtIn === 'boolean' && arrayOf(value.documents, isExplorerDocument) &&
  typeof value.host === 'string' &&
  (!Object.hasOwn(value, 'marketplace') || typeof value.marketplace === 'string');

const isExplorerRoute = (value: unknown): boolean =>
  exactRecord(value, ['id', 'name'], ['description']) &&
  typeof value.id === 'string' && typeof value.name === 'string' &&
  (!Object.hasOwn(value, 'description') || typeof value.description === 'string');

const isExplorerServer = (value: unknown): boolean =>
  exactRecord(value, ['apps', 'hosts', 'id', 'kind', 'name', 'prompts', 'resources', 'tools', 'transport'], ['entry']) &&
  arrayOf(value.apps, isMcpApp) && arrayOf(value.hosts, (host) => typeof host === 'string') &&
  typeof value.id === 'string' && (value.kind === 'command' || value.kind === 'compiled' || value.kind === 'remote') &&
  typeof value.name === 'string' && arrayOf(value.prompts, isExplorerRoute) &&
  arrayOf(value.resources, isExplorerRoute) && arrayOf(value.tools, isExplorerRoute) &&
  typeof value.transport === 'string' &&
  (!Object.hasOwn(value, 'entry') || typeof value.entry === 'string');

const isExplorerEventHook = (value: unknown): boolean =>
  exactRecord(value, ['host', 'kind', 'path'], ['timeout']) &&
  typeof value.host === 'string' && value.kind === 'event-route' && typeof value.path === 'string' &&
  (!Object.hasOwn(value, 'timeout') || finiteNumber(value.timeout));

const isExplorerEvent = (value: unknown): boolean =>
  exactRecord(value, ['event', 'hooks', 'id']) &&
  typeof value.event === 'string' && arrayOf(value.hooks, isExplorerEventHook) && typeof value.id === 'string';

const isExplorerConfigHook = (value: unknown): boolean =>
  exactRecord(value, ['event', 'id', 'kind', 'name', 'path'], ['timeout']) &&
  typeof value.event === 'string' && typeof value.id === 'string' && value.kind === 'config' &&
  typeof value.name === 'string' && typeof value.path === 'string' &&
  (!Object.hasOwn(value, 'timeout') || finiteNumber(value.timeout));

const isExplorerHookGroup = (value: unknown): boolean =>
  exactRecord(value, ['hooks', 'host']) &&
  arrayOf(value.hooks, isExplorerConfigHook) && typeof value.host === 'string';

const isExplorerCommand = (value: unknown): boolean =>
  exactRecord(value, ['path', 'routeId']) &&
  arrayOf(value.path, (segment) => typeof segment === 'string') && typeof value.routeId === 'string';

const isExplorerBin = (value: unknown): boolean =>
  exactRecord(value, ['hosts', 'name', 'path']) &&
  arrayOf(value.hosts, (host) => typeof host === 'string') &&
  typeof value.name === 'string' && typeof value.path === 'string';

const isExplorerCli = (value: unknown): boolean =>
  exactRecord(value, ['bins', 'commands', 'mode']) &&
  arrayOf(value.bins, isExplorerBin) && arrayOf(value.commands, isExplorerCommand) &&
  (value.mode === 'conflict' || value.mode === 'conventional' || value.mode === 'generated');

const isExplorerScript = (value: unknown): boolean =>
  exactRecord(value, ['hosts', 'id', 'mode', 'name', 'path']) &&
  arrayOf(value.hosts, (host) => typeof host === 'string') && typeof value.id === 'string' &&
  (value.mode === 'bundle' || value.mode === 'copy') && typeof value.name === 'string' &&
  typeof value.path === 'string';

const isApplicationExplorer = (value: unknown): boolean =>
  exactRecord(value, ['distribution', 'events', 'hooks', 'hosts', 'identity', 'scripts', 'servers'], ['cli']) &&
  isDistribution(value.distribution) && arrayOf(value.events, isExplorerEvent) &&
  arrayOf(value.hooks, isExplorerHookGroup) && arrayOf(value.hosts, isExplorerHost) &&
  isApplication(value.identity) && arrayOf(value.scripts, isExplorerScript) &&
  arrayOf(value.servers, isExplorerServer) &&
  (!Object.hasOwn(value, 'cli') || isExplorerCli(value.cli));

const isHook = (value: unknown): boolean =>
  exactRecord(value, ['event', 'file', 'id', 'kind', 'name', 'path', 'target'], ['timeout']) &&
  typeof value.event === 'string' && isArtifactFile(value.file) && typeof value.id === 'string' &&
  (value.kind === 'config' || value.kind === 'event-route') &&
  typeof value.name === 'string' && typeof value.path === 'string' && typeof value.target === 'string' &&
  (!Object.hasOwn(value, 'timeout') || finiteNumber(value.timeout));

const isMcpApp = (value: unknown): boolean =>
  exactRecord(value, ['id', 'name', 'resourceUri'], ['path']) &&
  typeof value.id === 'string' && typeof value.name === 'string' && typeof value.resourceUri === 'string' &&
  (!Object.hasOwn(value, 'path') || typeof value.path === 'string');

const isMcpServer = (value: unknown): boolean =>
  exactRecord(value, ['apps', 'entryPaths', 'kind', 'manifestPath', 'name', 'target']) &&
  arrayOf(value.apps, isMcpApp) &&
  arrayOf(value.entryPaths, (entry) => typeof entry === 'string') &&
  (value.kind === 'command' || value.kind === 'compiled' || value.kind === 'remote') &&
  typeof value.manifestPath === 'string' &&
  typeof value.name === 'string' && typeof value.target === 'string';

const isScript = (value: unknown): boolean =>
  exactRecord(value, ['file', 'id', 'mode', 'name', 'target'], ['rendered', 'worker']) &&
  isArtifactFile(value.file) && typeof value.id === 'string' && (value.mode === 'bundle' || value.mode === 'copy') &&
  typeof value.name === 'string' && typeof value.target === 'string' &&
  (!Object.hasOwn(value, 'rendered') || typeof value.rendered === 'string') &&
  (!Object.hasOwn(value, 'worker') || isArtifactFile(value.worker));

const isBin = (value: unknown): boolean =>
  exactRecord(value, ['file', 'hosts', 'name'], ['worker']) &&
  isArtifactFile(value.file) && arrayOf(value.hosts, (host) => typeof host === 'string') &&
  typeof value.name === 'string' && (!Object.hasOwn(value, 'worker') || isArtifactFile(value.worker));

const isRuntime = (value: unknown): boolean =>
  exactRecord(value, ['bins', 'executables', 'hooks', 'mcpServers', 'scripts']) &&
  arrayOf(value.bins, isBin) && arrayOf(value.executables, isArtifactFile) && arrayOf(value.hooks, isHook) &&
  arrayOf(value.mcpServers, isMcpServer) && arrayOf(value.scripts, isScript);

const isProjectionDocuments = (value: unknown): boolean =>
  exactRecord(value, [], ['hooks', 'marketplace', 'mcp', 'plugin']) &&
  ['hooks', 'marketplace', 'mcp', 'plugin'].every((key) =>
    !Object.hasOwn(value, key) || typeof value[key] === 'string');

const isProjection = (value: unknown): boolean =>
  exactRecord(value, ['documents', 'host', 'tree'], ['marketplace']) &&
  isProjectionDocuments(value.documents) && typeof value.host === 'string' &&
  (!Object.hasOwn(value, 'marketplace') || typeof value.marketplace === 'string') &&
  exactRecord(value.tree, ['children', 'kind', 'name', 'path']) && value.tree.kind === 'directory' &&
  typeof value.tree.name === 'string' && typeof value.tree.path === 'string' && arrayOf(value.tree.children, isTreeNode);

const isInspection = (value: unknown): value is ArtifactInspection =>
  exactRecord(value, ['application', 'epochId', 'files', 'project', 'projections', 'provenance', 'runtime']) &&
  isApplicationExplorer(value.application) && typeof value.epochId === 'string' &&
  arrayOf(value.files, isArtifactFile) && isProject(value.project) && arrayOf(value.projections, isProjection) &&
  arrayOf(value.provenance, isProvenance) && isRuntime(value.runtime);

const isAddedFile = (value: unknown): boolean =>
  exactRecord(value, ['after', 'path']) && isArtifactFile(value.after) && typeof value.path === 'string';

const isRemovedFile = (value: unknown): boolean =>
  exactRecord(value, ['before', 'path']) && isArtifactFile(value.before) && typeof value.path === 'string';

const isChangedFile = (value: unknown): boolean =>
  exactRecord(value, ['after', 'before', 'path']) && isArtifactFile(value.after) &&
  isArtifactFile(value.before) && typeof value.path === 'string';

const isDiff = (value: unknown): value is ArtifactEpochDiff =>
  exactRecord(value, ['added', 'baseEpochId', 'candidateEpochId', 'changed', 'removed', 'unchanged']) &&
  arrayOf(value.added, isAddedFile) && typeof value.baseEpochId === 'string' && typeof value.candidateEpochId === 'string' &&
  arrayOf(value.changed, isChangedFile) && arrayOf(value.removed, isRemovedFile) && arrayOf(value.unchanged, isChangedFile);

const isDiagnostic = (value: unknown): value is Diagnostic =>
  isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string' &&
  (value.severity === 'error' || value.severity === 'info' || value.severity === 'warning');

const failureDiagnostics = (value: unknown): readonly Diagnostic[] => {
  if (!isRecord(value) || !Array.isArray(value.diagnostics)) return noDiagnostics;
  try {
    const diagnostics = snapshotStrictJsonValue(value.diagnostics);
    return Array.isArray(diagnostics) && diagnostics.every(isDiagnostic) ? diagnostics : noDiagnostics;
  }
  catch { return noDiagnostics; }
};

const diagnosticError = (value: unknown, status: number): ArtifactClientError => {
  if (isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return new ArtifactClientError(value.diagnostic.code, value.diagnostic.message, failureDiagnostics(value));
  }
  return new ArtifactClientError('AB8063', `Artifact inspection request failed with HTTP ${status}.`);
};

const inspectionBody = (value: unknown): ArtifactInspection => {
  const body = detachedRecord(value);
  if (!exactRecord(body, ['inspection']) || !isInspection(body.inspection)) throw invalidResponse();
  return body.inspection;
};

const diffBody = (value: unknown): ArtifactEpochDiff => {
  const body = detachedRecord(value);
  if (!exactRecord(body, ['diff']) || !isDiff(body.diff)) throw invalidResponse();
  return body.diff;
};

/** A typed, credential-memory-only browser client for the read-only artifact epoch routes. */
export class ArtifactClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: ArtifactClientOptions) {
    this.#foreground = options.foreground;
  }

  async inspect(epochId: string, signal?: AbortSignal): Promise<ArtifactInspection> {
    return inspectionBody(await this.#json(`/api/artifacts/epochs/${encodeURIComponent(epochId)}`, signal));
  }

  async diff(baseEpochId: string, candidateEpochId: string, signal?: AbortSignal): Promise<ArtifactEpochDiff> {
    const query = new URLSearchParams({ base: baseEpochId, candidate: candidateEpochId });
    return diffBody(await this.#json(`/api/artifacts/diff?${query.toString()}`, signal));
  }

  async #json(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.#foreground.protectedRequest(path, signal === undefined ? {} : { signal });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return body;
  }
}
