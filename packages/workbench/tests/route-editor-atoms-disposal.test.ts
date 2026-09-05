import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { chromium } from 'playwright';
import { describe, expect, it } from '@rstest/core';

import { createWorkbenchFixtureConfig } from './support/workbench-fixture-config.ts';
import { browserLaunchOptions } from './support/workbench-e2e.ts';

declare global {
  interface Window {
    __routeEditorAtoms: {
      mount(digest: string): void;
      unmount(): void;
    };
  }
}

const contentType = (path: string): string => path.endsWith('.css')
  ? 'text/css'
  : path.endsWith('.js')
    ? 'text/javascript'
    : 'text/html';

const startStaticServer = async (root: string) => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = pathname === '/' ? 'route-editor-atoms-fixture.html' : pathname.slice(1);
    const path = normalize(join(root, file));
    if (relative(root, path).startsWith('..')) {
      response.writeHead(404).end();
      return;
    }
    void readFile(path).then((body) => response.writeHead(200, { 'content-type': contentType(path) }).end(body), () => response.writeHead(404).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Route editor atom fixture did not expose a TCP address.');
  return { server, url: `http://127.0.0.1:${address.port}` };
};

const fixtureSource = (root: string): string => `
  import { RegistryProvider, useAtom } from '@effect/atom-react';
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import type { RouteInputSchema, RouteManifestCliCommand } from ${JSON.stringify(join(root, 'packages/agent-bundle/src/contracts/routes.ts'))};
  import { routeEditorKey, routeEditorStateAtom } from ${JSON.stringify(join(root, 'packages/workbench/src/routes/route-editor-atoms.ts'))};
  import {
    initialRouteEditorState,
    setRouteEditorDraftValue,
    validateRouteEditor,
  } from ${JSON.stringify(join(root, 'packages/workbench/src/routes/routes-model.ts'))};

  const schema = {
    additionalProperties: false,
    properties: { input: { type: 'string' } },
    required: ['input'],
    type: 'object',
  } as RouteInputSchema;
  const command = {
    aliases: [],
    exitCode: 'zero',
    options: [
      { key: 'input', kind: 'string', option: 'input', positional: 0, repeated: false, required: true },
    ],
    path: ['library', 'audit'],
    routeId: 'cli:library/audit',
  } as RouteManifestCliCommand;

  const DraftEditor = ({ digest }: { readonly digest: string }) => {
    const [stored, setStored] = useAtom(routeEditorStateAtom(routeEditorKey(digest, 'cli:library/audit')));
    const state = stored ?? initialRouteEditorState(schema);
    return <section aria-label="Input for cli:library/audit" className="route-input-editor">
      <label htmlFor="route-input">Input (required)
        <input
          id="route-input"
          onChange={(event) => {
            const next = event.currentTarget.value;
            setStored((current) => setRouteEditorDraftValue(
              current ?? initialRouteEditorState(schema),
              schema,
              command,
              'input',
              next,
            ));
          }}
          value={typeof state.draft.input === 'string' ? state.draft.input : ''}
        />
      </label>
      {state.errors.input === undefined ? undefined : <span className="route-input-error" role="alert">{state.errors.input}</span>}
      <button
        onClick={() => setStored((current) => validateRouteEditor(
          current ?? initialRouteEditorState(schema),
          schema,
          command,
        ))}
        type="button"
      >
        Validate input
      </button>
      {state.argv === undefined ? undefined : <label htmlFor="route-argv">Generated argv invocation
        <input id="route-argv" readOnly value={state.argv} />
      </label>}
    </section>;
  };

  const Fixture = () => {
    const [state, setState] = useState({ digest: '', mounted: false });
    window.__routeEditorAtoms = {
      mount: (digest: string) => { setState({ digest, mounted: true }); },
      unmount: () => { setState((current) => ({ ...current, mounted: false })); },
    };
    return state.mounted
      ? <div data-editor-key={routeEditorKey(state.digest, 'cli:library/audit')}>
          <DraftEditor digest={state.digest} />
        </div>
      : <p>Routes unmounted</p>;
  };

  createRoot(document.getElementById('root')!).render(
    <RegistryProvider><Fixture /></RegistryProvider>,
  );
`;

describe('Route editor atoms', () => {
  it('releases editor state across repeated unmounts and digest switches', async () => {
    const root = process.cwd();
    const temp = await mkdtemp(join(root, 'packages/workbench/.route-editor-atoms-'));
    const entry = join(temp, 'route-editor-atoms-fixture.tsx');
    const output = join(temp, 'dist');
    await writeFile(entry, fixtureSource(root));
    const rsbuild = await createRsbuild({
      config: createWorkbenchFixtureConfig({ distRoot: output, entry: { 'route-editor-atoms-fixture': entry } }),
      cwd: root,
    });
    const buildResult = await rsbuild.build();
    await buildResult.close();
    const { server, url } = await startStaticServer(output);
    const browser = await chromium.launch(browserLaunchOptions);
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      await page.goto(url, { timeout: 5_000, waitUntil: 'domcontentloaded' });
      await page.getByText('Routes unmounted', { exact: true }).waitFor({ timeout: 5_000 });

      const cliEditor = page.getByRole('region', { name: 'Input for cli:library/audit' });
      const input = cliEditor.getByLabel('Input (required)');
      const invocation = cliEditor.getByLabel('Generated argv invocation');
      const digestA = 'a'.repeat(64);
      const digestB = 'b'.repeat(64);

      for (let cycle = 1; cycle <= 5; cycle += 1) {
        await page.evaluate(({ digest }) => window.__routeEditorAtoms.mount(digest), { digest: digestA });
        await input.fill(`cycle-${String(cycle)}`);
        await cliEditor.getByRole('button', { name: 'Validate input' }).click();
        await expect.poll(() => invocation.inputValue()).toBe(`library audit cycle-${String(cycle)}`);

        await page.evaluate(() => window.__routeEditorAtoms.unmount());
        await page.getByText('Routes unmounted', { exact: true }).waitFor({ timeout: 5_000 });
        await page.evaluate(({ digest }) => window.__routeEditorAtoms.mount(digest), { digest: digestA });
        await expect.poll(() => input.inputValue()).toBe('');
        await expect.poll(() => invocation.count()).toBe(0);
        await expect.poll(() => cliEditor.locator('.route-input-error').count()).toBe(0);
        await page.evaluate(() => window.__routeEditorAtoms.unmount());
      }

      await page.evaluate(({ digest }) => window.__routeEditorAtoms.mount(digest), { digest: digestA });
      await input.fill('digest-a');
      await cliEditor.getByRole('button', { name: 'Validate input' }).click();
      await expect.poll(() => invocation.inputValue()).toBe('library audit digest-a');
      await page.evaluate(({ digest }) => window.__routeEditorAtoms.mount(digest), { digest: digestB });
      await expect.poll(() => input.inputValue()).toBe('');
      await expect.poll(() => invocation.count()).toBe(0);
      await page.evaluate(({ digest }) => window.__routeEditorAtoms.mount(digest), { digest: digestA });
      await expect.poll(() => input.inputValue()).toBe('');
      await expect.poll(() => invocation.count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(temp, { force: true, recursive: true });
    }
  }, 60_000);
});
