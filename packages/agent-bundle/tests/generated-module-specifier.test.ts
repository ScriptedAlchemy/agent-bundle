import { posix, win32 } from 'node:path';

import { expect, it } from '@rstest/core';

import { generatedModuleSpecifier } from '../src/build/meta.ts';

it('names a project module relative to the generated-module directory in POSIX form', () => {
  expect(generatedModuleSpecifier('/repo', '/repo/src/events/tool/before.ts', posix)).toBe('../src/events/tool/before.ts');
  expect(generatedModuleSpecifier('/elsewhere/checkout', '/elsewhere/checkout/src/events/tool/before.ts', posix))
    .toBe('../src/events/tool/before.ts');
  expect(generatedModuleSpecifier('C:\\repo', 'C:\\repo\\src\\events\\tool\\before.ts', win32)).toBe('../src/events/tool/before.ts');
});

it('passes bare specifiers and paths outside the project through unchanged', () => {
  expect(generatedModuleSpecifier('/repo', 'agent-bundle/route-registry', posix)).toBe('agent-bundle/route-registry');
  expect(generatedModuleSpecifier('/repo', '/repo-other/src/x.ts', posix)).toBe('/repo-other/src/x.ts');
  expect(generatedModuleSpecifier('/repo', '/repo', posix)).toBe('/repo');
  expect(generatedModuleSpecifier('C:\\repo', 'D:\\repo\\src\\x.ts', win32)).toBe('D:\\repo\\src\\x.ts');
});
