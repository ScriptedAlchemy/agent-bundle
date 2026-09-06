import { describe, expect, it } from 'effect-rstest';

import {
  Agent,
  AgentContractError,
  createAgentDocument,
  createAgentRenderEventSequence,
  type AgentDocumentNode,
  type AgentRenderInvocation,
} from '../src/index.js';

const root = (): AgentDocumentNode => ({
  children: [
    { kind: 'markdown', text: '# Ready' },
    { kind: 'text', text: 'plain' },
    { kind: 'json', value: { ready: true } },
    { completed: 1, kind: 'progress', message: 'done', total: 1 },
    { data: 'aW1hZ2U=', kind: 'image', mimeType: 'image/png' },
    { data: 'YXVkaW8=', kind: 'audio', mimeType: 'audio/wav' },
    { kind: 'resource', mimeType: 'application/json', name: 'Catalog', uri: 'catalog://root' },
    { code: 'E_DEMO', kind: 'error', message: 'represented' },
  ],
  kind: 'result',
  metadata: { source: 'test' },
});

const invocationLabel = (invocation: AgentRenderInvocation): string => {
  switch (invocation.kind) {
    case 'tool':
      return invocation.props.operationId;
    case 'event':
      return invocation.props.event;
    case 'cli':
      return invocation.props.command;
    case 'script':
      return invocation.props.name;
    case 'workbench':
      return invocation.props.view;
    default: {
      const exhaustive: never = invocation;
      return exhaustive;
    }
  }
};

describe('Agent vocabulary', () => {
  it('exposes protocol-oriented leaves without DOM elements', () => {
    expect(Object.keys(Agent)).toEqual([
      'Audio',
      'Context',
      'Error',
      'Image',
      'Json',
      'Markdown',
      'Progress',
      'Resource',
      'Result',
      'Text',
    ]);
    expect(Object.isFrozen(Agent)).toBe(true);
    expect(Agent.Context({ children: 'route guidance' }).type).toBe('agent-context');
    expect(Agent.Markdown({ children: '# Ready' }).type).toBe('agent-markdown');
    expect(Agent.Resource({ name: 'Catalog', uri: 'catalog://root' }).type).toBe('agent-resource');
    expect(Agent.Error({ children: 'represented', code: 'E_DEMO' }).type).toBe('agent-error');
  });
});

describe('AgentDocument', () => {
  it('snapshots every v1 node kind into a finite immutable document', () => {
    const source = root();
    const document = createAgentDocument({
      root: source,
      status: 'represented-error',
      value: { nested: ['stable'] },
      version: 1,
    });

    (source as { children: unknown[] }).children.push({ kind: 'text', text: 'late' });
    expect(document).toEqual({
      root: root(),
      status: 'represented-error',
      value: { nested: ['stable'] },
      version: 1,
    });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.root)).toBe(true);
    expect(Object.isFrozen((document.root as { children: readonly unknown[] }).children)).toBe(true);
    expect(Object.isFrozen(document.value)).toBe(true);
    expect(Object.isFrozen((document.root as { metadata?: unknown }).metadata)).toBe(true);
  });

  it('enforces depth, node-count, byte, and JSON-value bounds', () => {
    const nested: AgentDocumentNode = {
      children: [{ children: [{ kind: 'text', text: 'deep' }], kind: 'result' }],
      kind: 'result',
    };
    expect(() => createAgentDocument(
      { root: nested, status: 'success', version: 1 },
      { maxDocumentDepth: 2 },
    )).toThrow('depth');
    expect(() => createAgentDocument(
      { root: root(), status: 'success', version: 1 },
      { maxDocumentNodes: 2 },
    )).toThrow('node count');
    expect(() => createAgentDocument(
      { root: root(), status: 'success', version: 1 },
      { maxDocumentBytes: 20 },
    )).toThrow('bytes');
    expect(() => createAgentDocument({
      root: { kind: 'json', value: { ratio: Number.POSITIVE_INFINITY } },
      status: 'success',
      version: 1,
    })).toThrow('non-finite number');
    expect(() => createAgentDocument({
      root: { kind: 'div' } as never,
      status: 'success',
      version: 1,
    })).toThrow('Unsupported Agent Document node kind: div');
  });

  it('enforces depth, node-count, and byte bounds while cloning JSON payloads', () => {
    const nest = (depth: number): { readonly child: unknown } | string =>
      depth === 0 ? 'leaf' : { child: nest(depth - 1) };
    try {
      createAgentDocument({
        root: { kind: 'json', value: nest(70) },
        status: 'success',
        version: 1,
      });
      throw new Error('expected nested JSON value to exceed depth');
    } catch (error) {
      expect(error).toMatchObject({ code: 'document-depth-exceeded' });
    }
    try {
      createAgentDocument({
        root: { kind: 'text', text: 'ok' },
        status: 'success',
        value: nest(70),
        version: 1,
      });
      throw new Error('expected document value to exceed depth');
    } catch (error) {
      expect(error).toMatchObject({ code: 'document-depth-exceeded' });
    }
    try {
      createAgentDocument(
        {
          root: { kind: 'json', value: 'x'.repeat(8_000) },
          status: 'success',
          version: 1,
        },
        { maxDocumentBytes: 100 },
      );
      throw new Error('expected oversized JSON string to exceed bytes');
    } catch (error) {
      expect(error).toMatchObject({ code: 'document-bytes-exceeded' });
    }
    try {
      createAgentDocument(
        {
          root: { kind: 'json', value: Array.from({ length: 20 }, (_, index) => index) },
          status: 'success',
          version: 1,
        },
        { maxDocumentNodes: 4 },
      );
      throw new Error('expected wide JSON array to exceed node count');
    } catch (error) {
      expect(error).toMatchObject({ code: 'document-node-count-exceeded' });
    }
  });
});

