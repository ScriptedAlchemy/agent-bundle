import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './select.js';

// The selection is a discriminated union under a nested object, which the
// bounded argv grammar cannot spell; the command takes the canonical input
// as one JSON object and the tool's own inputSchema judges it.
export const config = {
  command: ['select'],
  description: 'Selects catalog entries from one JSON selection.',
  input: 'json',
} satisfies CliProjectionConfig<typeof inputSchema>;
