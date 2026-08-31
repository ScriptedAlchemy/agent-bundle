import { describe, expect, it } from '@rstest/core';

import { resolveFrameworkSpec } from '../src/framework.ts';
import { UsageError } from '../src/options.ts';

describe('resolveFrameworkSpec', () => {
  it('derives the paired pkg.pr.new preview from the scaffolder preview version', () => {
    expect(resolveFrameworkSpec('0.0.0-preview-da5df1d', undefined))
      .toBe('https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@da5df1d');
    expect(resolveFrameworkSpec('0.1.0-preview-66a7961c1b59f24c2baa11e8efd0c9422712c900', undefined))
      .toBe('https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@66a7961c1b59f24c2baa11e8efd0c9422712c900');
  });

  it('lets --framework-version win verbatim', () => {
    expect(resolveFrameworkSpec('0.0.0-preview-da5df1d', 'file:/tmp/agent-bundle.tgz'))
      .toBe('file:/tmp/agent-bundle.tgz');
    expect(resolveFrameworkSpec('0.0.0', ' 0.2.0 ')).toBe('0.2.0');
  });

  it('refuses to guess outside a preview build (the npm agent-bundle name is unrelated)', () => {
    expect(() => resolveFrameworkSpec('0.0.0', undefined)).toThrow(UsageError);
    expect(() => resolveFrameworkSpec('0.0.0', undefined)).toThrow('--framework-version');
  });
});