describe('Agent render events', () => {
  it('assigns sequence numbers, snapshots payloads, and closes on complete', () => {
    const events = createAgentRenderEventSequence();
    const shell = events.emit({
      document: { root: root(), status: 'success', version: 1 },
      type: 'shell',
    });
    const progress = events.emit({ completed: 1, message: 'done', total: 1, type: 'progress' });
    const replacement = events.emit({
      boundaryId: 'summary',
      document: { root: root(), status: 'success', version: 1 },
      type: 'replace',
    });
    const representedError = events.emit({
      boundaryId: 'details',
      error: { code: 'E_DEMO', data: { retryable: false }, message: 'represented' },
      type: 'error',
    });
    const complete = events.emit({
      document: { root: root(), status: 'represented-error', version: 1 },
      type: 'complete',
    });

    expect([
      shell.sequence,
      progress.sequence,
      replacement.sequence,
      representedError.sequence,
      complete.sequence,
    ]).toEqual([0, 1, 2, 3, 4]);
    expect(events.completed).toBe(true);
    expect(Object.isFrozen(shell)).toBe(true);
    expect(Object.isFrozen(representedError.error)).toBe(true);
    expect(Object.isFrozen(representedError.error.data)).toBe(true);
    expect(() => events.emit({ completed: 2, type: 'progress' })).toThrow(AgentContractError);
    expect(() => events.emit({ completed: 2, type: 'progress' })).toThrow('handoff');
    try {
      events.emit({ completed: 2, type: 'progress' });
      throw new Error('expected post-completion emit to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'handoff-required' });
    }
  });

  it('bounds event count and event bytes', () => {
    const countBounded = createAgentRenderEventSequence({ maxEvents: 1 });
    countBounded.emit({ completed: 0, type: 'progress' });
    expect(() => countBounded.emit({ completed: 1, type: 'progress' })).toThrow('event count');

    const byteBounded = createAgentRenderEventSequence({ maxEventBytes: 20 });
    expect(() => byteBounded.emit({ completed: 0, message: 'too large', type: 'progress' })).toThrow('bytes');
  });

  it('bounds event rate within a one-second window', () => {
    const events = createAgentRenderEventSequence({ maxEventRate: 2 });
    events.emit({ completed: 0, type: 'progress' });
    events.emit({ completed: 1, type: 'progress' });
    expect(() => events.emit({ completed: 2, type: 'progress' })).toThrow(AgentContractError);
    expect(() => events.emit({ completed: 2, type: 'progress' })).toThrow('rate');
    try {
      events.emit({ completed: 2, type: 'progress' });
      throw new Error('expected event-rate emit to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'event-rate-exceeded' });
    }
  });

  it('bounds elapsed render time', { retry: 2 }, async () => {
    const events = createAgentRenderEventSequence({ maxElapsedMs: 5 });
    events.emit({ completed: 0, type: 'progress' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(() => events.emit({ completed: 1, type: 'progress' })).toThrow(AgentContractError);
    expect(() => events.emit({ completed: 1, type: 'progress' })).toThrow('elapsed');
    try {
      events.emit({ completed: 1, type: 'progress' });
      throw new Error('expected elapsed-time emit to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'elapsed-time-exceeded' });
    }
  });
});

describe('AgentRenderInvocation', () => {
  it('discriminates typed props for every invocation kind', () => {
    expect([
      invocationLabel({ kind: 'tool', props: { input: {}, operationId: 'status' } }),
      invocationLabel({ kind: 'event', props: { event: 'tool/after', payload: {} } }),
      invocationLabel({ kind: 'cli', props: { args: [], command: 'status' } }),
      invocationLabel({ kind: 'script', props: { name: 'check-status' } }),
      invocationLabel({ kind: 'workbench', props: { view: 'runtime' } }),
    ]).toEqual(['status', 'tool/after', 'status', 'check-status', 'runtime']);
  });
});
