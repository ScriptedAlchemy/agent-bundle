import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

const workspaceRoot = process.cwd();
const workbenchRoot = join(workspaceRoot, 'packages', 'workbench');

it('does not publish the obsolete Inspector closure spike as a second application', async () => {
  await expect(access(join(workbenchRoot, 'dist', 'inspector-closure.html'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(workbenchRoot, 'dist', 'static', 'js', 'inspector-closure.js'))).rejects.toMatchObject({ code: 'ENOENT' });
});
