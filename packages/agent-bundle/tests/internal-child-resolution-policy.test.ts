import { readFile } from 'node:fs/promises';

import { describe, expect, it } from '@rstest/core';

const internalChildOwners = [
  '../src/dev/playground/lifecycle-replay-service.ts',
  '../src/dev/routes/route-invocation-service.ts',
] as const;

describe('internal child executable resolution', () => {
  for (const sourcePath of internalChildOwners) {
    it(`${sourcePath} never resolves framework children from the caller cwd`, async () => {
      const source = await readFile(new URL(sourcePath, import.meta.url), 'utf8');

      expect(source).not.toContain("resolve(process.cwd(), 'packages/agent-bundle/src/");
    });
  }
});
