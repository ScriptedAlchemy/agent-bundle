import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './audit_library.js';

export const config = {
  command: ['library-audit'],
  confirm: false,
  description: 'Audit metadata, artwork, chapters, duplicate candidates, and multipart groups.',
  positionals: ['sources'],
} satisfies CliProjectionConfig<typeof inputSchema>;
