import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { WorktreeProviderValue } from '../api.js';

interface ProviderContext {
  readonly invocation: {
    readonly kind: string;
    readonly props: Readonly<Record<string, unknown>>;
  };
  readonly signal: AbortSignal;
}

const execFileAsync = promisify(execFile);

const eventCwd = (context: ProviderContext): string | undefined => {
  if (context.invocation.kind !== 'event') return undefined;
  const payload = context.invocation.props.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const native = (payload as { readonly native?: unknown }).native;
  if (native === null || typeof native !== 'object') return undefined;
  const cwd = (native as { readonly cwd?: unknown }).cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined;
};

const absoluteGitPath = (cwd: string, value: string): string =>
  resolve(cwd, value);

export default async function gitWorktreeProvider(
  context: ProviderContext,
): Promise<WorktreeProviderValue> {
  const nativeCwd = eventCwd(context);
  const cwd = nativeCwd ?? process.cwd();
  const source = nativeCwd === undefined ? 'process-cwd' : 'native-cwd';
  if (cwd.trim() === '') {
    return {
      reason: 'No working directory was available for git worktree discovery.',
      state: 'unavailable',
    };
  }

  const git = async (...args: readonly string[]): Promise<string> => {
    const result = await execFileAsync(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', signal: context.signal },
    );
    return result.stdout.trim();
  };

  try {
    const [root, branch, head, commonDirValue, gitDirValue] = await Promise.all([
      git('rev-parse', '--show-toplevel'),
      git('rev-parse', '--abbrev-ref', 'HEAD'),
      git('rev-parse', 'HEAD'),
      git('rev-parse', '--git-common-dir'),
      git('rev-parse', '--git-dir'),
    ]);
    const commonDir = absoluteGitPath(cwd, commonDirValue);
    const gitDir = absoluteGitPath(cwd, gitDirValue);
    return {
      branch,
      commonDir,
      head,
      isLinkedWorktree: gitDir !== commonDir,
      root: resolve(root),
      source,
      state: 'available',
    };
  } catch (error) {
    return {
      reason:
        `Git worktree identity is unavailable for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
      state: 'unavailable',
    };
  }
}
