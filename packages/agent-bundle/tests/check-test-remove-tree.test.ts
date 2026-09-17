import { expect, it } from '@rstest/core';

import {
  bareRecursiveRmFailures,
  recursiveRmCalls,
  removalBindings,
} from '../../../scripts/check-test-remove-tree.mjs';

/** Assemble sample source at runtime so the lint gate does not scan the examples. */
const sample = (lines: readonly string[]): string => lines.join('\n');
const recursiveTrue = ['recurs', 'ive: true'].join('');

it('tracks named, aliased, and namespace Node fs removal bindings', () => {
  expect(removalBindings(`import { rm } from 'node:fs/promises';`)).toEqual({
    bareNames: new Set(['rm']),
    namespaceNames: new Set(),
  });
  expect(removalBindings(`import { rm as remove } from 'node:fs/promises';`)).toEqual({
    bareNames: new Set(['rm', 'remove']),
    namespaceNames: new Set(),
  });
  expect(removalBindings(`import * as fs from 'node:fs/promises';`)).toEqual({
    bareNames: new Set(['rm']),
    namespaceNames: new Set(['fs']),
  });
  expect(removalBindings(`import fs from 'node:fs';`)).toEqual({
    bareNames: new Set(['rm']),
    namespaceNames: new Set(['fs']),
  });
});

it('flags bare, aliased, and namespace recursive removals without maxRetries', () => {
  const bare = recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `await rm(root, { force: true, ${recursiveTrue} });`,
  ]));
  expect(bare).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  const aliased = recursiveRmCalls(sample([
    "import { rm as remove } from 'node:fs/promises';",
    `await remove(root, { ${recursiveTrue} });`,
  ]));
  expect(aliased).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  const namespaced = recursiveRmCalls(sample([
    "import * as fs from 'node:fs/promises';",
    `await fs.rm(root, { ${recursiveTrue} });`,
  ]));
  expect(namespaced).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
});

it('allows nonrecursive removals, explicit maxRetries, and unrelated .rm calls', () => {
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'await rm(file);',
    `await rm(root, { force: true, ${recursiveTrue}, maxRetries: 5 });`,
    `await other.rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: true, line: 3 })]);
});

it('exempts the canonical removeTree helper and formats lint failures', () => {
  const helper = sample([
    "import { rm as removeDirectory } from 'node:fs/promises';",
    `await fs.rm(path, { force: true, ${recursiveTrue} });`,
  ]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/support/remove-tree.ts', helper)).toEqual([]);

  const escaped = sample([
    "import * as fs from 'node:fs/promises';",
    `await fs.rm(root, { ${recursiveTrue} });`,
  ]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', escaped)).toEqual([
    'packages/agent-bundle/tests/example.test.ts:2 bare recursive rm. Use removeTree.',
  ]);
});

it('ignores recursive rm text inside comments and string literals', () => {
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `const sample = 'rm(root, { ${recursiveTrue} })'`,
  ]))).toEqual([]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `/* rm(root, { ${recursiveTrue} }); */`,
  ]))).toEqual([]);
});

it('still flags calls after string urls and rejects commented-out maxRetries', () => {
  const afterUrl = recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `const url = "https://example.test"; rm(root, { ${recursiveTrue} });`,
  ]));
  expect(afterUrl).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  const commentedRetries = recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `rm(root, { ${recursiveTrue} /* maxRetries: 5 */ });`,
  ]));
  expect(commentedRetries).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
});

it('matches $-suffixed removal aliases literally', () => {
  const dollars = recursiveRmCalls(sample([
    "import { rm as remove$ } from 'node:fs/promises';",
    `await remove$(root, { ${recursiveTrue} })`,
  ]));
  expect(dollars).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { rm as remove$ } from 'node:fs/promises';",
    `await remove$(root, { ${recursiveTrue} })`,
  ]))).toEqual([
    'packages/agent-bundle/tests/example.test.ts:2 bare recursive rm. Use removeTree.',
  ]);
});

it('reads quoted options keys and only the second call argument', () => {
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'rm(root, { "recursive": true });',
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `rm(root, { ${recursiveTrue}, "maxRetries": 5 });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: true, line: 2 })]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `rm(makeRoot({ maxRetries: 5 }), { ${recursiveTrue} });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `rm(makeRoot({ ${recursiveTrue} }));`,
  ]))).toEqual([]);
});

it('keeps regex literals, template substitutions, and spaced member calls correct', () => {
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    String.raw`const re = /['"]/; rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'const result = `${await rm(root, { ' + recursiveTrue + ' })}`;',
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `other. rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([]);
});
