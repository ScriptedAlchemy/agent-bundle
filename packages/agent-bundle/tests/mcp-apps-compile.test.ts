import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';
import type { Rspack } from '@rsbuild/core';

import {
  largestModules,
  MCP_APP_COMPILE_ERROR_CAP,
  MCP_APP_HTML_ADVISORY_BYTES,
  mcpAppCompileErrorDiagnostics,
  mcpAppCompileWarningDiagnostics,
  mcpAppSizeDiagnostic,
  normalizeStatsMessage,
  statsErrorFile,
  statsErrorLocation,
  type McpAppDiagnosticContext,
} from '../src/build/mcp-app-diagnostics.ts';
import { compileMcpApps, composeMcpAppsRsbuildConfig, type McpAppCompileMode } from '../src/build/mcp-apps.ts';
import { DiagnosticError, type Diagnostic } from '../src/core/diagnostics.ts';
import { MAX_APP_HTML_BYTES } from '../src/core/mcp-app-limits.ts';
import { formatByteSize } from '../src/core/strings.ts';
import type { AgentBundleToolsConfig, NormalizedMcpApp } from '../src/core/types.ts';
import type { AgentBundleMeta } from '../src/meta.ts';
import { workbenchNodeModules } from './helpers/workspace-paths.ts';

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
  const outDir = join(root, 'dist', 'portable');
  const result = await compileMcpApps(apps, { cwd: root, meta, outDir, target: 'portable', ...options });
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

  it('falls back to the production profile in development when the readable output would not render in the hosts', async () => {
    // Exported functions nobody imports: readable output keeps every one
    // (long names, comments and all), the production minifier drops them.
    const filler = Array.from({ length: 16_000 }, (_, index) => [
      `/** Padding function number ${String(index)} that the readable build keeps and the minifier removes. */`,
      `export function paddingFunctionWithAVeryLongName${String(index)}(): string { return 'padding-${String(index)}'; }`,
    ].join('\n')).join('\n');
    const files = {
      'views/padding.ts': `${filler}\nexport const marker = 'fallback-ready';\n`,
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
    expect(result.diagnostics[0]!.message).toMatch(
      /^MCP App "status" readable development output compiled to \d+(?:\.\d)? MiB, above the 2 MiB bound the Workbench and serve-app hosts accept; the preview renders the production build \(\d+ B, \d+ B gzip\) instead$/u,
    );
  }, 120_000);
});

describe('composeMcpAppsRsbuildConfig', () => {
  const source = Object.freeze({ name: 'status', source: '/project/views/status.ts', template: undefined });
  const options = { cwd: '/project', meta, outDir: '/staged/portable' };

  it('keeps the production profile and only overlays readability in development', () => {
    const production = composeMcpAppsRsbuildConfig([source], options);
    expect(production.mode).toBe('production');
    expect(production.output?.sourceMap).toBe(false);
    expect(production.output?.minify).toBeUndefined();
    // Rsbuild's default alias strategy stays so a view resolves through the
    // author's tsconfig `paths`; the reserved specifier wins by replacement.
    expect(production.resolve).toBeUndefined();
    expect(production.environments?.status?.html).toEqual({ inject: 'body', mountId: 'root', title: 'status' });

    const development = composeMcpAppsRsbuildConfig([source], { ...options, mode: 'development' });
    expect(development.mode).toBe('production');
    expect(development.output?.sourceMap).toBe(false);
    expect(development.output?.minify).toBe(false);
    expect(development.output?.inlineScripts).toBe(true);
  });
});

const context: McpAppDiagnosticContext = Object.freeze({
  appName: 'status',
  entrySource: '/project/views/status.ts',
  projectRoot: '/project',
});

const statsError = (overrides: Partial<Rspack.StatsError> & { readonly message: string }): Rspack.StatsError => ({ ...overrides });

const swcSyntaxError = statsError({
  code: 'ModuleBuildError',
  message: '  × Module build failed (from builtin:swc-loader):\n  ╰─▶   × Syntax Error: Expression expected\n         ╭────\n       1 │ const x = ;\n         ·           ─\n         ╰────\n      \n',
  moduleIdentifier: 'builtin:swc-loader??ruleSet[1].rules[2].oneOf[3].use[0]!/project/views/status.ts',
  moduleName: './views/status.ts',
});

