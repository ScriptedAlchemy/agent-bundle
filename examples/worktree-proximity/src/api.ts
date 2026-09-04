import { agent, useAgent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const WorktreeProviderValueSchema = z.discriminatedUnion('state', [
  z
    .object({
      branch: z.string().min(1),
      commonDir: z.string().min(1),
      head: z.string().min(1),
      isLinkedWorktree: z.boolean(),
      root: z.string().min(1),
      source: z.enum(['native-cwd', 'process-cwd']),
      state: z.literal('available'),
    })
    .strict(),
  z
    .object({
      reason: z.string().min(1),
      state: z.literal('unavailable'),
    })
    .strict(),
]);

export type WorktreeProviderValue = z.output<typeof WorktreeProviderValueSchema>;
export type AvailableWorktree = Extract<WorktreeProviderValue, { state: 'available' }>;

const parseWorktree = (candidate: unknown): WorktreeProviderValue => {
  const parsed = WorktreeProviderValueSchema.safeParse(candidate);
  return parsed.success
    ? parsed.data
    : {
        reason: 'The git-worktree provider did not expose a valid worktree identity.',
        state: 'unavailable',
      };
};

/** The Promise-shaped accessor over the mounted `git-worktree` provider value. */
export const worktree = async (): Promise<WorktreeProviderValue> =>
  parseWorktree((await agent()).providers.gitWorktree);

/**
 * The hook-shaped variant, for Server Components and synchronous helpers
 * that cannot `await`. It reads the identical request handle through the
 * runtime's `useAgent()`, so every lease rule holds unchanged: outside a
 * request it throws the runtime's `outside-invocation` error.
 */
export const useWorktree = (): WorktreeProviderValue =>
  parseWorktree(useAgent().providers.gitWorktree);
