import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './cache_audible_edition.js';

export const config = {
  command: ['audible-cache'],
  confirm: false,
  description: 'Cache one reviewed Audible product, chapters, artwork, and source URLs.',
  flags: { cacheDirectory: { name: 'cache-dir' } },
} satisfies CliProjectionConfig<typeof inputSchema>;
