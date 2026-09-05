import { expect, test } from '@rstest/core';

import { describeRspackCompileErrors } from '../src/dev/compile-diagnostics.js';

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

test('renders one project-relative file:line:col line per error under a counted headline', () => {
  // A MultiStats document lists its children's errors once at the top level.
  const multi = {
    children: [
      { errors: [syntaxError], name: 'a' },
      { errors: [unresolvedImport], name: 'b' },
    ],
    errors: [{ ...syntaxError, compilerPath: 'a' }, { ...unresolvedImport, compilerPath: 'b' }],
  };
  const expected = [
    'RSC runtime compile reported 2 error(s):',
    'src/bad.ts:3:6: Module build failed (from builtin:swc-loader): Syntax Error: Unexpected token `=`. Expected yield, an identifier, [ or {',
    `src/ok.ts:1:1: Module not found: Can't resolve './missing-module' in '${projectRoot}/src'`,
  ].join('\n');
  expect(describeRspackCompileErrors(multi, projectRoot)).toBe(expected);
  // An empty top-level list falls back to the children.
  expect(describeRspackCompileErrors({ children: multi.children, errors: [] }, projectRoot)).toBe(expected);
});

test('names a module without a location, and a compilation-level error without a module', () => {
  expect(describeRspackCompileErrors({
    errors: [
      { message: '  × Something failed\n', moduleName: './src/c.ts' },
      { message: '\u001B[31m  × Tsconfig not found: ./does-not-exist.json\u001B[0m\n' },
    ],
  }, projectRoot)).toBe([
    'RSC runtime compile reported 2 error(s):',
    'src/c.ts: Something failed',
    'Tsconfig not found: ./does-not-exist.json',
  ].join('\n'));
});

test('says so when a rejected compile left no stats errors behind', () => {
  expect(describeRspackCompileErrors({ errors: [] }, projectRoot))
    .toBe('RSC runtime compile reported errors, but Rspack stats carried no error details.');
  expect(describeRspackCompileErrors({}, projectRoot))
    .toBe('RSC runtime compile reported errors, but Rspack stats carried no error details.');
});
