import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import {
  Hook,
  Mcp,
  createRscRequestContext,
  lowerHookResult,
  lowerMcpResult,
} from '../src/index.js';

describe('@agent-bundle/rsc-runtime', () => {
  it('lowers one Hook result', () => {
    expect(lowerHookResult(
      createElement(Hook.Result, null, createElement(Hook.AdditionalContext, null, 'ready')),
    )).toEqual({
      hookSpecificOutput: {
        additionalContext: 'ready',
        hookEventName: 'PostToolUse',
      },
    });
  });

  it('lowers one MCP result without sharing mutable structured content', () => {
    const structuredContent = { status: 'ready' };
    const result = lowerMcpResult(
      createElement(Mcp.Result, { structuredContent }, createElement(Mcp.Text, null, 'ready')),
    );

    structuredContent.status = 'changed';
    expect(result).toEqual({
      content: [{ text: 'ready', type: 'text' }],
      structuredContent: { status: 'ready' },
    });
  });

  it('resolves synchronous server components around MCP protocol elements', () => {
    const Status = ({ value }: { readonly value: string }) => createElement(
      Mcp.Result,
      { structuredContent: { value } },
      createElement(Mcp.Text, null, value),
    );

    expect(lowerMcpResult(createElement(Status, { value: 'ready' }))).toEqual({
      content: [{ text: 'ready', type: 'text' }],
      structuredContent: { value: 'ready' },
    });
  });

  it('isolates request context across concurrent work', async () => {
    const context = createRscRequestContext<string>('test request');
    const barrier = Promise.withResolvers<void>();

    const first = context.run('a', async () => {
      await barrier.promise;
      return context.use();
    });
    const second = context.run('b', async () => {
      barrier.resolve();
      return context.use();
    });

    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
  });

  it('rejects request context access outside a request', () => {
    const context = createRscRequestContext<string>('test request');
    expect(() => context.use()).toThrow('test request used outside a render request');
  });
});
