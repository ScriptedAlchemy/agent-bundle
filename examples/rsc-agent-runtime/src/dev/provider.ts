import type { DevRuntimeProvider, DevRuntimeStartContext } from 'agent-bundle/api';

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
