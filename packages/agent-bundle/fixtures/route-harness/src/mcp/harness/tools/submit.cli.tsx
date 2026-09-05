import type { CliProjectionConfig } from 'agent-bundle/routes';
import type { z } from 'zod';

import { dedupe } from '../../../lib/submit-helpers.js';
import type { inputSchema } from './submit.js';

export const config = {
  command: ['submit'],
  confirm: false,
  flags: {
    cwd: { description: 'Working directory of the command (default: the current directory).', required: false },
    laneKey: { name: 'lane' },
    tags: { description: 'Tag attached to the request (repeatable; duplicates are dropped).', name: 'tag' },
  },
  positionals: ['argv'],
} satisfies CliProjectionConfig<typeof inputSchema>;

type CliInput = Omit<z.input<typeof inputSchema>, 'cwd'> & { readonly cwd?: string };

// Leading "!" tags exercise projection mapping failures.
export const mapInput = (input: CliInput): z.input<typeof inputSchema> => {
  const tags = input.tags === undefined ? undefined : dedupe(input.tags);
  const rejected = tags?.find((tag) => tag.startsWith('!'));
  if (rejected !== undefined) {
    throw new Error(`Tag ${JSON.stringify(rejected)} must not start with "!".`);
  }
  return {
    ...input,
    cwd: input.cwd ?? process.cwd(),
    ...(tags === undefined ? {} : { tags: [...tags] }),
  };
};
