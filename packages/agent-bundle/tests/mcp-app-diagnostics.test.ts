import { describe, expect, it } from '@rstest/core';
import type { Rspack } from '@rsbuild/core';

import {
  largestModules,
  MCP_APP_COMPILE_ERROR_CAP,
  MCP_APP_HTML_ADVISORY_BYTES,
  mcpAppCompileErrorDiagnostics,
  mcpAppCompileWarningDiagnostics,
  mcpAppReadableFallbackDiagnostic,
  mcpAppSizeDiagnostic,
  type McpAppDiagnosticContext,
} from '../src/build/mcp-app-diagnostics.ts';
import { MAX_APP_HTML_BYTES } from '../src/core/mcp-app-limits.ts';
import { formatByteSize } from '../src/core/strings.ts';

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

/**
 * The parts of a concatenated module, as Rspack reports them with
 * `orphanModules` on: nested under the module that absorbed them and, flagged
 * orphan, once more at the top level.
 */
const concatenatedParts: readonly Rspack.StatsModule[] = [
  statsModule({ name: './views/status.ts', nameForCondition: '/project/views/status.ts', orphan: true, size: 2_048 }),
  statsModule({ name: './views/StatusPanel.tsx', nameForCondition: '/project/views/StatusPanel.tsx', orphan: true, size: 4_096 }),
  statsModule({ name: './.agent-bundle-virtual/generated/meta.mjs', nameForCondition: '/project/.agent-bundle-virtual/generated/meta.mjs', orphan: true, size: 128 }),
];

const modules: readonly Rspack.StatsModule[] = [
  // A concatenated module: only its parts are ranked, never its summed size.
  statsModule({
    identifier: '/project/views/status.ts + 2 modules',
    modules: [...concatenatedParts],
    name: './views/status.ts + 2 modules',
    orphan: false,
    size: 6_272,
  }),
  ...concatenatedParts,
  // Inlined at its only use and emitted nowhere: an orphan no module absorbed.
  statsModule({ name: './views/constants.ts', nameForCondition: '/project/views/constants.ts', orphan: true, size: 900_000 }),
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

const largestFive = 'node_modules/react-dom/cjs/react-dom-client.production.js (523.5 KiB), node_modules/react/cjs/react.production.js (16.8 KiB), '
  + 'node_modules/scheduler/cjs/scheduler.production.js (9.9 KiB), /shared/theme.css (8.8 KiB), views/StatusPanel.tsx (4 KiB)';

describe('MCP App stats mapping', () => {
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

  it('ranks the largest leaf modules under project-relative, node_modules, or absolute names', () => {
    expect(largestModules(modules, '/project')).toEqual([
      { name: 'node_modules/react-dom/cjs/react-dom-client.production.js', size: 536_016 },
      { name: 'node_modules/react/cjs/react.production.js', size: 17_217 },
      { name: 'node_modules/scheduler/cjs/scheduler.production.js', size: 10_181 },
      { name: '/shared/theme.css', size: 9_000 },
      { name: 'views/StatusPanel.tsx', size: 4_096 },
    ]);
    // Each concatenated part once, through the module that absorbed it; the
    // orphan nothing absorbed is not in the document and never ranks.
    expect(largestModules(modules, '/project', 20).slice(5)).toEqual([
      { name: 'views/status.ts', size: 2_048 },
      { name: 'webpack/runtime/define property getters', size: 300 },
      { name: '.agent-bundle-virtual/generated/meta.mjs', size: 128 },
    ]);
  });

  it('advises on a production view from 1 MiB and on any view past the host bound', () => {
    const size = { bytes: 1_363_149, gzipBytes: 319_895 };
    expect(mcpAppSizeDiagnostic(context, { mode: 'production', modules, size })).toEqual({
      code: 'AB4772',
      message: `MCP App "status" compiled to 1.3 MiB (312.4 KiB gzip), above the 1 MiB advisory bound; largest modules: ${largestFive}`,
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

  it('reports a development substitution with both sizes and the modules behind them', () => {
    expect(mcpAppReadableFallbackDiagnostic(context, {
      modules,
      production: { bytes: 1_363_149, gzipBytes: 319_895 },
      readable: { bytes: 3_670_016, gzipBytes: 700_000 },
    })).toEqual({
      code: 'AB4772',
      message: 'MCP App "status" readable development output compiled to 3.5 MiB, above the 2 MiB bound the Workbench and serve-app '
        + `hosts accept; the preview renders the production build (1.3 MiB, 312.4 KiB gzip) instead; largest modules: ${largestFive}`,
      recovery: 'The preview shows the minified production build; trim the view to read its source in the Workbench.',
      severity: 'warning',
      sourcePath: '/project/views/status.ts',
    });
    expect(mcpAppReadableFallbackDiagnostic(context, {
      modules: [],
      production: { bytes: 512, gzipBytes: 128 },
      readable: { bytes: MAX_APP_HTML_BYTES + 1, gzipBytes: 1 },
    }).message).toMatch(/the preview renders the production build \(512 B, 128 B gzip\) instead$/u);
  });
});
