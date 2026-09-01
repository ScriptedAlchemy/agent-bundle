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

    expect(sent).toEqual([{ message: 'working', progress: 1, progressToken: 'tok' }]);
    expect(JSON.stringify(sent)).not.toContain('Partial shell');
    expect(JSON.stringify(sent)).not.toContain('partial');
    expect(projected.result).toEqual({
      content: [{ text: '# Final', type: 'text' }],
      structuredContent: { ok: true },
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
