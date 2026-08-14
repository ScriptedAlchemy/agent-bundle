import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { serializeRuntimeDefinition } from './serialize-definition.js';

export const emitRuntimeArtifacts = async (distPath: string): Promise<void> => {
  const manifest = {
    ...serializeRuntimeDefinition(),
    executables: [
      { name: 'stdio', path: 'mcp/stdio.js' },
      { name: 'http', path: 'mcp/http.js' },
    ],
    schemaVersion: 1,
  };

  await mkdir(distPath, { recursive: true });
  await writeFile(join(distPath, 'agent-runtime.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};
