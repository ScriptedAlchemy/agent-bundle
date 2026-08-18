import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Diagnostic } from '../core/diagnostics.ts';
import {
  ArtifactInspectionServiceError,
  type ArtifactInspectionServiceErrorCode,
} from './artifact-inspection-service.ts';
import { EpochStoreError, type EpochStoreErrorCode } from './epoch-store.ts';
import type { ArtifactEpochDiff, ArtifactInspection } from './types.ts';

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

type Route =
  | Readonly<{ readonly epochId: string; readonly kind: 'epoch' }>
  | Readonly<{ readonly kind: 'diff' }>;

export interface ArtifactRouteService {
  diff(baseEpochId: string, candidateEpochId: string): Promise<ArtifactEpochDiff>;
  inspect(epochId: string): Promise<ArtifactInspection>;
}

export interface ArtifactRoutesOptions {
  /** The foreground server injects its existing same-origin, same-session guard. */
  readonly authorize: (request: IncomingMessage) => void;
  /** Omitted until the workbench composes an epoch-bound inspection service. */
  readonly service?: ArtifactRouteService;
}

const diagnostic = (code: string, message: string, status: number): RequestDiagnostic => ({ code, message, status });

const requestError = (
  value: RequestDiagnostic,
  diagnostics?: readonly Diagnostic[],
): RequestDiagnostic & Error => Object.assign(
  new Error(value.message),
  value,
  diagnostics === undefined ? {} : { diagnostics },
);

const isRequestDiagnostic = (value: unknown): value is RequestDiagnostic =>
  typeof value === 'object' && value !== null &&
  typeof (value as Partial<RequestDiagnostic>).code === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).message === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).status === 'number';

/** Inspection messages name epoch paths, so each code keeps one fixed browser-facing sentence. */
const inspectionDiagnostics: Readonly<Record<ArtifactInspectionServiceErrorCode, RequestDiagnostic>> = Object.freeze({
  ARTIFACT_INSPECTION_INVALID: diagnostic('AB8064', 'Artifact epoch failed validation.', 422),
  ARTIFACT_INSPECTION_RELEASE_FAILED: diagnostic('AB8066', 'Artifact epoch reference could not be released.', 500),
  ARTIFACT_INSPECTION_RUNTIME_INVALID: diagnostic('AB8065', 'Artifact runtime metadata is not valid.', 422),
});

const epochDiagnostics: Readonly<Partial<Record<EpochStoreErrorCode, RequestDiagnostic>>> = Object.freeze({
  EPOCH_ID_INVALID: diagnostic('AB8068', 'Artifact epoch id is not valid.', 400),
  EPOCH_NOT_FOUND: diagnostic('AB8067', 'Artifact epoch was not found.', 404),
});

const responseDiagnostic = (response: ServerResponse, value: RequestDiagnostic): void => {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(value.status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ diagnostic: { code: value.code, message: value.message } }));
};

const responseJson = (response: ServerResponse, body: unknown): void => {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const rawPathname = (requestTarget: string | undefined): string => requestTarget?.split(/[?#]/u, 1)[0] ?? '';

const pathError = (): never => {
  throw requestError(diagnostic('AB8060', 'Artifact route path is not valid.', 400));
};

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8062', 'Artifact request has an invalid shape.', 400));
};

const decodedSegment = (segment: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return pathError();
  }
  if (
    decoded.length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  ) {
    return pathError();
  }
  return decoded;
};

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/artifacts' && !pathname.startsWith('/api/artifacts/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'artifacts') return pathError();
  const segments = parts.slice(3).map(decodedSegment);
  if (segments.length === 1 && segments[0] === 'diff') return Object.freeze({ kind: 'diff' });
  if (segments.length !== 2 || segments[0] !== 'epochs') return pathError();
  return Object.freeze({ epochId: segments[1]!, kind: 'epoch' });
};

const nonemptyString = (value: string | null): value is string =>
  value !== null && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');

const diffQuery = (requestTarget: string | undefined): Readonly<{ readonly base: string; readonly candidate: string }> => {
  const query = new URL(requestTarget ?? '/', 'http://localhost').searchParams;
  if ([...query.keys()].some((key) => key !== 'base' && key !== 'candidate')) invalidShape();
  if (query.getAll('base').length !== 1 || query.getAll('candidate').length !== 1) invalidShape();
  const base = query.get('base');
  const candidate = query.get('candidate');
  if (!nonemptyString(base) || !nonemptyString(candidate)) return invalidShape();
  return Object.freeze({ base, candidate });
};

const noQuery = (requestTarget: string | undefined): void => {
  if (new URL(requestTarget ?? '/', 'http://localhost').searchParams.size > 0) invalidShape();
};

/**
 * Read-only HTTP boundary over published artifact epochs. The browser names an
 * epoch id; the service resolves every path and holds the epoch reference.
 */
export class ArtifactRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #service: ArtifactRouteService | undefined;
  #closed = false;

  constructor(options: ArtifactRoutesOptions) {
    this.#authorize = options.authorize;
    this.#service = options.service;
  }

  close(): void {
    this.#closed = true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    this.#authorize(request);
    if (this.#closed) throw this.#unavailable(503);
    const service = this.#service;
    if (service === undefined) throw this.#unavailable(404);
    try {
      await this.#dispatch(parsed, request, response, service);
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      if (error instanceof ArtifactInspectionServiceError) {
        throw requestError(inspectionDiagnostics[error.code], error.diagnostics);
      }
      if (error instanceof EpochStoreError) {
        const mapped = epochDiagnostics[error.code];
        if (mapped !== undefined) throw requestError(mapped);
      }
      throw requestError(diagnostic('AB8063', 'Artifact inspection could not be completed.', 502));
    }
    return true;
  }

  async #dispatch(
    parsed: Route,
    request: IncomingMessage,
    response: ServerResponse,
    service: ArtifactRouteService,
  ): Promise<void> {
    if ((request.method ?? 'GET') !== 'GET') {
      return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    }
    if (parsed.kind === 'diff') {
      const query = diffQuery(request.url);
      return responseJson(response, { diff: await service.diff(query.base, query.candidate) });
    }
    noQuery(request.url);
    return responseJson(response, { inspection: await service.inspect(parsed.epochId) });
  }

  #unavailable(status: number): Error {
    return requestError(diagnostic('AB8061', 'Artifact routes are not available.', status));
  }
}
