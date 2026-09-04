import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';

import { createAgentRenderDispatcher, type AgentFlightExecutionHost } from '../src/index.js';

/**
 * `MarkdownContent` is an async server component that runs the Markdown
 * renderer inside React's Flight request. This spawns the BUILT package
 * (dist/, prebuilt by the integration pool's root build) under the
 * react-server condition — the module graph agent-bundle routes execute in —
 * and decodes the wire bytes back into an Agent Document, proving the JSX
 * tree lowers to one `markdown` node with the expected text end to end.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(packageRoot, 'tests', 'fixtures', 'markdown-content-flight.mjs');

const flightHost: AgentFlightExecutionHost = {
  async execute(request) {
    const child = spawn(process.execPath, ['--conditions=react-server', fixture], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`markdown-content-flight fixture exited ${code}\n${Buffer.concat(stderr).toString('utf8')}`);
      }
    });
    request.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  },
};

describe('MarkdownContent through a react-server Flight render', () => {
  it('lowers a JSX Markdown tree with async components to one markdown node', async () => {
    const dispatcher = createAgentRenderDispatcher(flightHost);
    const document = await dispatcher.dispatch({
      invocation: { kind: 'tool', props: { input: {}, operationId: 'audit' } },
      signal: new AbortController().signal,
    });

    expect(document.status).toBe('success');
    expect(document.root).toMatchObject({
      children: [
        { kind: 'markdown', text: '# Audit' },
        {
          kind: 'markdown',
          text: [
            'Measured **2 files** with \\*literal stars\\*.',
            '',
            '| File | Bytes |',
            '| --- | ---: |',
            '| a.m4b | 12 |',
            '| b.m4b | 34 |',
            '',
            '- [x] verified',
          ].join('\n'),
        },
      ],
      kind: 'result',
    });
  });
});
