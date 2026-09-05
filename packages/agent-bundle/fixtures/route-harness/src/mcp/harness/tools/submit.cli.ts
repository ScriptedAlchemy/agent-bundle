import type { CliProjectionConfig } from 'agent-bundle/routes';
import type { z } from 'zod';

import type { inputSchema } from './submit.js';

/**
 * The CLI surface projection of `tool:harness/submit` (#596): never a route.
 * The tool stays the operation (`routeId`, `operationId`); this module only
 * spells its canonical input as an idiomatic command — `laneKey` as `--lane`,
 * `tags` as a repeatable `--tag`, `argv` as the trailing positionals (so
 * `-- cargo check -p foo` passes flags through), and `cwd` relaxed on the CLI
 * because `mapInput` derives it from the process. `confirm: false` overrides
 * the `readOnlyHint: false` default, so the command runs without `--yes`.
 */
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

/** The parsed argv: canonical keys, with `cwd` optional because the projection relaxed it. */
type CliInput = Omit<z.input<typeof inputSchema>, 'cwd'> & { readonly cwd?: string };

/**
 * Applied by the CLI shell before the canonical `inputSchema`, synchronously.
 * A tag starting with `!` is the fixture's trigger for a thrown mapping error,
 * which the shell reports as an input failure (exit 2).
 */
export const mapInput = (input: CliInput): z.input<typeof inputSchema> => {
  const tags = input.tags === undefined ? undefined : [...new Set(input.tags)];
  const rejected = tags?.find((tag) => tag.startsWith('!'));
  if (rejected !== undefined) {
    throw new Error(`Tag ${JSON.stringify(rejected)} must not start with "!".`);
  }
  return {
    ...input,
    cwd: input.cwd ?? process.cwd(),
    ...(tags === undefined ? {} : { tags }),
  };
};
