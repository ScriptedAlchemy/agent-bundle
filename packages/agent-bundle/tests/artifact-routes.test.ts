import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import {
  ArtifactRoutes,
  type ArtifactRouteService,
} from '../src/dev/artifact-routes.ts';
import { ArtifactInspectionServiceError } from '../src/dev/artifact-inspection-service.ts';
import { EpochStoreError } from '../src/dev/epoch-store.ts';
import type { ArtifactEpochDiff, ArtifactInspection } from '../src/dev/types.ts';

interface StartedRoutes {
  readonly close: () => Promise<void>;
  readonly routes: ArtifactRoutes;
  readonly url: string;
}

const routeError = (code: string, message: string, status: number): Error & {
  readonly code: string;
  readonly message: string;
  readonly status: number;
} => Object.assign(new Error(message), { code, message, status });

const authorize = (request: IncomingMessage): void => {
  if (request.headers['x-agent-bundle-session'] !== 'test-session-token') {
    throw routeError('AB8004', 'A valid same-session token is required.', 403);
  }
};

const startRoutes = async (service?: ArtifactRouteService): Promise<StartedRoutes> => {
  const routes = new ArtifactRoutes({ authorize, ...(service === undefined ? {} : { service }) });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const diagnostic = error as Partial<{ code: string; diagnostics: unknown; message: string; status: number }>;
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      response.writeHead(diagnostic.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        diagnostic: {
          code: diagnostic.code ?? 'AB8007',
          message: diagnostic.message ?? 'Request could not be completed.',
        },
        ...(diagnostic.diagnostics === undefined ? {} : { diagnostics: diagnostic.diagnostics }),
      }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => {
      routes.close();
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      }));
    },
    routes,
    url: `http://127.0.0.1:${address.port}`,
  });
};

const inspectionFixture = Object.freeze({
  epochId: 'epoch-a',
}) as unknown as ArtifactInspection;

const diffFixture = Object.freeze({
  baseEpochId: 'epoch-a',
  candidateEpochId: 'epoch-b',
}) as unknown as ArtifactEpochDiff;

class RecordingService implements ArtifactRouteService {
  readonly calls: unknown[] = [];
  failure: Error | undefined;

  async inspect(epochId: string): Promise<ArtifactInspection> {
    this.calls.push({ epochId, kind: 'inspect' });
    if (this.failure !== undefined) throw this.failure;
    return inspectionFixture;
  }

  async diff(baseEpochId: string, candidateEpochId: string): Promise<ArtifactEpochDiff> {
    this.calls.push({ baseEpochId, candidateEpochId, kind: 'diff' });
    if (this.failure !== undefined) throw this.failure;
    return diffFixture;
  }
}

const headers = (): Readonly<Record<string, string>> => ({ 'x-agent-bundle-session': 'test-session-token' });

it('inspects one epoch and diffs an aligned epoch pair', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const inspected = await fetch(`${started.url}/api/artifacts/epochs/epoch-a`, { headers: headers() });
    expect(inspected.status).toBe(200);
    await expect(inspected.json()).resolves.toEqual({ inspection: inspectionFixture });

    const diffed = await fetch(`${started.url}/api/artifacts/diff?base=epoch-a&candidate=epoch-b`, { headers: headers() });
    expect(diffed.status).toBe(200);
    await expect(diffed.json()).resolves.toEqual({ diff: diffFixture });

    expect(service.calls).toEqual([
      { epochId: 'epoch-a', kind: 'inspect' },
      { baseEpochId: 'epoch-a', candidateEpochId: 'epoch-b', kind: 'diff' },
    ]);
  } finally {
    await started.close();
  }
});

