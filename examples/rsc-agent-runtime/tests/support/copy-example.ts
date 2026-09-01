import { cp, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CopiedExample {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
}

/**
 * Copies the example into a temporary workspace shaped like the repository.
 * The example's direct dependencies (zod, @agent-bundle/runtime) live in
 * its own node_modules, not the workspace root's hoisted set, so the copy
 * links both.
 */
export const copyExample = async (
  exampleRoot: string,
  options: { readonly linkPackages?: boolean; readonly prefix: string },
): Promise<CopiedExample> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), options.prefix));
  const projectRoot = join(workspaceRoot, 'examples', 'rsc-agent-runtime');
  await cp(exampleRoot, projectRoot, {
    filter: (source) => !['.agent-bundle', 'dist', 'node_modules'].includes(source.split('/').at(-1) ?? ''),
    recursive: true,
  });
  await symlink(join(exampleRoot, '../../node_modules'), join(workspaceRoot, 'node_modules'), 'dir');
  await symlink(join(exampleRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
  if (options.linkPackages === true) {
    await symlink(join(exampleRoot, '../../packages'), join(workspaceRoot, 'packages'), 'dir');
  }
  await symlink(join(exampleRoot, '../../tsconfig.json'), join(workspaceRoot, 'tsconfig.json'));
  await symlink(join(exampleRoot, '../../tsconfig.base.json'), join(workspaceRoot, 'tsconfig.base.json'));
  return Object.freeze({ projectRoot, workspaceRoot });
};
