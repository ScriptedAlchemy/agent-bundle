import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';

/**
 * AB4100's row in `docs/diagnostics.md` — the source the generated
 * `reference/diagnostics.md` page is rendered from — enumerates the whole
 * built-in registry twice, and nothing else compares that prose to the
 * registry (#756).
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const diagnosticsDoc = readFileSync(resolve(workspaceRoot, 'docs/diagnostics.md'), 'utf8');

const backtickedNames = (text: string): readonly string[] =>
  [...text.matchAll(/`([a-z]+)`/gu)].map(([, name]) => name as string);

it('enumerates every built-in target in the AB4100 row', () => {
  const row = diagnosticsDoc.split('\n').find((line) => line.startsWith('| `AB4100` |'));
  expect(row).toBeDefined();
  const trigger = /The built-in registry publishes ([^;]+);/u.exec(row ?? '');
  const recovery = /Select host projections \(([^)]+)\)/u.exec(row ?? '');
  expect(trigger?.[1]).toBeDefined();
  expect(recovery?.[1]).toBeDefined();

  const registered = [...createDefaultRegistry().names()].sort();
  expect(backtickedNames(trigger?.[1] ?? '').toSorted()).toEqual(registered);
  expect(backtickedNames(recovery?.[1] ?? '').toSorted()).toEqual(registered);
});
