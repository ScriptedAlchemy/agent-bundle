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

it('reports version-maintenance-only as NOT PUBLISHED with skipped qualification stages', async () => {
  expect(await summarize({
    PUBLISH_ENABLED: 'false',
    HAS_CHANGESETS: 'true',
    PUBLISHED: 'false',
    QUALIFY_OUTCOME: 'skipped',
    CHANGESETS_OUTCOME: 'success',
    REGISTRY_OUTCOME: 'skipped',
    JOB_STATUS: 'success',
  })).toContain([
    'outcome: version-maintenance-only',
    `workflow_sha: ${candidateSha}`,
    'candidate_sha: (not qualified)',
    'publication: NOT PUBLISHED',
    '',
    'stages:',
    '- version-maintenance: executed',
    '- qualification: skipped',
    '- publication: skipped',
    '- registry-verification: skipped',
  ].join('\n'));
});

it('reports qualified-without-publish with pack evidence and pending follow-ups', async () => {
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
    PUBLISH_ENABLED: 'false',
    HAS_CHANGESETS: 'false',
    PUBLISHED: 'false',
    QUALIFY_OUTCOME: 'success',
    CHANGESETS_OUTCOME: 'success',
    REGISTRY_OUTCOME: 'skipped',
    JOB_STATUS: 'success',
    EVIDENCE_FILE: evidenceFile,
  });
  expect(stdout).toContain([
    'outcome: qualified-without-publish',
    `workflow_sha: ${candidateSha}`,
    `candidate_sha: ${candidateSha}`,
    'publication: NOT PUBLISHED',
    '',
    'stages:',
    '- version-maintenance: skipped',
    '- qualification: executed',
    '- publication: skipped',
    '- registry-verification: skipped',
  ].join('\n'));
  expect(stdout).toContain('- agent-bundle@0.1.0 agent-bundle-0.1.0.tgz sha256:deadbeef');
  expect(stdout).toContain('- @agent-bundle/runtime dependencies rsc-markdown-stream: ^0.1.0');
  expect(stdout).toContain('workspace-only refs:\n- none');
  expect(stdout).toContain('- packed-release: executed');
  expect(stdout).toContain('- #688 schema-label provenance: pending');
});

it('reports cancelled qualification as failed', async () => {
  expect(await summarize({
    PUBLISH_ENABLED: 'false',
    HAS_CHANGESETS: 'false',
    PUBLISHED: 'false',
    QUALIFY_OUTCOME: 'cancelled',
    CHANGESETS_OUTCOME: 'success',
    REGISTRY_OUTCOME: 'skipped',
    JOB_STATUS: 'cancelled',
  })).toContain('outcome: failed\n');
});

it('reports published only when publish is enabled and registry succeeded', async () => {
  expect(await summarize({
    PUBLISH_ENABLED: 'true',
    HAS_CHANGESETS: 'false',
    PUBLISHED: 'true',
    QUALIFY_OUTCOME: 'skipped',
    CHANGESETS_OUTCOME: 'success',
    REGISTRY_OUTCOME: 'success',
    JOB_STATUS: 'success',
  })).toContain([
    'outcome: published',
    `workflow_sha: ${candidateSha}`,
    `candidate_sha: ${candidateSha}`,
    'publication: published',
    '',
    'stages:',
    '- version-maintenance: skipped',
    '- qualification: executed',
    '- publication: executed',
    '- registry-verification: executed',
  ].join('\n'));
});
