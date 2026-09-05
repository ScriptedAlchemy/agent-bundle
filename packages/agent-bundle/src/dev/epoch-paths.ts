import { join } from 'node:path';

export const devEpochStateRoot = (epochRoot: string): string => join(epochRoot, 'state');
