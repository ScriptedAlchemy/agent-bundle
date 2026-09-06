import { execFile as executeFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/release-outcome-summary.sh');

it('reports version-maintenance-only as NOT PUBLISHED with skipped qualification stages', async () => {
  const { stdout } = await execFile('bash', [scriptPath], {
    env: {
      PATH: process.env['PATH'],
      PUBLISH_ENABLED: 'false',
      HAS_CHANGESETS: 'true',
      PUBLISHED: 'false',
      QUALIFY_OUTCOME: 'skipped',
      CHANGESETS_OUTCOME: 'success',
      REGISTRY_OUTCOME: 'skipped',
      JOB_STATUS: 'success',
      CANDIDATE_SHA: 'b435f7b9179271cbff81d3e40d14ee342cbd65dd',
    },
  });
  expect(stdout).toContain([
    'outcome: version-maintenance-only',
    'workflow_sha: b435f7b9179271cbff81d3e40d14ee342cbd65dd',
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
