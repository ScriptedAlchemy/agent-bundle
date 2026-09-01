globalThis.__rspack_rsc_manifest__ = Object.freeze({
  clientManifest: Object.freeze({}),
  moduleLoading: null,
  serverConsumerModuleMap: null,
  serverManifest: Object.freeze({}),
});

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

import { createElement, Fragment, Suspense } from 'react';
import { renderToReadableStream } from 'react-server-dom-rspack/server.node';

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const gates = {
  a: deferred(),
  b: deferred(),
};

const Slow = async ({ gate, label }) => {
  await gates[gate].promise;
  return createElement('agent-markdown', null, label);
};

const Boom = async () => {
  await gates.a.promise;
  throw new Error('boundary failed');
};

const NestedInner = async () => {
  await gates.b.promise;
  return createElement('agent-markdown', null, 'nested-ready');
};

const NestedOuter = async () => {
  await gates.a.promise;
  return createElement(
    Fragment,
    null,
    createElement('agent-markdown', null, 'inner-shell'),
    createElement(
      Suspense,
      { fallback: createElement('agent-progress', { completed: 0, message: 'loading-inner' }) },
      createElement(NestedInner),
    ),
  );
};

const modelFor = (fixture) => {
  switch (fixture) {
    case 'ready':
      return createElement(
        'agent-result',
        { value: { ready: true } },
        createElement('agent-markdown', null, '# Ready'),
      );
    case 'single':
      return createElement(
        'agent-result',
        { value: { ready: false } },
        createElement('agent-markdown', null, '# Shell'),
        createElement(
          Suspense,
          { fallback: createElement('agent-progress', { completed: 0, message: 'loading-a' }) },
          createElement(Slow, { gate: 'a', label: 'A ready' }),
        ),
      );
    case 'dual':
      return createElement(
        'agent-result',
        null,
        createElement('agent-markdown', null, '# Shell'),
        createElement(
          Suspense,
          { fallback: createElement('agent-progress', { completed: 0, message: 'loading-a' }) },
          createElement(Slow, { gate: 'a', label: 'A ready' }),
        ),
        createElement(
          Suspense,
          { fallback: createElement('agent-progress', { completed: 0, message: 'loading-b' }) },
          createElement(Slow, { gate: 'b', label: 'B ready' }),
        ),
      );
    case 'nested':
      return createElement(
        'agent-result',
        null,
        createElement('agent-markdown', null, '# Shell'),
        createElement(
          Suspense,
          { fallback: createElement('agent-progress', { completed: 0, message: 'loading-outer' }) },
          createElement(NestedOuter),
        ),
      );
    case 'boom':
      return createElement(
        'agent-result',
        null,
        createElement('agent-markdown', null, '# Shell'),
        createElement(
          Suspense,
          { fallback: createElement('agent-progress', { completed: 0, message: 'loading-a' }) },
          createElement(Boom),
        ),
      );
    default:
      throw new Error(`Unsupported flight fixture: ${String(fixture)}`);
  }
};

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === '') continue;
  const command = JSON.parse(line);
  if (command.fixture !== undefined) {
    const flight = renderToReadableStream(modelFor(command.fixture), {
      onError: (error) => (error instanceof Error ? error.message : 'error'),
    });
    const output = Readable.fromWeb(flight);
    output.pipe(process.stdout);
    output.on('end', () => {
      process.exit(0);
    });
    continue;
  }
  if (command.resolve === 'a' || command.resolve === 'b') {
    gates[command.resolve].resolve();
    continue;
  }
  throw new Error(`Unsupported flight worker command: ${line}`);
}
