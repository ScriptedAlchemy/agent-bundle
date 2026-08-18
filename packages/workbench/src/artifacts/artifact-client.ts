import type { Diagnostic } from '../../../agent-bundle/src/core/diagnostics.ts';
import { ForegroundTransport } from '../foreground-session.ts';
import type { ArtifactEpochDiff, ArtifactInspection } from '../../../agent-bundle/src/dev/types.ts';

export interface ArtifactClientOptions {
  readonly fetch?: typeof fetch;
}

interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidResponse = (): ArtifactClientError =>
  new ArtifactClientError('AB8063', 'Artifact route returned an invalid response.');

const frozenJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenJson));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, frozenJson(entry)])));
  }
  return value;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw invalidResponse();
  return value;
};

const isDiagnostic = (value: unknown): value is Diagnostic =>
  isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string' &&
  (value.severity === 'error' || value.severity === 'info' || value.severity === 'warning');

const failureDiagnostics = (value: unknown): readonly Diagnostic[] => {
  if (!isRecord(value) || !Array.isArray(value.diagnostics)) return noDiagnostics;
  if (!value.diagnostics.every(isDiagnostic)) return noDiagnostics;
  return frozenJson(value.diagnostics) as readonly Diagnostic[];
};

const inspectionBody = (value: unknown): ArtifactInspection => {
  const inspection = asRecord(value).inspection;
  if (!isRecord(inspection)) throw invalidResponse();
  if (typeof inspection.epochId !== 'string' || !Array.isArray(inspection.files) || !Array.isArray(inspection.targets)) {
    throw invalidResponse();
  }
  if (!isRecord(inspection.project) || !isRecord(inspection.runtime) || !Array.isArray(inspection.provenance)) {
    throw invalidResponse();
  }
  return frozenJson(inspection) as ArtifactInspection;
};

const diffBody = (value: unknown): ArtifactEpochDiff => {
  const diff = asRecord(value).diff;
  if (!isRecord(diff)) throw invalidResponse();
  if (typeof diff.baseEpochId !== 'string' || typeof diff.candidateEpochId !== 'string') throw invalidResponse();
  if (!Array.isArray(diff.added) || !Array.isArray(diff.changed) ||
    !Array.isArray(diff.removed) || !Array.isArray(diff.unchanged)) {
    throw invalidResponse();
  }
  return frozenJson(diff) as ArtifactEpochDiff;
};

/** A typed, credential-memory-only browser client for the read-only artifact epoch routes. */
export class ArtifactClient {
  readonly #transport: ForegroundTransport;

  constructor(options: ArtifactClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message, body) => new ArtifactClientError(code, message, failureDiagnostics(body)),
      fallbackCode: 'AB8063',
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

  /** Erases the short-lived foreground token once the owning page stops using it. */
  forgetAuthentication(): void {
    this.#transport.forget();
  }

}
