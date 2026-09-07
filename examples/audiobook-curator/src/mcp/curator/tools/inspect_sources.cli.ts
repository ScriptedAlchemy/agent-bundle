import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './inspect_sources.js';

export const config = {
  command: ['inspect'],
  confirm: false,
  description: 'Inspect a bounded audiobook source tree without changing it.',
  positionals: ['root'],
} satisfies CliProjectionConfig<typeof inputSchema>;
