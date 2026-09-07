import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './select_audible_edition.js';

export const config = {
  command: ['audible-select'],
  confirm: false,
  description: 'Record one explicit human-reviewed Audible edition choice.',
} satisfies CliProjectionConfig<typeof inputSchema>;
