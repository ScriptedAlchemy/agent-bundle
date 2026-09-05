import { expect, it } from '@rstest/core';

import {
  ArtifactRoutes,
  type ArtifactRouteService,
} from '../src/dev/artifacts/artifact-routes.ts';
import { ArtifactInspectionServiceError } from '../src/dev/artifacts/artifact-inspection-service.ts';
import { EpochStoreError } from '../src/dev/epoch-store.ts';
import type { ArtifactEpochDiff, ArtifactInspection } from '../src/dev/types.ts';
import {
  authorizeSession as authorize,
  sessionHeaders as headers,
  startRoutes as startRouteServer,
  type StartedRoutes,
} from './support/route-harness.ts';
import { deepFreeze } from '../src/core/freeze.ts';


const startRoutes = async (service?: ArtifactRouteService): Promise<StartedRoutes<ArtifactRoutes>> =>
  startRouteServer(new ArtifactRoutes({ authorize, ...(service === undefined ? {} : { service }) }));

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
  const diagnostics = deepFreeze([{
    code: 'AB4300',
    generatedPath: 'hooks/guard.mjs',
    message: 'Emitted hook wrapper is not executable.',
    severity: 'error' as const,
  }]);
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
