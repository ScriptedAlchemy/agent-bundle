import { expect, test } from '@rstest/core';

import {
  describeRspackCompileErrors,
  formatRspackStatsError,
  rspackErrorFile,
  rspackErrorLocation,
  rspackErrorText,
  rspackStatsErrors,
} from '../src/dev/compile-diagnostics.js';

const projectRoot = '/work/example';

// Captured verbatim from Rspack 2.2.1 (`stats.toJson({ all: false, errors: true, children: true, moduleTrace: true })`).
const syntaxError = Object.freeze({
  code: 'ModuleBuildError',
  message: '  × Module build failed (from builtin:swc-loader):\n'
    + '  ╰─▶   × Syntax Error: Unexpected token `=`. Expected yield, an identifier, [ or {\n'
    + '         ╭─[3:6]\n'
    + "       1 │ import { nope } from './missing-module';\n"
    + '       2 │ export const x = 1;\n'
    + '       3 │ const = ;\n'
    + '         ·       ─\n'
    + '         ╰────\n'
    + '      \n',
  moduleIdentifier: `builtin:swc-loader??ruleSet[1].rules[2].oneOf[3].use[0]!${projectRoot}/src/bad.ts`,
  moduleName: './src/bad.ts',
  moduleTrace: [],
});

const unresolvedImport = Object.freeze({
  loc: '1:1-41',
  message: `  × Module not found: Can't resolve './missing-module' in '${projectRoot}/src'\n`
    + '   ╭─[1:0]\n'
    + " 1 │ import { nope } from './missing-module';\n"
    + '   · ────────────────────────────────────────\n'
    + ' 2 │ console.log(nope);\n'
    + '   ╰────\n',
  moduleIdentifier: `builtin:swc-loader??ruleSet[1].rules[2].oneOf[3].use[0]!${projectRoot}/src/ok.ts`,
  moduleName: './src/ok.ts',
  moduleTrace: [],
});

test('renders the SWC frame location and strips the miette box from a syntax error', () => {
  expect(rspackErrorLocation(syntaxError)).toEqual({ column: 6, line: 3 });
  expect(rspackErrorText(syntaxError.message)).toBe(
    'Module build failed (from builtin:swc-loader): Syntax Error: Unexpected token `=`. Expected yield, an identifier, [ or {',
  );
  expect(formatRspackStatsError(syntaxError, projectRoot)).toBe(
    'src/bad.ts:3:6: Module build failed (from builtin:swc-loader): Syntax Error: Unexpected token `=`. Expected yield, an identifier, [ or {',
  );
});

test('prefers the 1-based Rspack loc over the frame header and drops the code frame', () => {
  expect(rspackErrorLocation(unresolvedImport)).toEqual({ column: 1, line: 1 });
  expect(formatRspackStatsError(unresolvedImport, projectRoot)).toBe(
    `src/ok.ts:1:1: Module not found: Can't resolve './missing-module' in '${projectRoot}/src'`,
  );
});

test('resolves the file from file, then moduleName, then the loader-stripped identifier', () => {
  expect(rspackErrorFile({ file: 'custom/name.ts', message: '', moduleName: './src/a.ts' }, projectRoot)).toBe('custom/name.ts');
  expect(rspackErrorFile({ message: '', moduleName: './src/a.ts' }, projectRoot)).toBe('src/a.ts');
  expect(rspackErrorFile({
    message: '',
    moduleIdentifier: `builtin:swc-loader??ruleSet[1]!${projectRoot}/src/nested/b.tsx`,
  }, projectRoot)).toBe('src/nested/b.tsx');
  // Modules outside the project root stay absolute so the path remains resolvable.
  expect(rspackErrorFile({ message: '', moduleIdentifier: '/elsewhere/dep/index.js' }, projectRoot)).toBe('/elsewhere/dep/index.js');
  expect(rspackErrorFile({ message: 'no module' }, projectRoot)).toBeUndefined();
});

test('omits the location when Rspack names a module without one and omits the file when it names none', () => {
  expect(formatRspackStatsError({ message: '  × Something failed\n', moduleName: './src/c.ts' }, projectRoot))
    .toBe('src/c.ts: Something failed');
  expect(formatRspackStatsError({ message: '\u001B[31m  × Tsconfig not found: ./does-not-exist.json\u001B[0m\n' }, projectRoot))
    .toBe('Tsconfig not found: ./does-not-exist.json');
});

test('reads a MultiStats document once and falls back to children when the top level lists nothing', () => {
  const multi = {
    children: [
      { errors: [syntaxError], name: 'a' },
      { errors: [unresolvedImport], name: 'b' },
    ],
    errors: [{ ...syntaxError, compilerPath: 'a' }, { ...unresolvedImport, compilerPath: 'b' }],
  };
  expect(rspackStatsErrors(multi)).toHaveLength(2);
  expect(rspackStatsErrors({ children: multi.children, errors: [] })).toHaveLength(2);
  expect(rspackStatsErrors({ children: [{ children: [{ errors: [syntaxError] }] }] })).toHaveLength(1);
  expect(rspackStatsErrors({})).toEqual([]);

  expect(describeRspackCompileErrors(multi, projectRoot)).toBe([
    'RSC runtime compile reported 2 error(s):',
    'src/bad.ts:3:6: Module build failed (from builtin:swc-loader): Syntax Error: Unexpected token `=`. Expected yield, an identifier, [ or {',
    `src/ok.ts:1:1: Module not found: Can't resolve './missing-module' in '${projectRoot}/src'`,
  ].join('\n'));
  expect(describeRspackCompileErrors({ errors: [] }, projectRoot))
    .toBe('RSC runtime compile reported errors, but Rspack stats carried no error details.');
});