it('rejects diff queries that omit, duplicate, or smuggle a parameter', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const queries = [
      '',
      '?base=epoch-a',
      '?candidate=epoch-b',
      '?base=&candidate=epoch-b',
      '?base=epoch-a&base=epoch-c&candidate=epoch-b',
      '?base=epoch-a&candidate=epoch-b&artifact=/tmp/untrusted',
    ];
    for (const query of queries) {
      const rejected = await fetch(`${started.url}/api/artifacts/diff${query}`, { headers: headers() });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8062', message: 'Artifact request has an invalid shape.' },
      });
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('surfaces artifact validation diagnostics instead of one opaque failure', async () => {
  const service = new RecordingService();
  const diagnostics = Object.freeze([Object.freeze({
    code: 'AB4300',
    generatedPath: 'claude/hooks/guard.mjs',
    message: 'Emitted hook wrapper is not executable.',
    severity: 'error' as const,
  })]);
  service.failure = new ArtifactInspectionServiceError(
    'ARTIFACT_INSPECTION_INVALID',
    '/private/epochs/epoch-a failed validation',
    diagnostics,
  );
  const started = await startRoutes(service);

  try {
    const failed = await fetch(`${started.url}/api/artifacts/epochs/epoch-a`, { headers: headers() });
    expect(failed.status).toBe(422);
    const body = await failed.json() as {
      readonly diagnostic: { readonly code: string; readonly message: string };
      readonly diagnostics: readonly unknown[];
    };
    expect(body.diagnostic).toEqual({ code: 'AB8064', message: 'Artifact epoch failed validation.' });
    expect(body.diagnostics).toEqual(diagnostics);
    expect(JSON.stringify(body.diagnostic)).not.toContain('/private/epochs');
  } finally {
    await started.close();
  }
});

it('maps runtime, release, and missing-epoch failures to distinct diagnostics', async () => {
  const cases = [
    {
      diagnostic: 'AB8065',
      error: new ArtifactInspectionServiceError('ARTIFACT_INSPECTION_RUNTIME_INVALID', '/private/path runtime', []),
      status: 422,
    },
    {
      diagnostic: 'AB8066',
      error: new ArtifactInspectionServiceError('ARTIFACT_INSPECTION_RELEASE_FAILED', '/private/path release', []),
      status: 500,
    },
    {
      diagnostic: 'AB8067',
      error: new EpochStoreError('EPOCH_NOT_FOUND', 'Epoch "epoch-a" does not exist.'),
      status: 404,
    },
    {
      diagnostic: 'AB8068',
      error: new EpochStoreError('EPOCH_ID_INVALID', 'Epoch id is not valid.'),
      status: 400,
    },
    {
      diagnostic: 'AB8063',
      error: new Error('/private/epochs/epoch-a exploded'),
      status: 502,
    },
  ] as const;

  for (const entry of cases) {
    const service = new RecordingService();
    service.failure = entry.error;
    const started = await startRoutes(service);
    try {
      const failed = await fetch(`${started.url}/api/artifacts/epochs/epoch-a`, { headers: headers() });
      expect(failed.status).toBe(entry.status);
      const body = await failed.json() as { readonly diagnostic: { readonly code: string; readonly message: string } };
      expect(body.diagnostic.code).toBe(entry.diagnostic);
      expect(body.diagnostic.message).not.toContain('/private');
    } finally {
      await started.close();
    }
  }
});

it('rejects unsupported artifact methods, paths, and unauthenticated readers', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const method = await fetch(`${started.url}/api/artifacts/epochs/epoch-a`, { headers: headers(), method: 'POST' });
    expect(method.status).toBe(405);

    const unknownPath = await fetch(`${started.url}/api/artifacts/epochs/epoch-a/files`, { headers: headers() });
    expect(unknownPath.status).toBe(400);
    await expect(unknownPath.json()).resolves.toEqual({
      diagnostic: { code: 'AB8060', message: 'Artifact route path is not valid.' },
    });

    const traversal = await fetch(`${started.url}/api/artifacts/epochs/..%2Fescape`, { headers: headers() });
    expect(traversal.status).toBe(400);

    const unauthorized = await fetch(`${started.url}/api/artifacts/epochs/epoch-a`);
    expect(unauthorized.status).toBe(403);

    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('reports an absent service and a closed route group', async () => {
  const absent = await startRoutes();
  try {
    const unavailable = await fetch(`${absent.url}/api/artifacts/epochs/epoch-a`, { headers: headers() });
    expect(unavailable.status).toBe(404);
    await expect(unavailable.json()).resolves.toEqual({
      diagnostic: { code: 'AB8061', message: 'Artifact routes are not available.' },
    });
  } finally {
    await absent.close();
  }

  const started = await startRoutes(new RecordingService());
  try {
    started.routes.close();
    const closed = await fetch(`${started.url}/api/artifacts/epochs/epoch-a`, { headers: headers() });
    expect(closed.status).toBe(503);
    await expect(closed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8061', message: 'Artifact routes are not available.' },
    });
  } finally {
    await started.close();
  }
});
