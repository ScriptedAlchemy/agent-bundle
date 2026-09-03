// Dependency-free Dev Log vocabulary shared by the Node service and the
// browser log client. This module must not import Node builtins so it can be
// bundled into the workbench without pulling Buffer or path shims along.

export const devLogProducers = Object.freeze([
  'project',
  'build',
  'diagnostic',
  'mcp',
  'hook',
  'eval',
  'playground',
] as const);

export const devLogLevels = Object.freeze(['debug', 'info', 'warning', 'error'] as const);

export type DevLogProducer = (typeof devLogProducers)[number];
export type DevLogLevel = (typeof devLogLevels)[number];

export const devLogKinds = Object.freeze({
  build: Object.freeze(['artifact.available', 'build.failed', 'build.started'] as const),
  diagnostic: Object.freeze([
    'artifact.available.diagnostic', 'artifact.status.diagnostic', 'build.failed.diagnostic', 'build.started.diagnostic',
    'dev.contract.status.diagnostic', 'dev.host.sync.diagnostic', 'invalidation.diagnostic', 'runtime.event.diagnostic',
    'source.changed.diagnostic', 'source.status.diagnostic',
  ] as const),
  eval: Object.freeze(['eval.run.completed', 'eval.run.failed', 'eval.run.started'] as const),
  hook: Object.freeze([
    'hook.simulate.completed',
    'hook.simulate.failed',
    'hook.simulate.started',
    'lifecycle.replay.completed',
    'lifecycle.replay.failed',
    'lifecycle.replay.started',
  ] as const),
  mcp: Object.freeze(['mcp.logging', 'mcp.stderr', 'mcp.operation.failed', 'mcp.operation.started', 'mcp.operation.succeeded'] as const),
  playground: Object.freeze(['playground.event.appended'] as const),
  project: Object.freeze([
    'artifact.status', 'dev.contract.status', 'dev.host.sync', 'dev.shutdown.completed', 'dev.shutdown.started', 'invalidation',
    'project.events.replay-gap', 'project.invalid-source', 'project.load', 'project.prepared', 'runtime.event',
    'source.changed', 'source.status',
  ] as const),
} satisfies { readonly [TProducer in DevLogProducer]: readonly string[] });

/** Closed, producer-owned wire kinds derived from devLogKinds. A producer cannot smuggle arbitrary text into `kind`. */
export type DevLogKindMap = { readonly [TProducer in DevLogProducer]: (typeof devLogKinds)[TProducer][number] };

export type DevLogKindFor<TProducer extends DevLogProducer> = DevLogKindMap[TProducer];

export const hasControlOrSeparators = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x2f || code === 0x5c || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};
