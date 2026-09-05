import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { afterEach, describe, expect, it } from '@rstest/core';
import { init, parse } from 'es-module-lexer';

import type { CompilationEvidence } from '../src/build/compile-result.ts';
import { MCP_APP_HTML_ADVISORY_BYTES } from '../src/build/mcp-app-diagnostics.ts';
import { compileMcpApps, composeMcpAppsRsbuildConfig, type McpAppCompileMode } from '../src/build/mcp-apps.ts';
import { DiagnosticError, type Diagnostic } from '../src/core/diagnostics.ts';
import { MAX_APP_HTML_BYTES } from '../src/core/mcp-app-limits.ts';
import type { AgentBundleToolsConfig, NormalizedMcpApp } from '../src/core/types.ts';
import type { AgentBundleMeta } from '../src/meta.ts';
import { agentBundlePackageRoot, workbenchNodeModules } from './helpers/workspace-paths.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const meta: AgentBundleMeta = Object.freeze({
  name: 'compile-fixture',
  packageName: undefined,
  packageVersion: undefined,
  version: '1.0.0',
});

/** A project root with the workspace's browser dependencies linked in and the given files written. */
const createProject = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-apps-compile-')));
  roots.push(root);
  await symlink(workbenchNodeModules, join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

/** The shape `normalizeProject` (and the Rstest browser preset) hands the compiler, built by hand. */
const app = (
  root: string,
  overrides: { readonly name?: string; readonly source?: string; readonly template?: string } = {},
): NormalizedMcpApp => {
  const name = overrides.name ?? 'status';
  return {
    id: `mcp-app:fixture:${name}`,
    name,
    provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    resourceUri: `ui://compile-fixture/${name}.html`,
    serverId: 'mcp:fixture',
    serverName: 'fixture',
    source: join(root, overrides.source ?? 'views/status.ts'),
    targets: ['portable'],
    ...(overrides.template === undefined ? {} : { template: join(root, overrides.template) }),
  };
};

const compile = async (
  root: string,
  apps: readonly NormalizedMcpApp[],
  options: { readonly mode?: McpAppCompileMode; readonly tools?: AgentBundleToolsConfig } = {},
) => {
  const outDir = join(root, 'dist');
  const result = await compileMcpApps(apps, { cwd: root, meta, outDir, selected: ['portable'], target: 'portable', ...options });
  return { outDir, result };
};

const emittedHtml = async (outDir: string, name = 'status'): Promise<string> =>
  readFile(join(outDir, 'mcp-apps', `${name}.html`), 'utf8');

const compileFailure = async (promise: Promise<unknown>): Promise<readonly Diagnostic[]> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DiagnosticError) return error.diagnostics;
    throw error;
  }
  throw new Error('Expected the MCP App compile to reject with a DiagnosticError.');
};

const compileErrorShape = { code: 'AB4770', severity: 'error' } as const;

const runtimeImportGraph = async (
  entry: string,
): Promise<{ readonly externalSpecifiers: readonly string[]; readonly files: ReadonlyMap<string, string> }> => {
  await init;
  const files = new Map<string, string>();
  const externalSpecifiers: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    const source = await readFile(file, 'utf8');
    files.set(file, source);
    const [imports] = parse(source);
    for (const record of imports) {
      if (record.d === -2) continue;
      if (record.n === undefined) {
        externalSpecifiers.push('<non-literal dynamic import>');
      } else if (record.n.startsWith('.')) {
        queue.push(join(dirname(file), record.n));
      } else {
        externalSpecifiers.push(record.n);
      }
    }
  }
  return { externalSpecifiers: Object.freeze(externalSpecifiers), files };
};

const reactView = {
  'views/StatusPanel.tsx': 'export const Panel = () => <strong className="w">panel-ready</strong>;\n',
  'views/status.ts': [
    "import { createRoot } from 'react-dom/client';",
    "import { Panel } from './StatusPanel';",
    "createRoot(document.getElementById('root')!).render(Panel());",
    '',
  ].join('\n'),
};

