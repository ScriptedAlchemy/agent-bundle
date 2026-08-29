import { join } from 'node:path';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..', '..');

export const agentBundlePackageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
export const agentBundleNodeModules = join(agentBundlePackageRoot, 'node_modules');
export const workbenchNodeModules = join(workspaceRoot, 'packages', 'workbench', 'node_modules');
export const workspaceNodeModules = join(workspaceRoot, 'node_modules');
