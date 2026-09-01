import { describe, expect, it } from '@rstest/core';

import { previewPackageSpec, resolveFrameworkSpec, runtimeSpecForFramework } from '../src/framework.ts';
import { UsageError } from '../src/options.ts';

describe('previewPackageSpec', () => {
  it('derives the renamed runtime pkg.pr.new URL', () => {
    expect(previewPackageSpec('@agent-bundle/runtime', 'da5df1d'))
      .toBe('https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/runtime@da5df1d');
  });
});

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

describe('runtimeSpecForFramework', () => {
  it('pairs preview and local tarball framework specs with the runtime package', () => {
    expect(runtimeSpecForFramework('https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@da5df1d'))
      .toBe('https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/runtime@da5df1d');
    expect(runtimeSpecForFramework('file:/tmp/agent-bundle-0.1.0.tgz'))
      .toBe('file:/tmp/agent-bundle-runtime-0.1.0.tgz');
    expect(runtimeSpecForFramework('file:/tmp/agent-bundle.tgz'))
      .toBe('file:/tmp/agent-bundle-runtime.tgz');
  });

  it('mirrors npm registry framework specs onto the runtime package', () => {
    expect(runtimeSpecForFramework('0.1.0')).toBe('0.1.0');
    expect(runtimeSpecForFramework('^0.1.0')).toBe('^0.1.0');
    expect(runtimeSpecForFramework('>=0.1.0 <1')).toBe('>=0.1.0 <1');
    expect(runtimeSpecForFramework('1.x')).toBe('1.x');
    expect(runtimeSpecForFramework('next')).toBe('next');
  });

  it('rejects package specs that cannot resolve independently under the runtime name', () => {
    const unsupportedSpecs = [
      'https://example.com/agent-bundle.tgz',
      'git+ssh://git@github.com/ScriptedAlchemy/agent-bundle.git',
      'github:ScriptedAlchemy/agent-bundle',
      'npm:@scope/agent-bundle@1.0.0',
      '/tmp/agent-bundle.tgz',
      '../agent-bundle',
      'agent-bundle.tgz',
      'agent-bundle.tar.gz',
    ];
    for (const spec of unsupportedSpecs) {
      expect(() => runtimeSpecForFramework(spec)).toThrow(UsageError);
      expect(() => runtimeSpecForFramework(spec)).toThrow('cannot be reused for @agent-bundle/runtime');
    }
  });

  it('fails closed when a paired runtime spec cannot be derived', () => {
    expect(() => runtimeSpecForFramework('file:/tmp/framework.tgz')).toThrow(UsageError);
    expect(() => runtimeSpecForFramework('file:/tmp/framework.tgz')).toThrow('npm registry version, range, or tag');
  });
});
