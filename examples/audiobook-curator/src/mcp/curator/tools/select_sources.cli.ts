import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './select_sources.js';

export const config = {
  command: ['select'],
  confirm: false,
  description: 'Choose the strongest source among normalized collisions.',
} satisfies CliProjectionConfig<typeof inputSchema>;
