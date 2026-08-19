import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const exampleRootFromModule = (moduleUrl) => resolve(dirname(fileURLToPath(moduleUrl)), '..');
