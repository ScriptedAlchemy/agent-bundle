import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import {
  assertLocalFrameworkTarball,
  previewPackageSpec,
  resolveFrameworkSpec,
  runtimeSpecForFramework,
  validatedRuntimeSpecForFramework,
} from '../src/framework.ts';
import { UsageError } from '../src/options.ts';
import { packageTarball, tamperedPackageTarball } from './support/package-tarball.ts';

const withTarballDirectory = async (
  run: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'create-agent-bundle-tarball-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

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

describe('assertLocalFrameworkTarball', () => {
  it('leaves registry and preview specs to npm', async () => {
    await expect(assertLocalFrameworkTarball('0.1.0', tmpdir())).resolves.toBeUndefined();
    await expect(assertLocalFrameworkTarball('next', tmpdir())).resolves.toBeUndefined();
    await expect(assertLocalFrameworkTarball(
      'https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@da5df1d',
      tmpdir(),
    )).resolves.toBeUndefined();
  });

  it('rejects a local tarball that cannot be read', async () => {
    await expect(assertLocalFrameworkTarball('file:/tmp/absent-agent-bundle.tgz', tmpdir()))
      .rejects.toThrow(UsageError);
  });

  it('accepts a well-formed tarball whose tar header checksum is correct', async () => {
    await withTarballDirectory(async (directory) => {
      const tarball = join(directory, 'agent-bundle-0.0.0.tgz');
      await writeFile(tarball, packageTarball('agent-bundle'));
      await expect(assertLocalFrameworkTarball(`file:${tarball}`, directory)).resolves.toBeUndefined();
    });
  });

  it('rejects an inflatable tarball whose tar header checksum does not match', async () => {
    await withTarballDirectory(async (directory) => {
      const tarball = join(directory, 'agent-bundle-0.0.0.tgz');
      await writeFile(tarball, tamperedPackageTarball('agent-bundle'));
      await expect(assertLocalFrameworkTarball(`file:${tarball}`, directory)).rejects.toThrow(UsageError);
      await expect(assertLocalFrameworkTarball(`file:${tarball}`, directory))
        .rejects.toThrow('Invalid tar header checksum');
    });
  });

  it('resolves a relative file: spec against the base directory, not the process working directory', async () => {
    await withTarballDirectory(async (directory) => {
      await writeFile(join(directory, 'agent-bundle-0.0.0.tgz'), packageTarball('agent-bundle'));
      const spec = 'file:../agent-bundle-0.0.0.tgz';
      await expect(assertLocalFrameworkTarball(spec, join(directory, 'project'))).resolves.toBeUndefined();
      await expect(assertLocalFrameworkTarball(spec, process.cwd())).rejects.toThrow(UsageError);
    });
  });
});

describe('validatedRuntimeSpecForFramework', () => {
  it('leaves registry and preview specs to npm', async () => {
    await expect(validatedRuntimeSpecForFramework('0.1.0', tmpdir())).resolves.toBe('0.1.0');
  });

  it('resolves a relative file: pair against the base directory', async () => {
    await withTarballDirectory(async (directory) => {
      await Promise.all([
        writeFile(join(directory, 'agent-bundle-0.0.0.tgz'), packageTarball('agent-bundle')),
        writeFile(join(directory, 'agent-bundle-runtime-0.0.0.tgz'), packageTarball('@agent-bundle/runtime')),
      ]);
      const spec = 'file:../agent-bundle-0.0.0.tgz';
      await expect(validatedRuntimeSpecForFramework(spec, join(directory, 'project')))
        .resolves.toBe('file:../agent-bundle-runtime-0.0.0.tgz');
      await expect(validatedRuntimeSpecForFramework(spec, process.cwd())).rejects.toThrow(UsageError);
    });
  });

  it('rejects a pair whose runtime tarball has a tampered tar header', async () => {
    await withTarballDirectory(async (directory) => {
      await Promise.all([
        writeFile(join(directory, 'agent-bundle-0.0.0.tgz'), packageTarball('agent-bundle')),
        writeFile(join(directory, 'agent-bundle-runtime-0.0.0.tgz'), tamperedPackageTarball('@agent-bundle/runtime')),
      ]);
      await expect(validatedRuntimeSpecForFramework(`file:${join(directory, 'agent-bundle-0.0.0.tgz')}`, directory))
        .rejects.toThrow('Invalid tar header checksum');
    });
  });
});
