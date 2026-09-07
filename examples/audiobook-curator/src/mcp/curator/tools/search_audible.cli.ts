import type { CliProjectionConfig } from 'agent-bundle/routes';
import type { z } from 'zod';

import { audibleRegionList } from '../../../operations/audible.js';
import type { inputSchema } from './search_audible.js';

export const config = {
  command: ['audible-search'],
  confirm: false,
  description: 'Search and rank Audible identity candidates across reviewed regions.',
  flags: {
    durationSeconds: { name: 'duration' },
    regions: { description: 'Audible regions to search (repeatable, or comma-separated)' },
  },
} satisfies CliProjectionConfig<typeof inputSchema>;

type CliInput = Omit<z.input<typeof inputSchema>, 'regions'> & { readonly regions?: readonly string[] };

/** `--regions us,uk` and `--regions us --regions uk` both reach the canonical region array. */
export const mapInput = (input: CliInput): z.input<typeof inputSchema> => {
  const { regions, ...rest } = input;
  return regions === undefined ? rest : { ...rest, regions: regions.flatMap(audibleRegionList) };
};
