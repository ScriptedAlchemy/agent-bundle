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
    bareNames: new Set(['remove']),
    namespaceNames: new Set(),
  });
  expect(removalBindings(`import * as fs from 'node:fs/promises';`)).toEqual({
    bareNames: new Set(),
    namespaceNames: new Set(['fs']),
  });
  expect(removalBindings(`import fs from 'node:fs';`)).toEqual({
    bareNames: new Set(),
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

it('only counts real AST Node fs import bindings', () => {
  // Local identifier named rm is not a Node binding.
  expect(recursiveRmCalls(sample([
    'const rm = async () => undefined;',
    `await rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([]);

  // Non-fs module named rm must not count as Node removal binding.
  expect(removalBindings("import { rm } from 'some-rm-lib';")).toEqual({
    bareNames: new Set(),
    namespaceNames: new Set(),
  });
  expect(recursiveRmCalls(sample([
    "import { rm } from 'some-rm-lib';",
    `await rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([]);

  // Commented-out import must not invent a bare Node binding (false-positive).
  expect(recursiveRmCalls(sample([
    "// import { rm } from 'node:fs/promises';",
    `await rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([]);
  expect(recursiveRmCalls(sample([
    "// import { rm as remove } from 'node:fs/promises';",
    `await remove(root, { ${recursiveTrue} });`,
  ]))).toEqual([]);

  // Comments inside the named import still bind.
  expect(recursiveRmCalls(sample([
    "import { rm /* teardown */ as remove } from 'node:fs/promises';",
    `await remove(root, { ${recursiveTrue} });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  // Default + named form registers both namespace and bare alias.
  expect(removalBindings(`import fs, { rm as remove } from 'node:fs/promises';`)).toEqual({
    bareNames: new Set(['remove']),
    namespaceNames: new Set(['fs']),
  });
  expect(recursiveRmCalls(sample([
    "import fs, { rm as remove } from 'node:fs/promises';",
    `await remove(root, { ${recursiveTrue} });`,
    `await fs.rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([
    expect.objectContaining({ hasRetries: false, line: 2 }),
    expect.objectContaining({ hasRetries: false, line: 3 }),
  ]);
});

it('still gates aliased and namespace Node fs.rm without maxRetries', () => {
  const aliasedBare = recursiveRmCalls(sample([
    "import { rm as remove } from 'node:fs/promises';",
    `await remove(path, { ${recursiveTrue} });`,
  ]));
  expect(aliasedBare).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { rm as remove } from 'node:fs/promises';",
    `await remove(path, { ${recursiveTrue} });`,
  ]))).toEqual([
    'packages/agent-bundle/tests/example.test.ts:2 bare recursive rm. Use removeTree.',
  ]);

  const aliasedRetried = recursiveRmCalls(sample([
    "import { rm as remove } from 'node:fs/promises';",
    `await remove(path, { ${recursiveTrue}, maxRetries: 5 });`,
  ]));
  expect(aliasedRetried).toEqual([expect.objectContaining({ hasRetries: true, line: 2 })]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { rm as remove } from 'node:fs/promises';",
    `await remove(path, { ${recursiveTrue}, maxRetries: 5 });`,
  ]))).toEqual([]);

  const namespacedBare = recursiveRmCalls(sample([
    "import * as fs from 'node:fs/promises';",
    `await fs.rm(path, { ${recursiveTrue} });`,
  ]));
  expect(namespacedBare).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);

  const namespacedRetried = recursiveRmCalls(sample([
    "import * as fs from 'node:fs/promises';",
    `await fs.rm(path, { ${recursiveTrue}, maxRetries: 5 });`,
  ]));
  expect(namespacedRetried).toEqual([expect.objectContaining({ hasRetries: true, line: 2 })]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import * as fs from 'node:fs/promises';",
    `await fs.rm(path, { ${recursiveTrue}, maxRetries: 5 });`,
  ]))).toEqual([]);
});

it('accepts shorthand maxRetries and ignores a shadowed local rm', () => {
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'const maxRetries = 5;',
    `await rm(root, { ${recursiveTrue}, maxRetries });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: true, line: 3 })]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { rm } from 'node:fs/promises';",
    'const maxRetries = 5;',
    `await rm(root, { ${recursiveTrue}, maxRetries });`,
  ]))).toEqual([]);

  const shadowed = sample([
    "import { rm } from 'node:fs';",
    'const cleanup = async () => {',
    '  const rm = async () => undefined;',
    `  await rm(root, { ${recursiveTrue} });`,
    '};',
  ]);
  expect(recursiveRmCalls(shadowed)).toEqual([]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', shadowed)).toEqual([]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs';",
    `await rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
});

it('ignores loop, switch-case, and named function expression shadows only in their scope', () => {
  expect(recursiveRmCalls(sample([
    "import { promises as fs } from 'node:fs';",
    `for (const fs of mockFilesystems) await fs.rm(root, { ${recursiveTrue} });`,
    `for (const [, fs] of entries) { await fs.rm(root, { ${recursiveTrue} }); }`,
    `for (let fs = mock; fs; fs = undefined) await fs.rm(root, { ${recursiveTrue} });`,
    `for (const fs in mocks) await fs.rm(root, { ${recursiveTrue} });`,
    `await fs.rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 6 })]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'switch (mode) {',
    '  case 1:',
    '    const rm = mockRm;',
    `    await rm(root, { ${recursiveTrue} });`,
    '    break;',
    '  default:',
    '    const [rm2, rm] = mocks;',
    `    await rm(root, { ${recursiveTrue} });`,
    '}',
    `const again = async function rm() { await rm(root, { ${recursiveTrue} }); };`,
    `const inner = () => { const rm = mockRm; return rm(root, { ${recursiveTrue} }); };`,
    `await rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 13 })]);
});

it('does not let a parameter shadow a computed method key or decorator', () => {
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'const hooks = {',
    `  [rm(root, { ${recursiveTrue} })](rm) {},`,
    `  async cleanup(rm) { await rm(root, { ${recursiveTrue} }); },`,
    '};',
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 3 })]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'class Suite {',
    `  @hook(rm(root, { ${recursiveTrue} })) run(rm) {}`,
    '}',
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 3 })]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'class Suite {',
    `  run(@hook(rm(root, { ${recursiveTrue} })) rm) {}`,
    `  constructor(@hook(rm(root, { ${recursiveTrue} })) rm) {}`,
    '}',
  ]))).toEqual([
    expect.objectContaining({ hasRetries: false, line: 3 }),
    expect.objectContaining({ hasRetries: false, line: 4 }),
  ]);

  expect(recursiveRmCalls(sample([
    "import * as fs from 'node:fs/promises';",
    `class Suite { run(@hook(fs.rm(root, { ${recursiveTrue} })) fs) {} }`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
});

it('does not let a nested-block var hide a call outside its function', () => {
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    'function setup() { if (ready) { var rm = mockRm; } }',
    `function cleanup() { rm(root, { ${recursiveTrue} }); }`,
    `function reset(done = () => rm(root, { ${recursiveTrue} })) { { var rm = mockRm; } }`,
    `class Suite { static { { var rm = mockRm; } } run() { rm(root, { ${recursiveTrue} }); } }`,
  ]))).toEqual([
    expect.objectContaining({ hasRetries: false, line: 3 }),
    expect.objectContaining({ hasRetries: false, line: 4 }),
    expect.objectContaining({ hasRetries: false, line: 5 }),
  ]);
});

it('parses TSX and JS test files with their own script kind', () => {
  const tsx = sample([
    "import { rm } from 'node:fs/promises';",
    'const view = <div className="root" />;',
    `await rm(root, { ${recursiveTrue} });`,
  ]);
  expect(bareRecursiveRmFailures('packages/workbench/tests/view.test.tsx', tsx)).toEqual([
    'packages/workbench/tests/view.test.tsx:3 bare recursive rm. Use removeTree.',
  ]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/fixture.mjs', sample([
    "import * as fs from 'node:fs/promises';",
    `await fs.rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([
    'packages/agent-bundle/tests/fixture.mjs:2 bare recursive rm. Use removeTree.',
  ]);
});

it('flags promises-namespace and asserted options without maxRetries', () => {
  expect(removalBindings(`import { promises as fs } from 'node:fs';`)).toEqual({
    bareNames: new Set(),
    namespaceNames: new Set(['fs']),
  });
  expect(removalBindings(`import { promises as fs } from 'fs';`)).toEqual({
    bareNames: new Set(),
    namespaceNames: new Set(['fs']),
  });

  const promisesNs = recursiveRmCalls(sample([
    "import { promises as fs } from 'node:fs';",
    `await fs.rm(path, { ${recursiveTrue} });`,
  ]));
  expect(promisesNs).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { promises as fs } from 'node:fs';",
    `await fs.rm(path, { ${recursiveTrue} });`,
  ]))).toEqual([
    'packages/agent-bundle/tests/example.test.ts:2 bare recursive rm. Use removeTree.',
  ]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { promises as fs } from 'node:fs';",
    `await fs.rm(path, { ${recursiveTrue}, maxRetries: 5 });`,
  ]))).toEqual([]);

  const asserted = recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `await rm(root, { ${recursiveTrue} } as const);`,
  ]));
  expect(asserted).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { rm } from 'node:fs/promises';",
    `await rm(root, { ${recursiveTrue} } as const);`,
  ]))).toEqual([
    'packages/agent-bundle/tests/example.test.ts:2 bare recursive rm. Use removeTree.',
  ]);

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `await rm(root, ({ ${recursiveTrue} }));`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `await rm(root, { ${recursiveTrue} } satisfies Options);`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    `await rm(root, <const>{ ${recursiveTrue} });`,
  ]))).toEqual([expect.objectContaining({ hasRetries: false, line: 2 })]);
  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { rm } from 'node:fs/promises';",
    `await rm(root, { ${recursiveTrue}, maxRetries: 5 } as const);`,
    `await rm(root, ({ ${recursiveTrue}, maxRetries: 5 }));`,
    `await rm(root, { ${recursiveTrue}, maxRetries: 5 } satisfies Options);`,
    `await rm(root, <const>{ ${recursiveTrue}, maxRetries: 5 });`,
  ]))).toEqual([]);
});

