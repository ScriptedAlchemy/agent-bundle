import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './inventory_sources.js';

export const config = {
  command: ['inventory'],
  confirm: false,
  description: 'Probe source audio without changing it.',
  positionals: ['source'],
} satisfies CliProjectionConfig<typeof inputSchema>;
