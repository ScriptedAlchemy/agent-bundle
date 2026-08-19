import type { Diagnostic } from '../../../agent-bundle/src/core/diagnostics.ts';
import type { ArtifactEpochDiff, ArtifactInspection } from '../../../agent-bundle/src/dev/types.ts';
import { CodedClientError, exactRecord, isDiagnostic, isRecord } from '../client-helpers.ts';
import { ForegroundSessionAuthority, ForegroundTransport } from '../foreground-session.ts';
import { snapshotStrictJsonValue } from '../strict-json.ts';

export interface ArtifactClientOptions {
  readonly authority?: ForegroundSessionAuthority;
  readonly fetch?: typeof fetch;
}

const noDiagnostics: readonly Diagnostic[] = Object.freeze([]);

/** Carries the artifact validation diagnostics of a refused epoch, which are the point of AB8064. */
export class ArtifactClientError extends CodedClientError {
  readonly diagnostics: readonly Diagnostic[];

  constructor(code: string, message: string, diagnostics: readonly Diagnostic[] = noDiagnostics) {
    super('ArtifactClientError', code, message);
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

const arrayOf = (value: unknown, predicate: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(predicate);

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isSourceInput = (value: unknown): boolean =>
  exactRecord(value, ['path', 'sha256']) && typeof value.path === 'string' && typeof value.sha256 === 'string';

const isArtifactFile = (value: unknown): boolean =>
  exactRecord(value, ['bytes', 'kind', 'path', 'sha256', 'sourceInputs'], ['mode']) &&
  finiteNumber(value.bytes) && (value.kind === 'bundle' || value.kind === 'copy' || value.kind === 'generated') &&
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
  exactRecord(value, ['configDigest', 'configPath', 'modelDigest', 'revision', 'sourceInputs']) &&
  typeof value.configDigest === 'string' && typeof value.configPath === 'string' &&
  typeof value.modelDigest === 'string' && typeof value.revision === 'string' && arrayOf(value.sourceInputs, isSourceInput);

const isProvenance = (value: unknown): boolean =>
  exactRecord(value, ['outputPath', 'sourceInputs']) && typeof value.outputPath === 'string' &&
  arrayOf(value.sourceInputs, isSourceInput);

const isHook = (value: unknown): boolean =>
  exactRecord(value, ['event', 'file', 'id', 'name', 'path', 'target'], ['timeout']) &&
  typeof value.event === 'string' && isArtifactFile(value.file) && typeof value.id === 'string' &&
  typeof value.name === 'string' && typeof value.path === 'string' && typeof value.target === 'string' &&
  (!Object.hasOwn(value, 'timeout') || finiteNumber(value.timeout));

const isMcpServer = (value: unknown): boolean =>
  exactRecord(value, ['entryPaths', 'kind', 'manifestPath', 'name', 'target']) &&
  arrayOf(value.entryPaths, (entry) => typeof entry === 'string') &&
  (value.kind === 'stdio' || value.kind === 'streamable-http') && typeof value.manifestPath === 'string' &&
  typeof value.name === 'string' && typeof value.target === 'string';

const isScript = (value: unknown): boolean =>
  exactRecord(value, ['file', 'id', 'name', 'target']) && isArtifactFile(value.file) &&
  typeof value.id === 'string' && typeof value.name === 'string' && typeof value.target === 'string';

const isRuntime = (value: unknown): boolean =>
  exactRecord(value, ['executables', 'hooks', 'mcpServers', 'scripts']) &&
  arrayOf(value.executables, isArtifactFile) && arrayOf(value.hooks, isHook) &&
  arrayOf(value.mcpServers, isMcpServer) && arrayOf(value.scripts, isScript);

const isTarget = (value: unknown): boolean =>
  exactRecord(value, ['name', 'tree']) && typeof value.name === 'string' &&
  exactRecord(value.tree, ['children', 'kind', 'name', 'path']) && value.tree.kind === 'directory' &&
  typeof value.tree.name === 'string' && typeof value.tree.path === 'string' && arrayOf(value.tree.children, isTreeNode);

const isInspection = (value: unknown): value is ArtifactInspection =>
  exactRecord(value, ['epochId', 'files', 'project', 'provenance', 'runtime', 'targets']) &&
  typeof value.epochId === 'string' && arrayOf(value.files, isArtifactFile) && isProject(value.project) &&
  arrayOf(value.provenance, isProvenance) && isRuntime(value.runtime) && arrayOf(value.targets, isTarget);

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

const failureDiagnostics = (value: unknown): readonly Diagnostic[] => {
  if (!isRecord(value) || !Array.isArray(value.diagnostics)) return noDiagnostics;
  try {
    const diagnostics = snapshotStrictJsonValue(value.diagnostics);
    return Array.isArray(diagnostics) && diagnostics.every(isDiagnostic) ? diagnostics : noDiagnostics;
  }
  catch { return noDiagnostics; }
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
  readonly #transport: ForegroundTransport;

  constructor(options: ArtifactClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message, body) => new ArtifactClientError(code, message, failureDiagnostics(body)),
      fallbackCode: 'AB8063',
      ...(options.authority === undefined ? {} : { authority: options.authority }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Artifact inspection',
    });
  }

  async inspect(epochId: string, signal?: AbortSignal): Promise<ArtifactInspection> {
    return inspectionBody(await this.#transport.json(`/api/artifacts/epochs/${encodeURIComponent(epochId)}`, { signal }));
  }

  async diff(baseEpochId: string, candidateEpochId: string, signal?: AbortSignal): Promise<ArtifactEpochDiff> {
    const query = new URLSearchParams({ base: baseEpochId, candidate: candidateEpochId });
    return diffBody(await this.#transport.json(`/api/artifacts/diff?${query.toString()}`, { signal }));
  }

}