describe('compileMcpApps', () => {
  it('bundles agent-bundle/app into one browser-only inline document', async () => {
    const root = await createProject({
      'views/status.ts': [
        "import { createAppClient } from 'agent-bundle/app';",
        "(globalThis as Record<string, unknown>)['createAppClient'] = createAppClient;",
        '',
      ].join('\n'),
    });
    await rm(join(root, 'node_modules'));
    const graph = await runtimeImportGraph(join(agentBundlePackageRoot, 'dist', 'app.js'));
    expect(graph.externalSpecifiers).toEqual([]);
    expect([...graph.files.keys()]).toContain(join(agentBundlePackageRoot, 'dist', 'app.js'));
    expect(graph.files.size).toBeGreaterThan(1);
    expect([...graph.files.keys()].every((file) =>
      file.startsWith(join(agentBundlePackageRoot, 'dist')),
    )).toBe(true);
    const runtimeBytes = [...graph.files.values()].join('\n');
    const forbiddenSharedBytes = [
      /\bnode:/u,
      /["']effect(?:\/|["'])/u,
      /["']zod(?:\/|["'])/u,
      /typescript-5|source-map-support/u,
      /mcp-server-runtime|mcp-schema-projection|mcp-tasks/u,
      /routes\/framework-imports|routes\/public|build\/mcp-apps/u,
    ];
    const forbiddenRuntimeBytes = [
      ...forbiddenSharedBytes,
      /\bprocess\b/u,
      /\brequire\b/u,
      /__webpack_require__/u,
      /\bBuffer\b/u,
      /\bimport\.meta\b/u,
    ];
    expect(forbiddenRuntimeBytes.filter((pattern) => pattern.test(runtimeBytes))).toEqual([]);
    expect(runtimeBytes).toContain('APP_PROTOCOL_VERSION');

    const installedPackage = join(root, 'node_modules', 'agent-bundle');
    await mkdir(installedPackage, { recursive: true });
    await writeFile(join(installedPackage, 'package.json'), await readFile(join(agentBundlePackageRoot, 'package.json')));
    for (const [file, source] of graph.files) {
      const installedFile = join(installedPackage, relative(agentBundlePackageRoot, file));
      await mkdir(dirname(installedFile), { recursive: true });
      await writeFile(installedFile, source);
    }

    const { outDir, result } = await compile(root, [app(root)]);
    const html = await emittedHtml(outDir);
    expect(html).toContain('2026-01-26');
    expect(result.apps[0]!.sourceInputs).toEqual([
      join(root, 'agent-bundle.config.ts'),
      join(root, 'views', 'status.ts'),
    ]);
    expect(result.compileResults).toHaveLength(1);
    expect(result.compileResults[0]!.assets).toEqual([{
      path: 'mcp-apps/status.html',
      sourceInputs: result.apps[0]!.sourceInputs,
    }]);
    expect(await readdir(outDir)).toEqual(['mcp-apps']);
    expect(await readdir(join(outDir, 'mcp-apps'))).toEqual(['status.html']);
    expect(html).toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>/u);
    expect(html).not.toMatch(/<(?:script\b[^>]*\bsrc|link\b[^>]*\bhref)=?/u);
    expect(forbiddenSharedBytes.filter((pattern) => pattern.test(html))).toEqual([]);
  }, 60_000);

  it('compiles a .ts entry that imports a .tsx component to the automatic JSX runtime and measures the view', async () => {
    const root = await createProject(reactView);
    const { outDir, result } = await compile(root, [app(root)]);
    const html = await emittedHtml(outDir);
    // Without the React plugin on a `.ts` entry the component lowered to a
    // free `React.createElement` that no module has in scope.
    expect(html).not.toMatch(/[^.\w]React\.createElement/u);
    expect(html).toContain('panel-ready');
    expect(result.diagnostics).toEqual([]);
    expect(result.apps).toHaveLength(1);
    const [compiled] = result.apps;
    expect(compiled!.size.bytes).toBe(Buffer.byteLength(html, 'utf8'));
    expect(compiled!.size.bytes).toBeGreaterThan(0);
    expect(compiled!.size.gzipBytes).toBeGreaterThan(0);
    expect(compiled!.size.gzipBytes).toBeLessThan(compiled!.size.bytes);
  }, 60_000);

  it('fails a view with AB6005 when a tools.rspack mutator keeps a dependency external, judged from compile evidence', async () => {
    const root = await createProject(reactView);
    const diagnostics = await compileFailure(compile(root, [app(root)], {
      tools: {
        rspack: (config) => {
          config.externals = { 'react-dom/client': 'ReactDOMClient' };
        },
      },
    }));
    expect(diagnostics).toEqual([{
      code: 'AB6005',
      generatedPath: 'mcp-apps/status.html',
      message: 'Compiled MCP App view "mcp-apps/status.html" keeps "ReactDOMClient" external (var), imported as "react-dom/client", from views/status.ts; a view inlines every module it loads.',
      recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
      severity: 'error',
    }]);
  }, 60_000);

  it('records no external for a self-contained view', async () => {
    const root = await createProject(reactView);
    const evidence: CompilationEvidence[] = [];
    const config = composeMcpAppsRsbuildConfig([app(root)], {
      cwd: root,
      meta,
      onCompilationEvidence: (record) => evidence.push(record),
      outDir: join(root, 'dist'),
    });
    const rsbuild = await createRsbuild({ cwd: root, config });
    const result = await rsbuild.build();
    await result.close();
    expect(evidence.map((record) => ({ compiler: record.compiler, externals: record.externals }))).toEqual([
      { compiler: 'status', externals: [] },
    ]);
    expect(evidence.some((record) =>
      record.modules.some((module) => module.resource === join(root, 'views', 'StatusPanel.tsx')),
    )).toBe(true);
  }, 60_000);

  it('reports a syntax error as one AB4770 naming the file and position', async () => {
    const root = await createProject({ 'views/status.ts': 'const x = ;\n' });
    const diagnostics = await compileFailure(compile(root, [app(root)]));
    expect(diagnostics).toEqual([expect.objectContaining({
      ...compileErrorShape,
      recovery: 'Fix the reported error in the named file and rebuild; run `agent-bundle build` for the full message.',
      sourcePath: join(root, 'views', 'status.ts'),
    })]);
    const [diagnostic] = diagnostics;
    expect(diagnostic!.message).toMatch(/^MCP App "status" failed to compile: views\/status\.ts:1:10: /u);
    expect(diagnostic!.message).toContain('Syntax Error: Expression expected');
    // The miette frame is flattened: no box glyphs, no code-frame lines.
    expect(diagnostic!.message).not.toMatch(/[×│·╭╰─]|\n/u);
  }, 60_000);

  it('reports an unresolved import as one AB4770 at the import position', async () => {
    const root = await createProject({
      'views/status.ts': "import { nope } from './missing-module';\nconsole.log(nope);\n",
    });
    const diagnostics = await compileFailure(compile(root, [app(root)]));
    expect(diagnostics).toEqual([expect.objectContaining({
      ...compileErrorShape,
      sourcePath: join(root, 'views', 'status.ts'),
    })]);
    expect(diagnostics[0]!.message).toMatch(/^MCP App "status" failed to compile: views\/status\.ts:1:1: /u);
    expect(diagnostics[0]!.message).toContain("Module not found: Can't resolve './missing-module'");
  }, 60_000);

  it('attributes a compilation error that names no module to the App entry', async () => {
    const root = await createProject({ 'views/status.ts': "document.body.textContent = 'ok';\n" });
    // Rsbuild reports a favicon it cannot read as a compilation error without
    // a module, the same shape as a tsconfig the resolver cannot load.
    const tools: AgentBundleToolsConfig = { rsbuild: { html: { favicon: './assets/missing.ico' } } };
    const diagnostics = await compileFailure(compile(root, [app(root)], { tools }));
    expect(diagnostics).toEqual([expect.objectContaining({
      ...compileErrorShape,
      message: `MCP App "status" failed to compile: [rsbuild:html] Failed to read the favicon file at ${join(root, 'assets', 'missing.ico')}.`,
      sourcePath: join(root, 'views', 'status.ts'),
    })]);
  }, 60_000);

  it('reports a tsconfig the resolver cannot load as one AB4770 naming it, attributed to the App entry', async () => {
    const root = await createProject({
      'tsconfig.json': `${JSON.stringify({ extends: './does-not-exist.json' })}\n`,
      'views/status.ts': "document.body.textContent = 'ok';\n",
    });
    const diagnostics = await compileFailure(compile(root, [app(root)]));
    expect(diagnostics).toEqual([expect.objectContaining({
      ...compileErrorShape,
      sourcePath: join(root, 'views', 'status.ts'),
    })]);
    expect(diagnostics[0]!.message).toMatch(/^MCP App "status" failed to compile: /u);
    expect(diagnostics[0]!.message).toContain(`Tsconfig not found ${join(root, 'does-not-exist.json')}`);
  }, 60_000);

  it('resolves the reserved agent-bundle/meta specifier ahead of a consumer tsconfig paths entry that shadows it', async () => {
    const root = await createProject({
      'stub-meta.ts': "export const name = 'SHADOWED';\n",
      'tsconfig.json': `${JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { 'agent-bundle/meta': ['./stub-meta.ts'] } },
      })}\n`,
      'views/status.ts': "import { name } from 'agent-bundle/meta';\ndocument.body.textContent = `identity:${name}`;\n",
    });
    const { outDir } = await compile(root, [app(root)]);
    const html = await emittedHtml(outDir);
    expect(html).toContain(meta.name);
    expect(html).not.toContain('SHADOWED');
  }, 60_000);

  it('resolves the reserved agent-bundle/app specifier ahead of a consumer tsconfig paths entry that shadows it', async () => {
    const root = await createProject({
      'stub-app.ts': "export const createAppClient = (): string => 'SHADOWED_APP_RUNTIME';\n",
      'tsconfig.json': `${JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { 'agent-bundle/app': ['./stub-app.ts'] } },
      })}\n`,
      'views/status.ts': [
        "import { createAppClient } from 'agent-bundle/app';",
        'document.body.dataset.client = String(createAppClient);',
        '',
      ].join('\n'),
    });
    const { outDir, result } = await compile(root, [app(root)]);
    const html = await emittedHtml(outDir);
    expect(html).toContain('2026-01-26');
    expect(html).not.toContain('SHADOWED_APP_RUNTIME');
    expect(result.apps[0]!.sourceInputs).toEqual([
      join(root, 'agent-bundle.config.ts'),
      join(root, 'views', 'status.ts'),
    ]);
  }, 60_000);

  it('still resolves the author’s own tsconfig paths inside a view', async () => {
    // Winning the reserved specifier must not cost the author their `paths`:
    // Rsbuild's `prefer-alias` strategy would drop them from the view compiler.
    const root = await createProject({
      'lib/greeting.ts': "export const greeting = 'paths-resolved';\n",
      'tsconfig.json': `${JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['./lib/*'] } },
      })}\n`,
      'views/status.ts': "import { greeting } from '@lib/greeting';\ndocument.body.textContent = greeting;\n",
    });
    const { outDir } = await compile(root, [app(root)]);
    expect(await emittedHtml(outDir)).toContain('paths-resolved');
  }, 60_000);

  it('ships document defaults for a template-less view and leaves an authored template alone', async () => {
    const root = await createProject({
      'views/status.ts': "document.body.textContent = 'ok';\n",
      'views/panel.ts': "document.querySelector('#view')!.textContent = 'ok';\n",
      'views/panel.html': '<!doctype html><html lang="de"><head><title>My Panel</title></head><body><main id="view"></main></body></html>\n',
      'views/shell.ts': "document.querySelector('#view')!.textContent = 'ok';\n",
      'views/shell.html': '<!doctype html><html><body><main id="view"></main></body></html>\n',
    });
    const { outDir, result } = await compile(root, [
      app(root),
      app(root, { name: 'panel', source: 'views/panel.ts', template: 'views/panel.html' }),
      app(root, { name: 'shell', source: 'views/shell.ts', template: 'views/shell.html' }),
    ]);
    expect(result.apps.map((compiled) => compiled.name)).toEqual(['status', 'panel', 'shell']);
    expect(result.diagnostics).toEqual([]);

    const status = await emittedHtml(outDir);
    expect(status).toMatch(/<html lang="en">/u);
    expect(status.match(/<title>[^<]*<\/title>/gu)).toEqual(['<title>status</title>']);
    expect(status).toContain('<div id="root"></div>');

    // An authored language and title are the author's.
    const panel = await emittedHtml(outDir, 'panel');
    expect(panel).toMatch(/<html lang="de">/u);
    expect(panel.match(/<title>[^<]*<\/title>/gu)).toEqual(['<title>My Panel</title>']);
    expect(panel).toContain('<main id="view"></main>');
    expect(panel).not.toContain('id="root"');

    // A template that set neither gets the defaults without losing its own body.
    const shell = await emittedHtml(outDir, 'shell');
    expect(shell).toMatch(/<html lang="en">/u);
    expect(shell.match(/<title>[^<]*<\/title>/gu)).toEqual(['<title>shell</title>']);
    expect(shell).toContain('<main id="view"></main>');
  }, 60_000);

  it('exposes only safe Rsbuild defaults to a parameterized authored template', async () => {
    const root = await createProject({
      'views/status.ts': "document.querySelector('#root')!.textContent = 'ok';\n",
      'views/status.html': [
        '<!doctype html><html><head></head>',
        '<body data-entry="<%= entryName %>" data-prefix="<%= assetPrefix %>" data-compilation="<%= typeof compilation %>">',
        '<main id="<%= mountId %>"></main>',
        '</body></html>',
        '',
      ].join(''),
    });
    const { outDir } = await compile(root, [app(root, { template: 'views/status.html' })]);
    const html = await emittedHtml(outDir);
    expect(html).toContain('data-entry="status"');
    expect(html).toContain('data-prefix=""');
    expect(html).toContain('data-compilation="undefined"');
    expect(html).toContain('<main id="root">');
  }, 60_000);

  it('keeps development output readable and one self-contained file, with inline source maps as an opt-in', async () => {
    const files = {
      'views/helper.ts': 'export function veryLongIdentifierName(): number { return 1; }\n',
      'views/status.ts': [
        "import { veryLongIdentifierName } from './helper';",
        "document.body.textContent = String(veryLongIdentifierName());",
        '',
      ].join('\n'),
    };
    const development = await createProject(files);
    const { outDir, result } = await compile(development, [app(development)], { mode: 'development' });
    const html = await emittedHtml(outDir);
    expect(html).toContain('function veryLongIdentifierName()');
    // Rspack's module markers make the readable output navigable.
    expect(html).toContain('// CONCATENATED MODULE: ./views/helper.ts');
    // No map by default: one carrying the sources is ~7× the production
    // bytes, past the host bound for any real view.
    expect(html).not.toContain('sourceMappingURL');
    expect(await readdir(join(outDir, 'mcp-apps'))).toEqual(['status.html']);
    expect(await readdir(outDir)).toEqual(['mcp-apps']);
    expect(result.diagnostics).toEqual([]);

    const mapped = await createProject(files);
    const { outDir: mappedOutDir } = await compile(mapped, [app(mapped)], {
      mode: 'development',
      tools: { rsbuild: { output: { sourceMap: { css: false, js: 'inline-source-map' } } } },
    });
    expect(await emittedHtml(mappedOutDir)).toContain('sourceMappingURL=data:application/json');
    expect(await readdir(mappedOutDir)).toEqual(['mcp-apps']);
    expect(await readdir(join(mappedOutDir, 'mcp-apps'))).toEqual(['status.html']);

    const production = await createProject(files);
    const { outDir: productionOutDir } = await compile(production, [app(production)]);
    const minified = await emittedHtml(productionOutDir);
    expect(minified).not.toContain('sourceMappingURL');
    expect(minified).not.toContain('function veryLongIdentifierName()');
    expect(minified).not.toContain('CONCATENATED MODULE');
  }, 60_000);

  it('refuses external source-map files, naming the stray output', async () => {
    const root = await createProject({ 'views/status.ts': "document.body.textContent = 'ok';\n" });
    await expect(compile(root, [app(root)], {
      mode: 'development',
      tools: { rsbuild: { output: { sourceMap: { css: false, js: 'source-map' } } } },
    })).rejects.toThrow(/beyond the stable self-contained MCP App HTML output: static\/js\/status\.js\.map\. Only inline source maps/u);
  }, 60_000);

  /**
   * Exported functions nobody imports: readable output keeps every one (long
   * names, comments and all — about 3 MiB for 16,000), the production
   * minifier drops them all.
   */
  const readableOnlyPadding = Array.from({ length: 16_000 }, (_, index) => [
    `/** Padding function number ${String(index)} that the readable build keeps and the minifier removes. */`,
    `export function paddingFunctionWithAVeryLongName${String(index)}(): string { return 'padding-${String(index)}'; }`,
  ].join('\n')).join('\n');

  /**
   * A string literal of `bytes` that no profile can shrink: the same size in
   * readable and production output — as long as the view uses the string
   * itself; the minifier folds `blob.length` to a number and drops it.
   */
  const incompressibleModule = (bytes: number): string => `export const blob = '${'x'.repeat(bytes)}';\n`;

  it('falls back to the production profile in development when the readable output would not render in the hosts', async () => {
    const files = {
      'views/padding.ts': `${readableOnlyPadding}\nexport const marker = 'fallback-ready';\n`,
      'views/status.ts': "import { marker } from './padding';\ndocument.body.textContent = marker;\n",
    };
    const root = await createProject(files);
    const { outDir, result } = await compile(root, [app(root)], { mode: 'development' });
    const html = await emittedHtml(outDir);
    expect(html).toContain('fallback-ready');
    expect(html).not.toContain('CONCATENATED MODULE');
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(MAX_APP_HTML_BYTES);
    expect(result.apps[0]!.size.bytes).toBe(Buffer.byteLength(html, 'utf8'));
    expect(result.apps[0]!.output).toBe(join(outDir, 'mcp-apps', 'status.html'));
    expect(await readdir(outDir)).toEqual(['mcp-apps']);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'AB4772',
      recovery: 'The preview shows the minified production build; trim the view to read its source in the Workbench.',
      severity: 'warning',
      sourcePath: join(root, 'views', 'status.ts'),
    })]);
    // The substitution notice names where the readable bytes came from.
    expect(result.diagnostics[0]!.message).toMatch(
      /^MCP App "status" readable development output compiled to \d+(?:\.\d)? MiB, above the 2 MiB bound the Workbench and serve-app hosts accept; the preview renders the production build \(\d+ B, \d+ B gzip\) instead; largest modules: views\/padding\.ts \(\d+(?:\.\d)? MiB\), /u,
    );
    expect(result.diagnostics[0]!.message).toContain('views/status.ts (');
  }, 120_000);

  it('reports one AB4772 for a substituted view whose production build itself draws the advisory', async () => {
    // Readable output: padding plus the blob, past 2 MiB. Production: the
    // blob alone, between the 1 MiB advisory and the 2 MiB host bound.
    const files = {
      'views/blob.ts': incompressibleModule(1_200_000),
      'views/padding.ts': `${readableOnlyPadding}\nexport const marker = 'fallback-ready';\n`,
      'views/status.ts': "import { blob } from './blob';\nimport { marker } from './padding';\ndocument.title = marker;\ndocument.body.textContent = blob;\n",
    };
    const root = await createProject(files);
    const { outDir, result } = await compile(root, [app(root)], { mode: 'development' });
    const bytes = Buffer.byteLength(await emittedHtml(outDir), 'utf8');
    expect(bytes).toBeGreaterThanOrEqual(MCP_APP_HTML_ADVISORY_BYTES);
    expect(bytes).toBeLessThanOrEqual(MAX_APP_HTML_BYTES);
    expect(result.apps[0]!.size.bytes).toBe(bytes);
    // Exactly one size diagnostic: the substitution notice, not also the
    // production compile's own 1 MiB advisory for the same view.
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['AB4772']);
    expect(result.diagnostics[0]!.message).toMatch(
      /^MCP App "status" readable development output compiled to \d+(?:\.\d)? MiB, above the 2 MiB bound the Workbench and serve-app hosts accept; the preview renders the production build \(1\.1 MiB, \d+(?:\.\d)? KiB gzip\) instead; largest modules: views\/padding\.ts \(\d+(?:\.\d)? MiB\), views\/blob\.ts \(1\.1 MiB\)/u,
    );
  }, 120_000);

  it('does not claim a substitution when the production build would not render in the hosts either', async () => {
    const files = {
      'views/blob.ts': incompressibleModule(2_200_000),
      'views/status.ts': "import { blob } from './blob';\ndocument.body.textContent = blob;\n",
    };
    const root = await createProject(files);
    const { outDir, result } = await compile(root, [app(root)], { mode: 'development' });
    const html = await emittedHtml(outDir);
    // The smaller production document is what lands, and it still does not fit.
    expect(html).not.toContain('CONCATENATED MODULE');
    expect(Buffer.byteLength(html, 'utf8')).toBeGreaterThan(MAX_APP_HTML_BYTES);
    expect(result.apps[0]!.size.bytes).toBe(Buffer.byteLength(html, 'utf8'));
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'AB4772',
      recovery: 'Trim the largest modules listed and rebuild; the Workbench and serve-app hosts refuse a view above 2 MiB.',
      severity: 'warning',
      sourcePath: join(root, 'views', 'status.ts'),
    })]);
    // The plain host-bound advisory for the production bytes — no "the preview renders" claim.
    expect(result.diagnostics[0]!.message).toMatch(
      /^MCP App "status" compiled to 2\.1 MiB \(\d+(?:\.\d)? KiB gzip\), above the 2 MiB bound the Workbench and serve-app hosts accept — the view will not render there; largest modules: views\/blob\.ts \(2\.1 MiB\), /u,
    );
    expect(result.diagnostics[0]!.message).toContain('views/status.ts (');
    expect(result.diagnostics[0]!.message).not.toContain('preview renders');
  }, 120_000);

  it('names the largest authored modules in a production advisory, concatenated or not', async () => {
    // Concatenation folds the author's ESM modules into the entry; the
    // advisory still has to name the part that carries the bytes.
    const files = {
      'views/blob.ts': incompressibleModule(1_200_000),
      'views/status.ts': "import { blob } from './blob';\ndocument.body.textContent = blob;\n",
    };
    const root = await createProject(files);
    const { result } = await compile(root, [app(root)]);
    expect(result.apps[0]!.size.bytes).toBeGreaterThanOrEqual(MCP_APP_HTML_ADVISORY_BYTES);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'AB4772', severity: 'warning' })]);
    expect(result.diagnostics[0]!.message).toMatch(
      /^MCP App "status" compiled to 1\.1 MiB \(\d+(?:\.\d)? KiB gzip\), above the 1 MiB advisory bound; largest modules: views\/blob\.ts \(1\.1 MiB\), views\/status\.ts \(\d+ B\)/u,
    );
  }, 60_000);
});

