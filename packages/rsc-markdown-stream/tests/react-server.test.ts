// The react-server condition selects a react build whose namespace exports
// __SERVER_INTERNALS_* and no client internals; static namespace access to
// the client export is an ESM linking error under strict bundlers. Rendering
// (including the hooks dispatcher behind React.use) must work there, because
// RSC server module graphs compile this renderer with that condition. The
// child process makes the condition apply from module resolution onward.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, it } from '@rstest/core';

const script = `
import { createElement as e, use } from 'react';
import { renderToMarkdown } from './src/index.js';

const Row = async ({ label, bytes }) =>
  e('tr', null, e('td', null, label), e('td', null, String(bytes)));

// A stable thenable, as use() requires: settlement is tracked on the
// instance, so a promise created fresh per render would suspend forever.
const status = Promise.resolve('verified');
const Status = () => use(status);

const tree = e('div', null,
  e('h2', null, 'Audit'),
  e('table', null,
    e('thead', null, e('tr', null, e('th', null, 'File'), e('th', null, 'Bytes'))),
    e('tbody', null,
      e(Row, { bytes: 12, key: 'a', label: 'a.m4b' }),
      e(Row, { bytes: 34, key: 'b', label: 'b.m4b' }))),
  e('p', null, 'Status: ', e(Status, null)));

process.stdout.write(await renderToMarkdown(tree));
`;

it('renders tables, async components, and use() under the react-server condition', () => {
  const stdout = execFileSync(
    process.execPath,
    ['--conditions', 'react-server', '--input-type=module', '--eval', script],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  expect(stdout).toBe(`${[
    '## Audit',
    '',
    '| File | Bytes |',
    '| --- | --- |',
    '| a.m4b | 12 |',
    '| b.m4b | 34 |',
    '',
    'Status: verified',
  ].join('\n')}\n`);
});
