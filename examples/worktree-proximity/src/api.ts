import { agent } from '@agent-bundle/runtime';
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

export const worktree = async (): Promise<WorktreeProviderValue> => {
  const candidate = (await agent()).providers.gitWorktree;
  const parsed = WorktreeProviderValueSchema.safeParse(candidate);
  return parsed.success
    ? parsed.data
    : {
        reason: 'The git-worktree provider did not expose a valid worktree identity.',
        state: 'unavailable',
      };
};