const unresolvedImportError = statsError({
  loc: '1:1-41',
  message: "  × Module not found: Can't resolve './missing-module' in '/project/views'\n   ╭─[1:0]\n 1 │ import { nope } from './missing-module';\n   · ────────────────────────────────────────\n 2 │ console.log(nope);\n   ╰────\n",
  moduleIdentifier: 'builtin:swc-loader??ruleSet[1].rules[2].oneOf[3].use[0]!/project/views/status.ts',
  moduleName: './views/status.ts',
});

describe('MCP App stats mapping', () => {
  it('flattens an Rspack message to one line of prose', () => {
    expect(normalizeStatsMessage(swcSyntaxError.message))
      .toBe('Module build failed (from builtin:swc-loader): Syntax Error: Expression expected');
    expect(normalizeStatsMessage(unresolvedImportError.message))
      .toBe("Module not found: Can't resolve './missing-module' in '/project/views'");
    expect(normalizeStatsMessage('  × Tsconfig not found /project/does-not-exist.json\n'))
      .toBe('Tsconfig not found /project/does-not-exist.json');
    expect(normalizeStatsMessage('\u001b[31mfailed\u001b[39m   badly\r\n\n  \u001b[2mdetail\u001b[22m'))
      .toBe('failed badly detail');
  });

  it("locates an error from Rspack's loc, else the miette header, else the caret under the code frame", () => {
    expect(statsErrorLocation(unresolvedImportError)).toEqual({ column: 1, line: 1 });
    expect(statsErrorLocation(statsError({
      message: '  × Syntax Error: Expression expected\n   ╭─[2:10]\n 1 │ export const a = 1;\n 2 │ const x = ;\n   ·           ─\n   ╰────\n',
    }))).toEqual({ column: 10, line: 2 });
    expect(statsErrorLocation(statsError({ message: '  × Syntax Error\n   ╭─[views/status.ts:3:4]\n' }))).toEqual({ column: 4, line: 3 });
    // miette omits the header when the span starts on the first line.
    expect(statsErrorLocation(swcSyntaxError)).toEqual({ column: 10, line: 1 });
    expect(statsErrorLocation(statsError({ message: '  × Tsconfig not found /project/does-not-exist.json\n' }))).toBeUndefined();
  });

  it('resolves the failing module like Rsbuild does: file, then module name, then the loader chain target', () => {
    expect(statsErrorFile(statsError({ file: 'views/a.ts', message: '', moduleName: './views/b.ts' }), '/project')).toBe('/project/views/a.ts');
    expect(statsErrorFile(swcSyntaxError, '/project')).toBe('/project/views/status.ts');
    expect(statsErrorFile(statsError({
      message: '',
      moduleIdentifier: 'builtin:swc-loader??ruleSet[1].rules[2].oneOf[3].use[0]!/elsewhere/views/status.ts?raw',
    }), '/project')).toBe('/elsewhere/views/status.ts');
    expect(statsErrorFile(statsError({ message: '', moduleIdentifier: '/project/views/a.css!=!builtin:lightningcss-loader!/project/views/a.css' }), '/project'))
      .toBe('/project/views/a.css');
    expect(statsErrorFile(statsError({ file: '', message: '' }), '/project')).toBeUndefined();
  });

  it('renders every stats error as an AB4770 and caps the list per App', () => {
    expect(mcpAppCompileErrorDiagnostics(context, [swcSyntaxError, unresolvedImportError])).toEqual([
      {
        code: 'AB4770',
        message: 'MCP App "status" failed to compile: views/status.ts:1:10: Module build failed (from builtin:swc-loader): Syntax Error: Expression expected',
        recovery: 'Fix the reported error in the named file and rebuild; run `agent-bundle build` for the full message.',
        severity: 'error',
        sourcePath: '/project/views/status.ts',
      },
      expect.objectContaining({
        message: "MCP App \"status\" failed to compile: views/status.ts:1:1: Module not found: Can't resolve './missing-module' in '/project/views'",
      }),
    ]);
    // A module outside the project root shows absolutely; no module at all falls back to the entry.
    expect(mcpAppCompileErrorDiagnostics(context, [
      statsError({ message: '  × Module build failed\n', moduleName: '../shared/lib.ts' }),
      statsError({ message: '  × Tsconfig not found /project/does-not-exist.json\n' }),
    ])).toEqual([
      expect.objectContaining({ message: 'MCP App "status" failed to compile: /shared/lib.ts: Module build failed', sourcePath: '/shared/lib.ts' }),
      expect.objectContaining({
        message: 'MCP App "status" failed to compile: Tsconfig not found /project/does-not-exist.json',
        sourcePath: '/project/views/status.ts',
      }),
    ]);

    const many = Array.from({ length: MCP_APP_COMPILE_ERROR_CAP + 3 }, (_, index) =>
      statsError({ message: `  × failure ${String(index)}\n`, moduleName: './views/status.ts' }));
    const capped = mcpAppCompileErrorDiagnostics(context, many);
    expect(capped).toHaveLength(MCP_APP_COMPILE_ERROR_CAP);
    expect(capped[MCP_APP_COMPILE_ERROR_CAP - 2]!.message).toContain(`failure ${String(MCP_APP_COMPILE_ERROR_CAP - 2)}`);
    expect(capped[MCP_APP_COMPILE_ERROR_CAP - 1]).toEqual(expect.objectContaining({
      code: 'AB4770',
      message: 'MCP App "status" failed to compile: … and 4 more errors (run the compile with logLevel error via tools.rsbuild for the full list)',
      sourcePath: '/project/views/status.ts',
    }));
    expect(mcpAppCompileErrorDiagnostics(context, many.slice(0, MCP_APP_COMPILE_ERROR_CAP))).toHaveLength(MCP_APP_COMPILE_ERROR_CAP);
  });

  it('renders warnings as AB4771 minus the ignore list', () => {
    const warning = statsError({
      loc: '3:1-40',
      message: '  ⚠ Critical dependency: the request of a dependency is an expression\n',
      moduleName: './views/status.ts',
    });
    const noise = statsError({ message: '  ⚠ \u001b[33mnoise\u001b[39m: something nobody can act on\n', moduleName: './views/status.ts' });
    // Ignore patterns see the normalised text, so an entry reads like the message it silences.
    expect(mcpAppCompileWarningDiagnostics(context, [warning, noise], [/^noise: /u])).toEqual([{
      code: 'AB4771',
      message: 'MCP App "status" produced a warning while compiling: views/status.ts:3:1: Critical dependency: the request of a dependency is an expression',
      recovery: 'Address the reported warning in the named file and rebuild; run `agent-bundle build` for the full message.',
      severity: 'warning',
      sourcePath: '/project/views/status.ts',
    }]);
    // The default ignore list is empty: every warning surfaces.
    expect(mcpAppCompileWarningDiagnostics(context, [warning, noise])).toHaveLength(2);
    expect(mcpAppCompileWarningDiagnostics(context, [])).toEqual([]);
  });

  it('formats sizes 1024-based with one decimal, the same helper the CLI prints with', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(437_000)).toBe('426.8 KiB');
    expect(formatByteSize(1_048_576)).toBe('1 MiB');
    expect(formatByteSize(1_363_149)).toBe('1.3 MiB');
  });

  const statsModule = (overrides: Partial<Rspack.StatsModule> & { readonly size: number }): Rspack.StatsModule => ({
    built: true,
    buildTimeExecuted: false,
    cached: false,
    codeGenerated: true,
    moduleType: 'javascript/auto',
    sizes: { javascript: overrides.size },
    type: 'module',
    ...overrides,
  });

  const modules: readonly Rspack.StatsModule[] = [
    // A concatenated module: only its parts are ranked, never its summed size.
    statsModule({
      identifier: '/project/views/status.ts + 2 modules',
      modules: [
        statsModule({ name: './views/status.ts', nameForCondition: '/project/views/status.ts', size: 2_048 }),
        statsModule({ name: './views/StatusPanel.tsx', nameForCondition: '/project/views/StatusPanel.tsx', size: 4_096 }),
        statsModule({ name: './.agent-bundle-virtual/generated/meta.mjs', nameForCondition: '/project/.agent-bundle-virtual/generated/meta.mjs', size: 128 }),
      ],
      name: './views/status.ts + 2 modules',
      size: 6_272,
    }),
    statsModule({
      name: '../../workspace/node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/cjs/react-dom-client.production.js',
      nameForCondition: '/workspace/node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/cjs/react-dom-client.production.js',
      size: 536_016,
    }),
    statsModule({ name: '../../workspace/node_modules/.pnpm/react@19.2.8/node_modules/react/cjs/react.production.js', nameForCondition: '/workspace/node_modules/.pnpm/react@19.2.8/node_modules/react/cjs/react.production.js', size: 17_217 }),
    statsModule({ name: '../shared/theme.css', nameForCondition: '/shared/theme.css', size: 9_000 }),
    statsModule({ moduleType: 'runtime', name: 'webpack/runtime/define property getters', size: 300 }),
    statsModule({ name: '../../workspace/node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler/cjs/scheduler.production.js', nameForCondition: '/workspace/node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler/cjs/scheduler.production.js', size: 10_181 }),
  ];

  it('ranks the largest leaf modules under project-relative, node_modules, or absolute names', () => {
    expect(largestModules(modules, '/project')).toEqual([
      { name: 'node_modules/react-dom/cjs/react-dom-client.production.js', size: 536_016 },
      { name: 'node_modules/react/cjs/react.production.js', size: 17_217 },
      { name: 'node_modules/scheduler/cjs/scheduler.production.js', size: 10_181 },
      { name: '/shared/theme.css', size: 9_000 },
      { name: 'views/StatusPanel.tsx', size: 4_096 },
    ]);
    expect(largestModules(modules, '/project', 7).slice(5)).toEqual([
      { name: 'views/status.ts', size: 2_048 },
      { name: 'webpack/runtime/define property getters', size: 300 },
    ]);
  });

  it('advises on a production view from 1 MiB and on any view past the host bound', () => {
    const size = { bytes: 1_363_149, gzipBytes: 319_895 };
    expect(mcpAppSizeDiagnostic(context, { mode: 'production', modules, size })).toEqual({
      code: 'AB4772',
      message: 'MCP App "status" compiled to 1.3 MiB (312.4 KiB gzip), above the 1 MiB advisory bound; largest modules: '
        + 'node_modules/react-dom/cjs/react-dom-client.production.js (523.5 KiB), node_modules/react/cjs/react.production.js (16.8 KiB), '
        + 'node_modules/scheduler/cjs/scheduler.production.js (9.9 KiB), /shared/theme.css (8.8 KiB), views/StatusPanel.tsx (4 KiB)',
      recovery: 'Trim the largest modules listed and rebuild; the Workbench and serve-app hosts refuse a view above 2 MiB.',
      severity: 'warning',
      sourcePath: '/project/views/status.ts',
    });
    // The advisory is a production concern: readable development output is larger by design.
    expect(mcpAppSizeDiagnostic(context, { mode: 'development', modules, size: { bytes: 1_572_864, gzipBytes: 400_000 } })).toBeUndefined();
    expect(mcpAppSizeDiagnostic(context, { mode: 'production', modules, size: { bytes: MCP_APP_HTML_ADVISORY_BYTES - 1, gzipBytes: 1 } })).toBeUndefined();
    expect(mcpAppSizeDiagnostic(context, { mode: 'production', modules: [], size: { bytes: MCP_APP_HTML_ADVISORY_BYTES, gzipBytes: 1 } })).toEqual(
      expect.objectContaining({ message: 'MCP App "status" compiled to 1 MiB (1 B gzip), above the 1 MiB advisory bound' }),
    );

    const hostRefusal = ', above the 2 MiB bound the Workbench and serve-app hosts accept — the view will not render there';
    for (const mode of ['development', 'production'] as const) {
      const diagnostic = mcpAppSizeDiagnostic(context, { mode, modules, size: { bytes: MAX_APP_HTML_BYTES + 1, gzipBytes: 500_000 } });
      expect(diagnostic?.code).toBe('AB4772');
      expect(diagnostic?.message).toContain(`compiled to 2 MiB (488.3 KiB gzip)${hostRefusal}; largest modules: node_modules/react-dom`);
    }
    // Exactly the host bound still renders there; production still gets the advisory.
    expect(mcpAppSizeDiagnostic(context, { mode: 'development', modules, size: { bytes: MAX_APP_HTML_BYTES, gzipBytes: 1 } })).toBeUndefined();
    expect(mcpAppSizeDiagnostic(context, { mode: 'production', modules, size: { bytes: MAX_APP_HTML_BYTES, gzipBytes: 1 } })?.message)
      .toContain('above the 1 MiB advisory bound');
  });
});
