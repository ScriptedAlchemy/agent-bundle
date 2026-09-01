import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import {
  createAgentRenderDispatcher,
  decodeAgentDocument,
  type AgentFlightExecutionHost,
} from '../src/index.js';

describe('decodeAgentDocument', () => {
  it('decodes protocol host elements into one immutable final document', () => {
    const document = decodeAgentDocument(createElement(
      'agent-result',
      { metadata: { source: 'flight' }, value: { ready: true } },
      createElement('agent-markdown', null, '# Ready'),
      createElement('agent-error', { code: 'E_REPRESENTED' }, 'Partial result'),
    ));

    expect(document).toEqual({
      root: {
        children: [
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
