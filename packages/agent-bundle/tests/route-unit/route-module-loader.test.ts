import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { createRouteModuleLoader } from '../../src/dev/routes/route-module-loader.ts';
import { expectDocument } from '../../src/test/matchers.ts';
import { renderRouteEvents } from '../../src/test/render.ts';
import type { AgentRouteModule } from '../../src/test/types.ts';

/**
 * Project code names its TypeScript siblings by their emitted `.js` name. The
 * loader points a `.js` specifier whose source is a `.tsx` file at that file
 * (jiti retries `.ts` on its own, and a real `.js` sibling is loaded as is),
 * and touches nothing but module specifiers: `'./panel.js'` rendered as text
 * stays `./panel.js`, as the compiled program prints it (#600).
 */
const files: Readonly<Record<string, string>> = {
  'count.ts': "export const count = 'from count.ts';\n",
  'label.tsx': "export const label = 'from label.tsx';\n",
  'lazy.tsx': "export const lazy = 'from lazy.tsx';\n",
  'panel.tsx': [
    "import { Agent } from '@agent-bundle/runtime';",
    '',
    'export const Panel = () => <Agent.Text>panel rendered</Agent.Text>;',
    '',
  ].join('\n'),
  'plain.js': "export const plain = 'from plain.js';\n",
  'report.tsx': [
    "import { Agent } from '@agent-bundle/runtime';",
    '',
    "import { Panel } from './panel.js';",
    '',
    "export { count } from './count.js';",
    "export { label } from './label.js';",
    "export { plain } from './plain.js';",
    "export const lazy = () => import('./lazy.js');",
    "export const mention = './panel.js';",
    '',
    'export default async function Report() {',
    '  return (',
    '    <Agent.Result>',
    '      <Panel />',
    "      <Agent.Text>{'./panel.js'}</Agent.Text>",
    '    </Agent.Result>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

interface ReportModule extends AgentRouteModule {
  readonly count: string;
  readonly label: string;
  readonly lazy: () => Promise<{ readonly lazy: string }>;
  readonly mention: string;
  readonly plain: string;
}

let root: string;
let report: ReportModule;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-module-loader-'));
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(root, name), text)));
  report = await createRouteModuleLoader().load<ReportModule>(join(root, 'report.tsx'))();
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

it('resolves a `.js` import whose source is a `.tsx` component and renders the module', async () => {
  const rendered = await renderRouteEvents(report, {
    context: { providers: {} },
    routeId: 'tool:fixture/report',
  });

  expectDocument(rendered)
    .toHaveStatus('success')
    .toContainText('panel rendered')
    .toContainText('./panel.js');
});

it('leaves a string literal outside a module specifier alone', () => {
  expect(report.mention).toBe('./panel.js');
});

it('follows `export … from` and dynamic `import()` specifiers to their `.tsx` source', async () => {
  expect(report.label).toBe('from label.tsx');
  await expect(report.lazy()).resolves.toMatchObject({ lazy: 'from lazy.tsx' });
});

it('loads a `.ts` sibling through jiti and a real `.js` sibling as is', () => {
  expect(report.count).toBe('from count.ts');
  expect(report.plain).toBe('from plain.js');
});
