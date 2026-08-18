import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { EvalRunResult, EvalSuiteListing } from '../src/dev/eval-service.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import type { EvalRunRecord } from '../src/eval/run-store.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { seedEvalProject } from './support/eval-project.ts';

it('runs a real deterministic eval through the packaged foreground server', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-evals-'));
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    seedEvalProject(project.root),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected the workbench to publish an active artifact epoch.');
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { origin: server.url, 'x-agent-bundle-session': token };
    const completedRun = async (runId: string): Promise<EvalRunResult> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await fetch(`${server!.url}/api/evals/runs/${runId}`, { headers });
        if (response.status !== 200) throw new Error(`Expected recorded eval run ${JSON.stringify(runId)} to be readable.`);
        const { run } = await response.json() as { readonly run: EvalRunResult };
        if (run.run.completedAt !== undefined) return run;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      throw new Error(`Timed out waiting for recorded eval run ${JSON.stringify(runId)}.`);
    };

    const unauthorized = await fetch(`${server.url}/api/evals/suites`, { headers: { origin: server.url } });
    expect(unauthorized.status).toBe(403);

    const listed = await fetch(`${server.url}/api/evals/suites`, { headers });
    expect(listed.status).toBe(200);
    const listing = await listed.json() as EvalSuiteListing;
    expect(listing.diagnostics).toEqual([]);
    expect(listing.suites).toHaveLength(1);
    expect(listing.suites[0]).toMatchObject({ name: 'review-change', sourcePath: 'evals/review.eval.ts' });
    expect(listing.suites[0]?.cases.map((entry) => entry.id))
      .toEqual(['inconclusive-activation', 'reads-result', 'wrong-result']);

    const rejected = await fetch(`${server.url}/api/evals/runs`, {
      body: JSON.stringify({ artifact: join(project.root, 'prebuilt'), caseIds: ['reads-result'] }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8072' } });

    const started = await fetch(`${server.url}/api/evals/runs`, {
      body: JSON.stringify({ suites: ['review-change'] }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(started.status).toBe(202);
    const { run: admitted } = await started.json() as { readonly run: EvalRunRecord };
    expect(admitted.completedAt).toBeUndefined();
    const run = await completedRun(admitted.id);
    expect(run.run.harness).toBe('deterministic');
    expect(run.run.summary).toMatchObject({ cases: 3, fail: 1, inconclusive: 1, pass: 1, trials: 3 });
    expect(run.trials.map((trial) => `${trial.caseId}:${trial.outcome}`)).toEqual([
      'inconclusive-activation:inconclusive',
      'reads-result:pass',
      'wrong-result:fail',
    ]);
    const targetDigest = run.run.artifact.targetDigests.portable;
    expect(run.trials.every((trial) => trial.targetDigest === targetDigest)).toBe(true);
    expect(run.trials.every((trial) => trial.rawArtifacts.length > 0)).toBe(true);
    const inconclusive = run.trials.find((trial) => trial.outcome === 'inconclusive');
    expect(inconclusive?.assertions[0]).toMatchObject({ evidence: 'unavailable', outcome: 'inconclusive' });
    expect(inconclusive?.pluginFailure).toBeUndefined();

    const multiTrial = await fetch(`${server.url}/api/evals/runs`, {
      body: JSON.stringify({ caseIds: ['reads-result'], trials: 2 }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(multiTrial.status).toBe(202);
    const { run: secondAdmission } = await multiTrial.json() as { readonly run: EvalRunRecord };
    const second = await completedRun(secondAdmission.id);
    expect(second.trials.map((trial) => trial.id)).toEqual([
      'reads-result--portable-1',
      'reads-result--portable-2',
    ]);
    expect(second.aggregates[0]).toMatchObject({ caseId: 'reads-result', pass: 2, trials: 2 });

    const runs = await fetch(`${server.url}/api/evals/runs`, { headers });
    expect(runs.status).toBe(200);
    const recorded = await runs.json() as { readonly runs: readonly EvalRunRecord[] };
    expect(recorded.runs.map((entry) => entry.id).sort()).toEqual([run.run.id, second.run.id].sort());

    const reread = await fetch(`${server.url}/api/evals/runs/${run.run.id}`, { headers });
    expect(reread.status).toBe(200);
    await expect(reread.json()).resolves.toEqual({ run: { ...run, diagnostics: [] } });

    const missing = await fetch(`${server.url}/api/evals/runs/20260101t000000000z-abcdef01`, { headers });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8074' } });

    await expect(access(join(project.root, '.agent-bundle', 'runs', run.run.id, 'run.json'))).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(`${server.url}/api/evals/suites`, { headers })).rejects.toThrow();
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 180_000);