describe('composeMcpAppsRsbuildConfig', () => {
  const source = Object.freeze({ name: 'status', source: '/project/views/status.ts', template: undefined });
  const options = { cwd: '/project', meta, outDir: '/staged/portable' };

  it('keeps the production profile and only overlays readability in development', async () => {
    const production = composeMcpAppsRsbuildConfig([source], options);
    expect(production.mode).toBe('production');
    expect(production.output?.sourceMap).toBe(false);
    expect(production.output?.minify).toBeUndefined();
    expect(production.output?.overrideBrowserslist).toEqual(['Chrome >= 144']);
    // Rsbuild's default alias strategy stays so a view resolves through the
    // author's tsconfig `paths`; the reserved specifier wins by replacement.
    expect(production.resolve).toEqual({ dedupe: ['react', 'react-dom', 'scheduler'] });
    expect(production.environments?.status?.html).toEqual({
      inject: 'body',
      mountId: 'root',
      templateParameters: expect.any(Function),
      title: 'status',
    });
    const templateParameters = production.environments?.status?.html?.templateParameters;
    if (typeof templateParameters !== 'function') throw new Error('Expected MCP App template parameters to be a function.');
    expect(await templateParameters({
      assetPrefix: '/',
      compilation: 'private',
      entryName: 'status',
      htmlPlugin: 'private',
      mountId: 'root',
      rspackConfig: 'private',
    }, { entryName: 'status' })).toEqual({
      assetPrefix: '/',
      entryName: 'status',
      mountId: 'root',
    });

    const development = composeMcpAppsRsbuildConfig([source], { ...options, mode: 'development' });
    expect(development.mode).toBe('production');
    expect(development.output?.sourceMap).toBe(false);
    expect(development.output?.minify).toBe(false);
    expect(development.output?.inlineScripts).toBe(true);
  });
});
