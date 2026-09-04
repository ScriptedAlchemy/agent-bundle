// Renders MarkdownContent inside a real Flight request under the
// react-server condition (spawned with --conditions=react-server) and writes
// the RSC wire bytes to stdout. Imports the BUILT package from dist/ so the
// proof covers the published module graph, not the TypeScript sources.
globalThis.__rspack_rsc_manifest__ = Object.freeze({
  clientManifest: Object.freeze({}),
  moduleLoading: null,
  serverConsumerModuleMap: null,
  serverManifest: Object.freeze({}),
});

import { Readable } from 'node:stream';

import { createElement as e, Fragment } from 'react';
import { renderToReadableStream } from 'react-server-dom-rspack/server.node';

import { MarkdownContent } from '../../dist/index.js';

/** An async server component inside the Markdown tree, resolved by the renderer. */
const Row = async ({ bytes, label }) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return e('tr', null, e('td', null, label), e('td', null, String(bytes)));
};

const model = e(
  'agent-result',
  null,
  e('agent-markdown', null, '# Audit'),
  e(
    MarkdownContent,
    null,
    e(
      Fragment,
      null,
      e('p', null, 'Measured ', e('strong', null, '2 files'), ' with *literal stars*.'),
      e(
        'table',
        null,
        e('thead', null, e('tr', null, e('th', null, 'File'), e('th', { align: 'right' }, 'Bytes'))),
        e(
          'tbody',
          null,
          e(Row, { bytes: 12, key: 'a', label: 'a.m4b' }),
          e(Row, { bytes: 34, key: 'b', label: 'b.m4b' }),
        ),
      ),
      e('ul', null, e('li', null, e('input', { checked: true, readOnly: true, type: 'checkbox' }), ' verified')),
    ),
  ),
);

const flight = renderToReadableStream(model, {
  onError: (error) => (error instanceof Error ? error.message : 'error'),
});
const output = Readable.fromWeb(flight);
output.pipe(process.stdout);
output.on('end', () => {
  process.exit(0);
});
