import { join } from 'node:path';

export const devStateRoot = (projectRoot: string): string => join(projectRoot, '.agent-bundle', 'state');
