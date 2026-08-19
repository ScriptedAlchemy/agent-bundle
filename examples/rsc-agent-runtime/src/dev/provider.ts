import type { DevRuntimeProvider, DevRuntimeStartContext } from '../../../../packages/agent-bundle/src/dev/runtime-provider.ts';

import { RsbuildRuntimeSession } from './rsbuild-runtime-session.js';

export const createDevRuntimeProvider = (): DevRuntimeProvider => Object.freeze({
  descriptor: Object.freeze({
    environmentVariables: Object.freeze([]),
    id: 'rsc-agent-runtime',
    label: 'RSC agent runtime',
    schemaVersion: 1,
  }),
  start: async (context: DevRuntimeStartContext) => RsbuildRuntimeSession.start(context),
});
