import { expect, it } from '@rstest/core';

import { DiagnosticError } from '../src/core/diagnostics.ts';
import { requireUnchangedSourceSnapshot, sameProjectSourceInputs } from '../src/core/source-publication.ts';

it('treats matching prepared inputs and a clean re-snapshot as unchanged', () => {
  expect(sameProjectSourceInputs(
    [{ path: 'src/a.ts', sha256: 'abc' }],
    [{ path: 'src/a.ts', sha256: 'abc' }],
  )).toBe(true);
});

it('treats a content, path, executable, or snapshot-error drift as a changed source tree', () => {
  expect(sameProjectSourceInputs(
    [{ path: 'src/a.ts', sha256: 'abc' }],
    [{ path: 'src/a.ts', sha256: 'def' }],
  )).toBe(false);
  expect(sameProjectSourceInputs(
    [{ path: 'src/a.ts', sha256: 'abc' }],
    [{ path: 'src/a.ts', sha256: 'abc', error: 'EACCES' }],
  )).toBe(false);
  expect(sameProjectSourceInputs(
    [{ executable: true, path: 'src/a.ts', sha256: 'abc' }],
    [{ path: 'src/a.ts', sha256: 'abc' }],
  )).toBe(false);
});

it('rejects a drifted re-snapshot with AB7101', async () => {
  await expect(requireUnchangedSourceSnapshot(
    async () => ({ inputs: [{ path: 'src/a.ts', sha256: 'def' }] }),
    [{ path: 'src/a.ts', sha256: 'abc' }],
    'agent-bundle.config.ts',
  )).rejects.toBeInstanceOf(DiagnosticError);
});
