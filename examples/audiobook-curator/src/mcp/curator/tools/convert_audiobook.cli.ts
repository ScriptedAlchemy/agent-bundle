import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './convert_audiobook.js';

export const config = {
  command: ['convert'],
  confirm: false,
  description: 'Plan or apply a verified conversion to one chaptered M4B.',
} satisfies CliProjectionConfig<typeof inputSchema>;
