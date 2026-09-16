import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/release-outcome-summary.sh');
const candidateSha = 'b435f7b9179271cbff81d3e40d14ee342cbd65dd';

const summarize = async (extra: NodeJS.ProcessEnv) => {
  const { stdout } = await execFile('bash', [scriptPath], {
    env: { PATH: process.env['PATH'], CANDIDATE_SHA: candidateSha, ...extra },
  });
  return stdout;
};

it('reports version maintenance separately from a versioned release', async () => {
  expect(await summarize({
    HAS_CHANGESETS: 'true',
    QUALIFY_OUTCOME: 'skipped',
    CHANGESETS_OUTCOME: 'success',
    PREVIEW_OUTCOME: 'success',
    JOB_STATUS: 'success',
  })).toContain([
    'outcome: version-maintenance-only',
    `workflow_sha: ${candidateSha}`,
    'candidate_sha: (not qualified)',
    'distribution: no versioned release',
    '',
    'stages:',
    '- version-maintenance: executed',
    '- qualification: skipped',
    '- pkg.pr.new-preview: resolved',
  ].join('\n'));
});

it('reports a qualified Version Packages commit only after its previews resolve', async () => {
  const evidenceFile = join(await mkdtemp(join(tmpdir(), 'release-outcome-')), 'evidence.json');
  await writeFile(evidenceFile, `${JSON.stringify({
    executedBins: ['agent-bundle'],
    interPackageRanges: [{
      field: 'dependencies',
      name: 'rsc-markdown-stream',
      package: '@agent-bundle/runtime',
      specifier: '^0.1.0',
    }],
    packages: [{
      digest: 'deadbeef',
      name: 'agent-bundle',
      tarball: 'agent-bundle-0.1.0.tgz',
      version: '0.1.0',
    }],
    testGroups: ['packed', 'packed-release'],
    workspaceRefs: [],
  })}\n`);
  const stdout = await summarize({
    HAS_CHANGESETS: 'false',
    QUALIFY_OUTCOME: 'success',
    CHANGESETS_OUTCOME: 'success',
    PREVIEW_OUTCOME: 'success',
    JOB_STATUS: 'success',
    EVIDENCE_FILE: evidenceFile,
  });
  expect(stdout).toContain([
    'outcome: preview-release',
    `workflow_sha: ${candidateSha}`,
    `candidate_sha: ${candidateSha}`,
    'distribution: pkg.pr.new previews resolved',
    '',
    'stages:',
    '- version-maintenance: skipped',
    '- qualification: executed',
    '- pkg.pr.new-preview: resolved',
  ].join('\n'));
  expect(stdout).toContain('- agent-bundle@0.1.0 agent-bundle-0.1.0.tgz sha256:deadbeef');
  expect(stdout).toContain('- @agent-bundle/runtime dependencies rsc-markdown-stream: ^0.1.0');
  expect(stdout).toContain('workspace-only refs:\n- none');
  expect(stdout).toContain('- packed-release: executed');
});

it('reports failed qualification as failed', async () => {
  expect(await summarize({
    HAS_CHANGESETS: 'false',
    QUALIFY_OUTCOME: 'failure',
    CHANGESETS_OUTCOME: 'success',
    PREVIEW_OUTCOME: 'success',
    JOB_STATUS: 'failure',
  })).toContain('outcome: failed\n');
});

it('never reports a release without preview proof', async () => {
  expect(await summarize({
    HAS_CHANGESETS: 'false',
    QUALIFY_OUTCOME: 'success',
    CHANGESETS_OUTCOME: 'success',
    PREVIEW_OUTCOME: 'skipped',
    JOB_STATUS: 'success',
  })).toContain([
    'outcome: failed',
    `workflow_sha: ${candidateSha}`,
    `candidate_sha: ${candidateSha}`,
    'distribution: no versioned release',
    '',
    'stages:',
    '- version-maintenance: skipped',
    '- qualification: executed',
    '- pkg.pr.new-preview: skipped',
  ].join('\n'));
});
