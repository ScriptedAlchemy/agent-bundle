import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import {
  AgentContractError,
  createAgentRenderDispatcher,
  decodeAgentDocument,
  type AgentFlightExecutionHost,
  type AgentProgressReporter,
  type AgentRenderEvent,
} from '../src/index.js';

describe('decodeAgentDocument', () => {
  it('decodes protocol host elements into one immutable final document', () => {
    const document = decodeAgentDocument(createElement(
      'agent-result',
      { metadata: { source: 'flight' }, value: { ready: true } },
      createElement('agent-context', null, 'route guidance'),
      createElement('agent-markdown', null, '# Ready'),
      createElement('agent-error', { code: 'E_REPRESENTED' }, 'Partial result'),
    ));

    expect(document).toEqual({
      root: {
        children: [
          { kind: 'context', text: 'route guidance' },
          { kind: 'markdown', text: '# Ready' },
          { code: 'E_REPRESENTED', kind: 'error', message: 'Partial result' },
        ],
        kind: 'result',
        metadata: { source: 'flight' },
      },
      status: 'represented-error',
      value: { ready: true },
      version: 1,
    });
    expect(Object.isFrozen(document)).toBe(true);
  });

  it('never invokes function components while decoding Flight output', () => {
    let invoked = false;
    const Component = () => {
      invoked = true;
      return createElement('agent-result');
    };

    expect(() => decodeAgentDocument(createElement(Component))).toThrow('protocol element');
    expect(invoked).toBe(false);
    expect(() => decodeAgentDocument(createElement('div'))).toThrow('protocol element');
  });
});

