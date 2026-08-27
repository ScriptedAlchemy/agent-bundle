import { join } from 'node:path';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..', '..');

export const agentBundleNodeModules = join(workspaceRoot, 'packages', 'agent-bundle', 'node_modules');
export const workbenchNodeModules = join(workspaceRoot, 'packages', 'workbench', 'node_modules');
export const workspaceNodeModules = join(workspaceRoot, 'node_modules');
