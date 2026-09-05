import { describe, expect, it } from '@rstest/core';
import type { Rspack } from '@rsbuild/core';

import {
  describeRspackStatsError,
  formatRspackStatsError,
  normalizeStatsMessage,
  rspackStatsErrors,
  statsErrorFile,
  statsErrorLocation,
} from '../src/build/rspack-stats-errors.ts';

const statsError = (overrides: Partial<Rspack.StatsError> & { readonly message: string }): Rspack.StatsError => ({ ...overrides });

// Captured from Rspack 2.2.1 (`stats.toJson({ all: false, errors: true, children: true, moduleTrace: true })`).
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

describe('Rspack stats errors', () => {
  it('flattens an Rspack message to one line of prose', () => {
    expect(normalizeStatsMessage(swcSyntaxError.message))
      .toBe('Module build failed (from builtin:swc-loader): Syntax Error: Expression expected');
    expect(normalizeStatsMessage(unresolvedImportError.message))
      .toBe("Module not found: Can't resolve './missing-module' in '/project/views'");
    expect(normalizeStatsMessage('  × Tsconfig not found /project/does-not-exist.json\n'))
      .toBe('Tsconfig not found /project/does-not-exist.json');
    expect(normalizeStatsMessage('  ⚠ Critical dependency: the request of a dependency is an expression\n'))
      .toBe('Critical dependency: the request of a dependency is an expression');
    expect(normalizeStatsMessage('\u001b[31mfailed\u001b[39m   badly\r\n\n  \u001b[2mdetail\u001b[22m'))
      .toBe('failed badly detail');
  });

  it("locates an entry from Rspack's loc, else the miette header, else the caret under the code frame", () => {
    expect(statsErrorLocation(unresolvedImportError)).toEqual({ column: 1, line: 1 });
    expect(statsErrorLocation(statsError({ loc: '12:5', message: '' }))).toEqual({ column: 5, line: 12 });
    expect(statsErrorLocation(statsError({ loc: '4:1-27', message: '' }))).toEqual({ column: 1, line: 4 });
    expect(statsErrorLocation(statsError({
      message: '  × Syntax Error: Expression expected\n   ╭─[2:10]\n 1 │ export const a = 1;\n 2 │ const x = ;\n   ·           ─\n   ╰────\n',
    }))).toEqual({ column: 10, line: 2 });
    expect(statsErrorLocation(statsError({ message: '  × Syntax Error\n   ╭─[views/status.ts:3:4]\n' }))).toEqual({ column: 4, line: 3 });
    // miette omits the header when the span starts on the first line.
    expect(statsErrorLocation(swcSyntaxError)).toEqual({ column: 10, line: 1 });
    expect(statsErrorLocation(statsError({ message: '  × Tsconfig not found /project/does-not-exist.json\n' }))).toBeUndefined();
    // A malformed loc falls through to the message, and an empty one to nothing.
    expect(statsErrorLocation(statsError({ loc: 'somewhere', message: '  × plain\n' }))).toBeUndefined();
  });

  it('resolves the module like Rsbuild does: file, then module name, then the loader chain target', () => {
    expect(statsErrorFile(statsError({ file: 'views/a.ts', message: '', moduleName: './views/b.ts' }), '/project')).toBe('/project/views/a.ts');
    expect(statsErrorFile(swcSyntaxError, '/project')).toBe('/project/views/status.ts');
    expect(statsErrorFile(statsError({
      message: '',
      moduleIdentifier: 'builtin:swc-loader??ruleSet[1].rules[2].oneOf[3].use[0]!/elsewhere/views/status.ts?raw',
    }), '/project')).toBe('/elsewhere/views/status.ts');
    expect(statsErrorFile(statsError({ message: '', moduleIdentifier: '/project/views/a.css!=!builtin:lightningcss-loader!/project/views/a.css' }), '/project'))
      .toBe('/project/views/a.css');
    expect(statsErrorFile(statsError({ file: '', message: '' }), '/project')).toBeUndefined();
    expect(statsErrorFile(statsError({ message: 'no module' }), '/project')).toBeUndefined();
  });

  it('describes and formats an entry as file:line:column: message, project-relative', () => {
    expect(describeRspackStatsError(unresolvedImportError, '/project')).toEqual({
      file: '/project/views/status.ts',
      location: { column: 1, line: 1 },
      message: "Module not found: Can't resolve './missing-module' in '/project/views'",
    });
    expect(formatRspackStatsError(swcSyntaxError, '/project'))
      .toBe('views/status.ts:1:10: Module build failed (from builtin:swc-loader): Syntax Error: Expression expected');
    // No location: the file alone. No module: the message alone. Outside the root: absolute.
    expect(formatRspackStatsError(statsError({ message: '  × Something failed\n', moduleName: './views/c.ts' }), '/project'))
      .toBe('views/c.ts: Something failed');
    expect(formatRspackStatsError(statsError({ message: '\u001B[31m  × Tsconfig not found: ./does-not-exist.json\u001B[0m\n' }), '/project'))
      .toBe('Tsconfig not found: ./does-not-exist.json');
    expect(formatRspackStatsError(statsError({ message: '  × Module build failed\n', moduleName: '../shared/lib.ts' }), '/project'))
      .toBe('/shared/lib.ts: Module build failed');
  });

  it('reads a MultiStats document once and falls back to the children when the top level lists nothing', () => {
    const multi: Rspack.StatsCompilation = {
      children: [
        { errors: [swcSyntaxError], name: 'a' },
        { errors: [unresolvedImportError], name: 'b' },
      ],
      errors: [swcSyntaxError, unresolvedImportError],
    };
    expect(rspackStatsErrors(multi)).toEqual([swcSyntaxError, unresolvedImportError]);
    expect(rspackStatsErrors({ children: multi.children, errors: [] })).toEqual([swcSyntaxError, unresolvedImportError]);
    expect(rspackStatsErrors({ children: [{ children: [{ errors: [swcSyntaxError] }] }] })).toEqual([swcSyntaxError]);
    expect(rspackStatsErrors({})).toEqual([]);
  });
});
