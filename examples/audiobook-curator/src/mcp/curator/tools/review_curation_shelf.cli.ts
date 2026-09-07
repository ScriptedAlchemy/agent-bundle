import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './review_curation_shelf.js';

export const config = {
  command: ['shelf'],
  confirm: false,
  description: 'Show the persisted curation shelf.',
} satisfies CliProjectionConfig<typeof inputSchema>;
