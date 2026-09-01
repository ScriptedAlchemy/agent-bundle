import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import {
  Hook,
  Mcp,
  createRscRequestContext,
  lowerHookResult,
  lowerMcpResult,
} from '../src/index.js';

describe('@agent-bundle/runtime', () => {
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

  it('follows SDK wire semantics for undefined inside structured content and _meta', () => {
    // Repro from issue #44: handlers written against SDK serialization leave
    // optional fields undefined; JSON.stringify drops them from objects and
    // lowers them to null inside arrays.
    const structuredContent = {
      count: 3,
      items: [1, undefined, 'x', { keep: true, nested: undefined }],
      note: undefined,
      report: { deep: { drop: undefined }, keep: 'y' },
    };
    const result = lowerMcpResult(createElement(
      Mcp.Result,
      {
        _meta: { note: undefined, ui: { resourceUri: 'ui://demo/widget.html', subtitle: undefined } },
        structuredContent,
      },
      createElement(Mcp.Text, null, 'ok'),
    ));

    expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(structuredContent)));
    expect(JSON.stringify(result.structuredContent)).toBe(
      '{"count":3,"items":[1,null,"x",{"keep":true}],"report":{"deep":{},"keep":"y"}}',
    );
    expect(Object.hasOwn(result.structuredContent!, 'note')).toBe(false);
    expect(result._meta).toEqual({ ui: { resourceUri: 'ui://demo/widget.html' } });
    expect(Object.hasOwn(result._meta!, 'note')).toBe(false);
  });

  it('keeps an all-undefined structured content object as an empty record', () => {
    const result = lowerMcpResult(createElement(
      Mcp.Result,
      { structuredContent: { note: undefined } },
      createElement(Mcp.Text, null, 'ok'),
    ));
    expect(JSON.stringify(result.structuredContent)).toBe('{}');
  });

  it('still rejects non-wire JSON shapes and points at the offending key path', () => {
    const lower = (structuredContent: unknown) => () => lowerMcpResult(
      createElement(Mcp.Result, { structuredContent }, createElement(Mcp.Text, null, 'ok')),
    );

    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = { inner: cyclic };
    expect(lower(cyclic)).toThrow(
      'mcp-result structuredContent must be JSON-serializable (cyclic value at self.inner)',
    );
    expect(lower({ report: { get bad() { return 1; } } })).toThrow(
      'mcp-result structuredContent must be JSON-serializable (non-enumerable or accessor property at report.bad)',
    );
    expect(lower({ items: Object.assign([], { 0: 1, 2: 2, length: 3 }) })).toThrow(
      'mcp-result structuredContent must be JSON-serializable (sparse or decorated array at items)',
    );
    expect(lower({ callback: () => undefined })).toThrow(
      'mcp-result structuredContent must be JSON-serializable (non-JSON value at callback)',
    );
    expect(lower({ ratio: Number.POSITIVE_INFINITY })).toThrow(
      'mcp-result structuredContent must be JSON-serializable (non-finite number at ratio)',
    );
    expect(lower({ wrapped: new Map() })).toThrow(
      'mcp-result structuredContent must be JSON-serializable (non-plain object at wrapped)',
    );
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
