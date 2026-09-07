import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './apply_audiobook_metadata.js';

export const config = {
  command: ['apply-metadata'],
  confirm: false,
  description: 'Plan or apply verified Audible metadata and artwork without changing encoded audio.',
} satisfies CliProjectionConfig<typeof inputSchema>;