it('unwraps non-null asserted options, alone and nested in other wrappers', () => {
  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    "import * as fs from 'node:fs/promises';",
    "import { promises as fsp } from 'node:fs';",
    `await rm(root, { ${recursiveTrue} }!);`,
    `await fs.rm(root, { ${recursiveTrue} }!);`,
    `await fsp.rm(root, { ${recursiveTrue} }!);`,
    `await rm(root, ({ ${recursiveTrue} } as const)!);`,
    `await rm(root, { ${recursiveTrue} }! satisfies Options);`,
    `await rm(root, <Options>{ ${recursiveTrue} }!);`,
    `await rm(root, ({ ${recursiveTrue} })<Options>);`,
  ]))).toEqual([4, 5, 6, 7, 8, 9, 10].map((line) => expect.objectContaining({ hasRetries: false, line })));

  expect(bareRecursiveRmFailures('packages/agent-bundle/tests/example.test.ts', sample([
    "import { rm } from 'node:fs/promises';",
    `await rm(root, { ${recursiveTrue}, maxRetries: 5 }!);`,
    `await rm(root, ({ ${recursiveTrue}, maxRetries: 5 } as const)!);`,
  ]))).toEqual([]);
});

it('flags fs.promises.rm and wrapped callees or callee objects', () => {
  const flaggedLines = (count: number) => Array.from(
    { length: count },
    (_, index) => expect.objectContaining({ hasRetries: false, line: index + 4 }),
  );

  expect(recursiveRmCalls(sample([
    "import fs from 'node:fs';",
    "import * as nodeFs from 'node:fs';",
    "import fsp from 'node:fs/promises';",
    `await fs.promises.rm(root, { ${recursiveTrue} });`,
    `await nodeFs.promises.rm(root, { ${recursiveTrue} });`,
    `await fs.promises!.rm(root, { ${recursiveTrue} });`,
    `await (fs.promises as typeof fsp).rm(root, { ${recursiveTrue} });`,
    `await fsp.rm(root, { ${recursiveTrue} });`,
  ]))).toEqual(flaggedLines(5));

  expect(recursiveRmCalls(sample([
    "import { rm } from 'node:fs/promises';",
    "import * as fs from 'node:fs/promises';",
    '',
    `await (rm)(root, { ${recursiveTrue} });`,
    `await rm!(root, { ${recursiveTrue} });`,
    `await (rm as typeof rm)(root, { ${recursiveTrue} });`,
    `await (rm satisfies Remove)(root, { ${recursiveTrue} });`,
    `await (<Remove>rm)(root, { ${recursiveTrue} });`,
    `await ((rm)!)(root, { ${recursiveTrue} });`,
    `await fs!.rm(root, { ${recursiveTrue} });`,
    `await (fs as typeof fs).rm(root, { ${recursiveTrue} });`,
    `await (fs.rm)(root, { ${recursiveTrue} });`,
    `await fs?.rm(root, { ${recursiveTrue} });`,
    `await rm?.(root, { ${recursiveTrue} });`,
  ]))).toEqual(flaggedLines(11));

  expect(recursiveRmCalls(sample([
    "import fs from 'node:fs';",
    "import { rm } from 'node:fs/promises';",
    `function cleanup(fs) { return fs.promises.rm(root, { ${recursiveTrue} }); }`,
    `{ const rm = mockRm; await (rm)!(root, { ${recursiveTrue} }); }`,
    `const reset = (fs) => (fs as Mock)!.rm(root, { ${recursiveTrue} });`,
    `await other.promises.rm(root, { ${recursiveTrue} });`,
    `await fs.other.rm(root, { ${recursiveTrue} });`,
  ]))).toEqual([]);
});
