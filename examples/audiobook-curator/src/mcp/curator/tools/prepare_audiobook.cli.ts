import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './prepare_audiobook.js';

export const config = {
  command: ['prepare'],
  confirm: false,
  description: 'Plan an M4B output or apply the plan when explicitly requested.',
  flags: {
    outputName: { name: 'name' },
    outputRoot: { name: 'output' },
  },
  positionals: ['source'],
} satisfies CliProjectionConfig<typeof inputSchema>;
