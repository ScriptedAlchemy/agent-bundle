import type { CliProjectionConfig } from 'agent-bundle/routes';

import type { inputSchema } from './verify_with_whisper.js';

export const config = {
  command: ['whisper-verify'],
  confirm: false,
  description: 'Transcribe distributed audiobook windows for human language and identity review.',
} satisfies CliProjectionConfig<typeof inputSchema>;
