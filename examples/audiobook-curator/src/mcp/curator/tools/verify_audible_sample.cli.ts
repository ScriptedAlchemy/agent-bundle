import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './verify_audible_sample.js';

export const config = {
  command: ['acoustic-verify'],
  confirm: false,
  description: 'Compare one bounded Audible sample with local audio through optional Audiolocate.',
} satisfies CliProjectionConfig<typeof inputSchema>;
