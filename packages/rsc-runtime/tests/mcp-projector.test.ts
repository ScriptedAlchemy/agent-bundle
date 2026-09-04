import { describe, expect, it } from '@rstest/core';

import {
  AgentContractError,
  createAgentDocument,
  McpProjectionError,
  projectMcpRenderStream,
  type AgentDocument,
  type AgentRenderEvent,
  type McpProgressNotificationParams,
} from '../src/index.js';

const document = (overrides: Partial<AgentDocument> = {}): AgentDocument =>
  createAgentDocument({
    root: {
      children: [{ kind: 'text', text: 'Ready.' }],
      kind: 'result',
    },
    status: 'success',
    value: { ok: true },
    version: 1,
    ...overrides,
  });

const eventsOf = (events: readonly AgentRenderEvent[]): ReadableStream<AgentRenderEvent> =>
  new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });

describe('projectMcpRenderStream', () => {
  it('emits notifications/progress only when the caller supplied a progress token', async () => {
    const sent: McpProgressNotificationParams[] = [];
    const complete = document();
    const withoutToken = await projectMcpRenderStream(eventsOf([
      { completed: 1, message: 'halfway', sequence: 0, total: 2, type: 'progress' },
      { document: complete, sequence: 1, type: 'complete' },
    ]), {
      sendProgress: async (params) => {
        sent.push(params);
      },
    });

    expect(sent).toEqual([]);
    expect(withoutToken.result).toEqual({
      content: [{ text: 'Ready.', type: 'text' }],
      structuredContent: { ok: true },
    });

    const withToken = await projectMcpRenderStream(eventsOf([
      { completed: 1, message: 'halfway', sequence: 0, total: 2, type: 'progress' },
      { completed: 2, message: 'done', sequence: 1, total: 2, type: 'progress' },
      { document: complete, sequence: 2, type: 'complete' },
    ]), {
      progressToken: 'tok-1',
      sendProgress: async (params) => {
        sent.push(params);
      },
    });

    expect(sent).toEqual([
      { message: 'halfway', progress: 1, progressToken: 'tok-1', total: 2 },
      { message: 'done', progress: 2, progressToken: 'tok-1', total: 2 },
    ]);
    expect(withToken.result.content).toEqual([{ text: 'Ready.', type: 'text' }]);
    expect(withToken.document).toEqual(complete);
  });

  it('maps only monotonically increasing numeric progress and shortens the message', async () => {
    const sent: McpProgressNotificationParams[] = [];
    const long = `inspecting ${'x'.repeat(240)}`;
    await projectMcpRenderStream(eventsOf([
      { completed: 2, message: 'second', sequence: 0, type: 'progress' },
      { completed: 2, message: 'repeat', sequence: 1, type: 'progress' },
      { completed: 1, message: 'rewind', sequence: 2, type: 'progress' },
      { completed: 4, message: long, sequence: 3, total: 10, type: 'progress' },
      { document: document(), sequence: 4, type: 'complete' },
    ]), {
      progressToken: 7,
      sendProgress: async (params) => {
        sent.push(params);
      },
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ message: 'second', progress: 2, progressToken: 7 });
    expect(sent[1]?.progress).toBe(4);
    expect(sent[1]?.total).toBe(10);
    expect(sent[1]?.message?.length).toBeLessThanOrEqual(200);
    expect(sent[1]?.message?.startsWith('inspecting ')).toBe(true);
    expect(sent[1]?.message?.includes('Ready.')).toBe(false);
  });

  it('buffers shell and replace internally and never encodes partial content in progress', async () => {
    const sent: McpProgressNotificationParams[] = [];
    const shell = document({
      root: {
        children: [
          { kind: 'markdown', text: '# Partial shell' },
          { completed: 0, kind: 'progress', message: 'loading' },
        ],
        kind: 'result',
      },
      value: { partial: true },
    });
    const final = document({
      root: {
        children: [{ kind: 'markdown', text: '# Final' }],
        kind: 'result',
      },
      value: { ok: true },
    });

    const projected = await projectMcpRenderStream(eventsOf([
      { document: shell, sequence: 0, type: 'shell' },
      { boundaryId: 'b:1', document: shell, sequence: 1, type: 'replace' },
      { completed: 1, message: 'working', sequence: 2, type: 'progress' },
      { document: final, sequence: 3, type: 'complete' },
    ]), {
      progressToken: 'tok',
      sendProgress: async (params) => {
        sent.push(params);
      },
    });

    // The shell's Agent.Progress node is the streaming progress surface (#448)
    // and is notified once; the markdown beside it never leaves the buffer.
    expect(sent).toEqual([
      { message: 'loading', progress: 0, progressToken: 'tok' },
      { message: 'working', progress: 1, progressToken: 'tok' },
    ]);
    expect(JSON.stringify(sent)).not.toContain('Partial shell');
    expect(JSON.stringify(sent)).not.toContain('partial');
    expect(projected.result).toEqual({
      content: [{ text: '# Final', type: 'text' }],
      structuredContent: { ok: true },
    });
  });

  describe('Agent.Progress rendered as a streamed Suspense fallback (#448)', () => {
    const fallback = (message: string, completed = 0): AgentDocument => document({
      root: {
        children: [
          { kind: 'text', text: 'catalog: mystery' },
          { completed, kind: 'progress', message, total: 2 },
        ],
        kind: 'result',
      },
      value: { partial: true },
    });
    const final = document({
      root: {
        children: [{ kind: 'text', text: 'catalog: mystery' }, { kind: 'markdown', text: '- Piranesi' }],
        kind: 'result',
      },
    });
    const collect = () => {
      const sent: McpProgressNotificationParams[] = [];
      return {
        options: {
          progressToken: 'tok-448',
          sendProgress: async (params: McpProgressNotificationParams) => {
            sent.push(params);
          },
        },
        sent,
      };
    };

    it('projects the fallback node to one notifications/progress with the node message, progress, and total', async () => {
      const { options, sent } = collect();
      const projected = await projectMcpRenderStream(eventsOf([
        { document: fallback('loading mystery'), sequence: 0, type: 'shell' },
        { document: final, sequence: 1, type: 'complete' },
      ]), options);

      expect(sent).toEqual([
        { message: 'loading mystery', progress: 0, progressToken: 'tok-448', total: 2 },
      ]);
      expect(projected.result.content).toEqual([
        { text: 'catalog: mystery', type: 'text' },
        { text: '- Piranesi', type: 'text' },
      ]);
    });

    it('does not re-send the same fallback when a later replace still streams it', async () => {
      const { options, sent } = collect();
      await projectMcpRenderStream(eventsOf([
        { document: fallback('loading mystery'), sequence: 0, type: 'shell' },
        { boundaryId: 'b:1', document: fallback('loading mystery'), sequence: 1, type: 'replace' },
        { boundaryId: 'b:2', document: fallback('still loading'), sequence: 2, type: 'replace' },
        { boundaryId: 'b:3', document: fallback('nearly there', 1), sequence: 3, type: 'replace' },
        { document: final, sequence: 4, type: 'complete' },
      ]), options);

      // Same monotonic rule as progress events: a fallback whose `completed`
      // does not exceed the last notified value is not repeated, and a later
      // fallback that advances it is.
      expect(sent).toEqual([
        { message: 'loading mystery', progress: 0, progressToken: 'tok-448', total: 2 },
        { message: 'nearly there', progress: 1, progressToken: 'tok-448', total: 2 },
      ]);
    });

    it('emits nothing for a fallback when the request carried no progress token', async () => {
      const sent: McpProgressNotificationParams[] = [];
      await projectMcpRenderStream(eventsOf([
        { document: fallback('loading mystery'), sequence: 0, type: 'shell' },
        { document: final, sequence: 1, type: 'complete' },
      ]), {
        sendProgress: async (params) => {
          sent.push(params);
        },
      });
      expect(sent).toEqual([]);
    });

    it('does not duplicate a fallback that an explicit progress report also announces', async () => {
      const { options, sent } = collect();
      await projectMcpRenderStream(eventsOf([
        { document: fallback('loading mystery'), sequence: 0, type: 'shell' },
        { completed: 0, message: 'loading mystery', sequence: 1, total: 2, type: 'progress' },
        { completed: 1, message: 'one title', sequence: 2, total: 2, type: 'progress' },
        { document: final, sequence: 3, type: 'complete' },
      ]), options);

      expect(sent).toEqual([
        { message: 'loading mystery', progress: 0, progressToken: 'tok-448', total: 2 },
        { message: 'one title', progress: 1, progressToken: 'tok-448', total: 2 },
      ]);
    });

    it('treats a progress node in the complete document as content only', async () => {
      const { options, sent } = collect();
      await projectMcpRenderStream(eventsOf([{
        document: document({
          root: {
            children: [{ completed: 3, kind: 'progress', message: 'status-only' }],
            kind: 'result',
          },
        }),
        sequence: 0,
        type: 'complete',
      }]), options);
      expect(sent).toEqual([]);
    });
  });

  it('returns one CallToolResult with supported blocks and object-valued structured content', async () => {
    const projected = await projectMcpRenderStream(eventsOf([{
      document: document({
        root: {
          children: [
            { kind: 'markdown', text: '# Catalog' },
            { kind: 'context', text: 'route guidance' },
            { kind: 'json', value: { count: 1 } },
            { completed: 1, kind: 'progress', message: 'status-only' },
            { data: 'aW1hZ2U=', kind: 'image', mimeType: 'image/png' },
            { data: 'YXVkaW8=', kind: 'audio', mimeType: 'audio/wav' },
            { kind: 'resource', mimeType: 'application/json', name: 'Catalog', uri: 'catalog://root' },
            { code: 'E_NOTE', kind: 'error', message: 'represented' },
          ],
          kind: 'result',
        },
        status: 'represented-error',
        value: { count: 1 },
      }),
      sequence: 0,
      type: 'complete',
    }]));

    expect(projected.result).toEqual({
      content: [
        { text: '# Catalog', type: 'text' },
        { text: 'route guidance', type: 'text' },
        { text: '{"count":1}', type: 'text' },
        { data: 'aW1hZ2U=', mimeType: 'image/png', type: 'image' },
        { data: 'YXVkaW8=', mimeType: 'audio/wav', type: 'audio' },
        { mimeType: 'application/json', name: 'Catalog', type: 'resource_link', uri: 'catalog://root' },
        { text: '[E_NOTE] represented', type: 'text' },
      ],
      isError: true,
      structuredContent: { count: 1 },
    });
  });

  it('fails closed or uses a declared text fallback for gated rich content', async () => {
    const rich = document({
      root: {
        children: [{ data: 'aW1hZ2U=', kind: 'image', mimeType: 'image/png' }],
        kind: 'result',
      },
    });

    await expect(projectMcpRenderStream(eventsOf([
      { document: rich, sequence: 0, type: 'complete' },
    ]), { capabilities: { image: false } })).rejects.toBeInstanceOf(McpProjectionError);
    await expect(projectMcpRenderStream(eventsOf([
      { document: rich, sequence: 0, type: 'complete' },
    ]), { capabilities: { image: false } })).rejects.toMatchObject({
      code: 'unsupported-rich-content',
      kind: 'image',
    });

    await expect(projectMcpRenderStream(eventsOf([
      { document: rich, sequence: 0, type: 'complete' },
    ]), { capabilities: { image: false }, richContentFallback: 'text' })).resolves.toMatchObject({
      result: { content: [{ text: '[image image/png]', type: 'text' }] },
    });
  });

  it('projects result metadata to _meta and fails closed on a non-object', async () => {
    const withMetadata = await projectMcpRenderStream(eventsOf([{
      document: document({
        root: {
          children: [{ kind: 'text', text: 'Ready.' }],
          kind: 'result',
          metadata: { ui: { resourceUri: 'ui://demo/panel.html' }, 'vendor/trace': ['a', 1, null] },
        },
      }),
      sequence: 0,
      type: 'complete',
    }]));
    expect(withMetadata.result).toEqual({
      _meta: { ui: { resourceUri: 'ui://demo/panel.html' }, 'vendor/trace': ['a', 1, null] },
      content: [{ text: 'Ready.', type: 'text' }],
      structuredContent: { ok: true },
    });
    expect(Object.isFrozen(withMetadata.result._meta)).toBe(true);

    const scalar = projectMcpRenderStream(eventsOf([{
      document: document({
        root: { children: [], kind: 'result', metadata: 'not an object' },
      }),
      sequence: 0,
      type: 'complete',
    }]));
    await expect(scalar).rejects.toBeInstanceOf(McpProjectionError);
    await expect(projectMcpRenderStream(eventsOf([{
      document: document({
        root: { children: [], kind: 'result', metadata: ['not', 'an', 'object'] },
      }),
      sequence: 0,
      type: 'complete',
    }]))).rejects.toMatchObject({ code: 'invalid-result-metadata' });
  });

  it('omits non-object structured content instead of fabricating an object', async () => {
    const projected = await projectMcpRenderStream(eventsOf([{
      document: document({ value: ['not', 'an', 'object'] }),
      sequence: 0,
      type: 'complete',
    }]));
    expect(projected.result.structuredContent).toBeUndefined();
    expect(projected.result.content).toEqual([{ text: 'Ready.', type: 'text' }]);
  });

  it('fails when the stream ends without a complete document', async () => {
    await expect(projectMcpRenderStream(eventsOf([
      { document: document(), sequence: 0, type: 'shell' },
    ]))).rejects.toBeInstanceOf(AgentContractError);
    await expect(projectMcpRenderStream(eventsOf([
      { document: document(), sequence: 0, type: 'shell' },
    ]))).rejects.toMatchObject({ code: 'invalid-document' });
  });

  it('maps an abort into the renderer AbortSignal', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<AgentRenderEvent>({
      start() {
        controller.abort();
      },
    });
    await expect(projectMcpRenderStream(stream, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
