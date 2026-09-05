import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

const packageRoot = join(process.cwd(), 'packages/agent-bundle');
const staticRuntimeImport = /\b(?:import|export)\s+[^;\n]*?\sfrom\s*["']@agent-bundle\/runtime(?:\/[^"']*)?["']/u;

it('keeps optional runtime peers out of eagerly loaded public bundles', async () => {
  for (const entry of ['api.js', 'test.js']) {
    const source = await readFile(join(packageRoot, 'dist', entry), 'utf8');
    expect(source, entry).not.toMatch(staticRuntimeImport);
  }
});
