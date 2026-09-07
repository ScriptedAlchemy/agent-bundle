import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './apply_audiobook_chapters.js';

export const config = {
  command: ['apply-chapters'],
  confirm: false,
  description: 'Plan or apply verified generic or Audible chapter rows without changing encoded audio.',
} satisfies CliProjectionConfig<typeof inputSchema>;
