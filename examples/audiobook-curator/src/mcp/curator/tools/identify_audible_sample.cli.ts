import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './identify_audible_sample.js';

export const config = {
  command: ['acoustic-identify'],
  confirm: false,
  description: 'Try score-ranked, deduplicated Audible candidates and retain per-candidate evidence.',
} satisfies CliProjectionConfig<typeof inputSchema>;