describe('AgentRenderDispatcher', () => {
  it('passes the request AbortSignal to the execution host and fails before execution when already aborted', async () => {
    let calls = 0;
    const host: AgentFlightExecutionHost = {
      execute: async () => {
        calls += 1;
        return new ReadableStream<Uint8Array>();
      },
    };
    const dispatcher = createAgentRenderDispatcher(host);
    const controller = new AbortController();
    controller.abort();

    await expect(dispatcher.dispatch({
      invocation: { kind: 'event', props: { event: 'tool/after', payload: {} } },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });
});


describe('Flight compatibility pins', () => {
  it('keeps the runtime and proof compiler on the exact proven package set', () => {
    const runtime = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'examples/rsc-agent-runtime/package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };

    expect(runtime.dependencies['react-server-dom-rspack']).toBe('0.1.0');
    expect(runtime.peerDependencies.react).toBe('19.2.8');
    expect(runtime.peerDependencies['react-dom']).toBe('19.2.8');
    expect(example.devDependencies['rsbuild-plugin-rsc']).toBe('0.1.1');
  });
});

const workerPath = join(import.meta.dirname, 'flight-render-worker.mjs');

const invocation = {
  kind: 'tool' as const,
  props: { input: {}, operationId: 'status' },
};

const createWorkerHost = (
  fixture: string,
): AgentFlightExecutionHost & { readonly resolve: (gate: 'a' | 'b') => void } => {
  let child: ChildProcessWithoutNullStreams | undefined;
  return {
    resolve(gate) {
      if (child === undefined) throw new Error('Flight worker is not running');
      child.stdin.write(`${JSON.stringify({ resolve: gate })}\n`);
    },
    async execute(request) {
      child = spawn(process.execPath, ['--conditions=react-server', workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const abort = (): void => {
        child?.kill('SIGTERM');
      };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      child.stdin.write(`${JSON.stringify({ fixture })}\n`);
      if (child.stdout === null) throw new Error('Flight worker stdout is unavailable');
      return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    },
  };
};

const collectEvents = async (
  stream: ReadableStream<AgentRenderEvent>,
): Promise<readonly AgentRenderEvent[]> => {
  const events: AgentRenderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const eventTypes = (events: readonly AgentRenderEvent[]): readonly string[] =>
  events.map((event) => {
    switch (event.type) {
      case 'shell':
      case 'progress':
      case 'replace':
      case 'error':
      case 'complete':
        return event.type;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  });

describe('AgentRenderDispatcher streaming', () => {
  it('keeps dispatch final-only while stream emits shell, replace, and complete', { retry: 2 }, async () => {
    const host = createWorkerHost('single');
    const dispatcher = createAgentRenderDispatcher(host);
    const controller = new AbortController();
    const stream = dispatcher.stream({ invocation, signal: controller.signal });
    const reader = stream.getReader();

    const shell = await reader.read();
    expect(shell.done).toBe(false);
    if (shell.value === undefined || shell.value.type !== 'shell') {
      throw new Error('expected a shell event');
    }
    expect(shell.value.sequence).toBe(0);
    expect(shell.value.document.root).toMatchObject({
      children: [
        { kind: 'markdown', text: '# Shell' },
        { kind: 'progress', message: 'loading-a' },
      ],
      kind: 'result',
    });
    expect(shell.value.document.status).toBe('success');

    host.resolve('a');
    const replacement = await reader.read();
    expect(replacement.done).toBe(false);
    if (replacement.value === undefined || replacement.value.type !== 'replace') {
      throw new Error('expected a replace event');
    }
    expect(replacement.value.sequence).toBe(1);
    expect(replacement.value.boundaryId).toBe('b:1');
    expect(replacement.value.document.root).toMatchObject({
      children: [
        { kind: 'markdown', text: '# Shell' },
        { kind: 'markdown', text: 'A ready' },
      ],
      kind: 'result',
    });

    const complete = await reader.read();
    expect(complete.done).toBe(false);
    if (complete.value === undefined || complete.value.type !== 'complete') {
      throw new Error('expected a complete event');
    }
    expect(complete.value.sequence).toBe(2);
    expect(complete.value.document).toEqual(replacement.value.document);
    expect(Object.isFrozen(complete.value.document)).toBe(true);
    expect((await reader.read()).done).toBe(true);

    const finalHost = createWorkerHost('single');
    const finalDispatcher = createAgentRenderDispatcher(finalHost);
    const finalController = new AbortController();
    const dispatched = finalDispatcher.dispatch({ invocation, signal: finalController.signal });
    finalHost.resolve('a');
    await expect(dispatched).resolves.toEqual(complete.value.document);
  });

  it('keeps boundary IDs stable and emits replace in resolution order', { retry: 2 }, async () => {
    const host = createWorkerHost('dual');
    const dispatcher = createAgentRenderDispatcher(host);
    const reader = dispatcher.stream({ invocation, signal: new AbortController().signal }).getReader();

    const shell = await reader.read();
    if (shell.value?.type !== 'shell') throw new Error('expected a shell event');
    expect(shell.value.document.root).toMatchObject({
      children: [
        { kind: 'markdown', text: '# Shell' },
        { kind: 'progress', message: 'loading-a' },
        { kind: 'progress', message: 'loading-b' },
      ],
    });

    host.resolve('b');
    const first = await reader.read();
    if (first.value?.type !== 'replace') throw new Error('expected the first replace event');
    expect(first.value.boundaryId).toBe('b:2');
    expect(first.value.document.root).toMatchObject({
      children: [
        { kind: 'markdown', text: '# Shell' },
        { kind: 'progress', message: 'loading-a' },
        { kind: 'markdown', text: 'B ready' },
      ],
    });

    host.resolve('a');
    const second = await reader.read();
    if (second.value?.type !== 'replace') throw new Error('expected the second replace event');
    expect(second.value.boundaryId).toBe('b:1');
    expect(second.value.sequence).toBeGreaterThan(first.value.sequence);

    const complete = await reader.read();
    if (complete.value?.type !== 'complete') throw new Error('expected a complete event');
    expect(eventTypes([shell.value, first.value, second.value, complete.value])).toEqual([
      'shell',
      'replace',
      'replace',
      'complete',
    ]);
    expect([shell.value.sequence, first.value.sequence, second.value.sequence, complete.value.sequence]).toEqual([
      0,
      1,
      2,
      3,
    ]);
  });

  it('assigns a new nested boundary after the outer shell resolves', { retry: 2 }, async () => {
    const host = createWorkerHost('nested');
    const dispatcher = createAgentRenderDispatcher(host);
    const reader = dispatcher.stream({ invocation, signal: new AbortController().signal }).getReader();

    const shell = await reader.read();
    if (shell.value?.type !== 'shell') throw new Error('expected a shell event');

    host.resolve('a');
    const outer = await reader.read();
    if (outer.value?.type !== 'replace') throw new Error('expected the outer replace event');
    expect(outer.value.boundaryId).toBe('b:1');
    expect(outer.value.document.root).toMatchObject({
      children: [
        { kind: 'markdown', text: '# Shell' },
        { kind: 'markdown', text: 'inner-shell' },
        { kind: 'progress', message: 'loading-inner' },
      ],
    });

    host.resolve('b');
    const inner = await reader.read();
    if (inner.value?.type !== 'replace') throw new Error('expected the inner replace event');
    expect(inner.value.boundaryId).toMatch(/^b:1\./);
    expect(inner.value.document.root).toMatchObject({
      children: [
        { kind: 'markdown', text: '# Shell' },
        { kind: 'markdown', text: 'inner-shell' },
        { kind: 'markdown', text: 'nested-ready' },
      ],
    });
    expect((await reader.read()).value?.type).toBe('complete');
  });

  it('emits progress as mutable status distinct from replace', { retry: 2 }, async () => {
    let progress: AgentProgressReporter | undefined;
    const inner = createWorkerHost('single');
    const host: AgentFlightExecutionHost = {
      execute: async (request) => {
        progress = request.progress;
        return inner.execute(request);
      },
    };
    const dispatcher = createAgentRenderDispatcher(host);
    const reader = dispatcher.stream({ invocation, signal: new AbortController().signal }).getReader();
    const shell = await reader.read();
    if (shell.value?.type !== 'shell') throw new Error('expected a shell event');
    if (progress === undefined) throw new Error('expected the dispatcher to install a progress reporter');

    await progress.report({ completed: 3, message: 'inspecting', total: 10 });
    const reported = await reader.read();
    if (reported.value?.type !== 'progress') throw new Error('expected a progress event');
    expect(reported.value).toMatchObject({
      completed: 3,
      message: 'inspecting',
      sequence: 1,
      total: 10,
      type: 'progress',
    });

    inner.resolve('a');
    const replacement = await reader.read();
    if (replacement.value?.type !== 'replace') throw new Error('expected a replace event');
    expect(replacement.value.sequence).toBe(2);
    expect((await reader.read()).value?.type).toBe('complete');
  });

  it('emits a represented boundary error and still completes siblings', { retry: 2 }, async () => {
    const host = createWorkerHost('boom');
    const dispatcher = createAgentRenderDispatcher(host);
    const reader = dispatcher.stream({ invocation, signal: new AbortController().signal }).getReader();
    const shell = await reader.read();
    if (shell.value?.type !== 'shell') throw new Error('expected a shell event');
    host.resolve('a');
    const failed = await reader.read();
    if (failed.value?.type !== 'error') throw new Error('expected an error event');
    expect(failed.value.boundaryId).toBe('b:1');
    expect(failed.value.error.message).toContain('boundary failed');
    const complete = await reader.read();
    if (complete.value?.type !== 'complete') throw new Error('expected a complete event');
    expect(complete.value.document.status).toBe('represented-error');
    expect(complete.value.document.root).toMatchObject({
      children: [
        { kind: 'markdown', text: '# Shell' },
        { kind: 'error', message: 'boundary failed' },
      ],
    });
  });

  it('aborts pending boundaries and closes the stream without complete', { retry: 2 }, async () => {
    const host = createWorkerHost('single');
    const dispatcher = createAgentRenderDispatcher(host);
    const controller = new AbortController();
    const reader = dispatcher.stream({ invocation, signal: controller.signal }).getReader();
    const shell = await reader.read();
    if (shell.value?.type !== 'shell') throw new Error('expected a shell event');
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a post-completion progress producer with a typed handoff', { retry: 2 }, async () => {
    let progress: AgentProgressReporter | undefined;
    const inner = createWorkerHost('ready');
    const host: AgentFlightExecutionHost = {
      execute: async (request) => {
        progress = request.progress;
        return inner.execute(request);
      },
    };
    const dispatcher = createAgentRenderDispatcher(host);
    const events = await collectEvents(dispatcher.stream({ invocation, signal: new AbortController().signal }));
    expect(eventTypes(events)).toEqual(['shell', 'complete']);
    if (progress === undefined) throw new Error('expected the dispatcher to install a progress reporter');
    await expect(progress.report({ completed: 1, message: 'late' })).rejects.toBeInstanceOf(AgentContractError);
    await expect(progress.report({ completed: 1, message: 'late' })).rejects.toMatchObject({
      code: 'handoff-required',
    });
  });

  it('applies backpressure across the Flight byte boundary after the shell', { retry: 2 }, async () => {
    const inner = createWorkerHost('single');
    let pulls = 0;
    const host: AgentFlightExecutionHost = {
      execute: async (request) => {
        const flight = await inner.execute(request);
        const reader = flight.getReader();
        return new ReadableStream<Uint8Array>({
          async cancel(reason) {
            await reader.cancel(reason);
          },
          async pull(controller) {
            pulls += 1;
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            controller.enqueue(next.value);
          },
        }, { highWaterMark: 0 });
      },
    };
    const dispatcher = createAgentRenderDispatcher(host);
    const reader = dispatcher.stream({ invocation, signal: new AbortController().signal }).getReader();
    const shell = await reader.read();
    if (shell.value?.type !== 'shell') throw new Error('expected a shell event');
    inner.resolve('a');
    const pullsAfterResolve = await new Promise<number>((resolve) => {
      setTimeout(() => resolve(pulls), 30);
    });
    expect(pullsAfterResolve).toBe(pulls);
    const replacement = await reader.read();
    if (replacement.value?.type !== 'replace') throw new Error('expected a replace event');
    expect(pulls).toBeGreaterThan(pullsAfterResolve);
    expect((await reader.read()).value?.type).toBe('complete');
  });

  it('enforces event-count bounds on the live stream', { retry: 2 }, async () => {
    const host = createWorkerHost('single');
    const dispatcher = createAgentRenderDispatcher(host, { limits: { maxEvents: 1 } });
    const reader = dispatcher.stream({ invocation, signal: new AbortController().signal }).getReader();
    const shell = await reader.read();
    if (shell.value?.type !== 'shell') throw new Error('expected a shell event');
    host.resolve('a');
    await expect(reader.read()).rejects.toBeInstanceOf(AgentContractError);
    await expect(reader.read()).rejects.toMatchObject({ code: 'event-count-exceeded' });
  });
});
