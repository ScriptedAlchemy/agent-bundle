import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './audit_audiobook.js';

export const config = {
  command: ['audit'],
  confirm: false,
  description: 'Validate metadata, chapters, source mapping, hashes, and optional complete decode.',
} satisfies CliProjectionConfig<typeof inputSchema>;
