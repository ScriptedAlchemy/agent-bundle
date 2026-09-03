import type { DevRuntimeProvider } from 'agent-bundle/api';

import { RsbuildRuntimeSession } from './rsbuild-runtime-session.js';

/** The start context the public provider contract hands `start`; the framework exports only the provider type itself. */
type DevRuntimeStartContext = Parameters<DevRuntimeProvider['start']>[0];

export const createDevRuntimeProvider = (): DevRuntimeProvider => Object.freeze({
  descriptor: Object.freeze({
    environmentVariables: Object.freeze([]),
    id: 'rsc-agent-runtime',
    label: 'RSC agent runtime',
    schemaVersion: 1,
  }),
  start: async (context: DevRuntimeStartContext) => RsbuildRuntimeSession.start(context),
});
