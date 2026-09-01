import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import { Mcp, defineOperation, defineRscApplication, lowerMcpResult, runRscCli } from '../src/index.js';

/**
 * The `status` operation printed in this package's README, with a render
 * counter so the documented compatibility claim stays observable.
 *
 * Pin flip (#102 stage 3): the old pin read "CLI writes one JSON line,
 * `render` never invoked" for the whole CLI story. Routed `src/cli/**`
 * commands now DO render — `.tsx` routes render through the dispatcher with
 * TTY/Markdown/`--json`/`--ndjson` output modes (pinned by
 * `packages/agent-bundle/tests/cli-routes.test.ts` and
 * `cli-routes-build.test.ts`). What this file keeps pinning is the narrowed
 * claim the docs still make: the handwritten `runRscCli` compatibility path
 * serializes the validated result as one JSON line and never invokes
 * `render`; only the MCP projection consumes it.
 */
const documentedStatus = (onRender: () => void) => defineOperation({
  cli: {
    name: 'status',
    parse: (args) => (args.includes('--verbose') ? { verbose: true } : {}),
    summary: 'Read runtime status.',
    usage: 'status [--verbose]',
  },
  execute: async () => ({ status: 'ready' as const }),
  id: 'status',
  inputSchema: z.object({ verbose: z.boolean().optional() }).strict(),
  mcp: {
    description: 'Read runtime status.',
    name: 'runtime_status',
    readOnly: true,
    server: 'runtime',
  },
  render: (result) => {
    onRender();
    return createElement(
      Mcp.Result,
      { structuredContent: result },
      createElement(Mcp.Text, null, `Runtime is ${result.status}.`),
    );
  },
  resultSchema: z.object({ status: z.literal('ready') }).strict(),
});

describe('documented operation model (the runRscCli compatibility path)', () => {
  it('serves both projections from one shared core; only MCP consumes render on this path', async () => {
    let renders = 0;
    const status = documentedStatus(() => {
      renders += 1;
    });
    const application = defineRscApplication({
      name: 'runtime',
      operations: [status],
      version: '0.1.0',
    });
    const output: string[] = [];

    await expect(runRscCli(application, ['status'], { write: (value) => output.push(value) })).resolves.toBe(0);
    // The compatibility CLI projection prints one line of JSON and never
    // touches `render`; routed `.tsx` commands are the rendering CLI path.
    expect(output.join('')).toBe('{"status":"ready"}\n');
    expect(renders).toBe(0);

    const result = await status.execute({}, { signal: new AbortController().signal });
    expect(lowerMcpResult(status.render(result))).toEqual({
      content: [{ text: 'Runtime is ready.', type: 'text' }],
      structuredContent: { status: 'ready' },
    });
    expect(renders).toBe(1);
  });

  it('rejects the multi-child `Mcp.Text` the documented template literal avoids', () => {
    expect(() => lowerMcpResult(createElement(
      Mcp.Result,
      null,
      createElement(Mcp.Text, null, 'Runtime is ', 'ready', '.'),
    ))).toThrow('mcp-text requires one text child');
  });
});
