import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import type { CompiledMcpApp } from '../src/build/mcp-apps.ts';
import { writeBrowserTestSetup } from '../src/rstest/browser-setup-module.ts';
import { writeTestMetaModule } from '../src/rstest/meta-module.ts';
import { writeRouteTestSetup } from '../src/rstest/setup-module.ts';
import { testManifestFromRouteGraph } from '../src/test/manifest.ts';
import { emptyCompiledRouteGraph } from '../src/routes/graph.ts';
import { removeTree } from './support/remove-tree.ts';

const payload = 'x'.repeat(1024 * 1024);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTree(root)));
});

const projectRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-module-'));
  roots.push(root);
  return root;
};

const manifestFor = (root: string) => testManifestFromRouteGraph({
  diagnostics: [{ code: 'AB0000', message: payload, severity: 'error' }],
  graph: emptyCompiledRouteGraph,
  projectRoot: root,
});

const writers: ReadonlyArray<readonly [string, (root: string) => Promise<() => Promise<string>>]> = [
  ['writeTestMetaModule', async (root) => {
    const manifest = manifestFor(root);
    return () => writeTestMetaModule(root, manifest);
  }],
  ['writeRouteTestSetup', async (root) => {
    const manifest = manifestFor(root);
    return () => writeRouteTestSetup(root, manifest);
  }],
  ['writeBrowserTestSetup', async (root) => {
    const output = join(root, 'dashboard.html');
    await writeFile(output, payload, 'utf8');
    const app: CompiledMcpApp = {
      id: 'dashboard',
      mimeType: 'text/html;profile=mcp-app',
      name: 'dashboard',
      output,
      resourceUri: 'ui://demo/dashboard',
      serverIds: ['demo'],
      size: { bytes: payload.length, gzipBytes: 0 },
      source: output,
      sourceInputs: [],
      target: 'web',
    };
    return () => writeBrowserTestSetup(root, [app], { dashboard: 'claude' });
  }],
];

describe('generated Rstest modules under concurrent rewrites (#843)', () => {
  it.each(writers)('%s never exposes a partial module to a concurrent reader', async (_name, prepare) => {
    const write = await prepare(await projectRoot());
    const target = await write();
    const complete = await readFile(target, 'utf8');
    expect(complete).toContain(payload);

    const reads: string[] = [];
    let writing = true;
    const read = async (): Promise<void> => {
      while (writing) {
        const content = await readFile(target, 'utf8');
        reads.push(content === complete ? 'complete' : `partial: ${String(content.length)} of ${String(complete.length)} chars`);
      }
    };
    const rewriteLoop = async (): Promise<void> => {
      for (let round = 0; round < 16; round += 1) await write();
    };
    const rewrite = Promise.all([rewriteLoop(), rewriteLoop()]).finally(() => {
      writing = false;
    });
    await Promise.all([rewrite, read(), read(), read()]);

    expect([...new Set(reads)]).toEqual(['complete']);
    expect(await readdir(dirname(target))).toEqual([basename(target)]);
  });
});
