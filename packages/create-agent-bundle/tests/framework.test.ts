import { tmpdir } from 'node:os';

import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { describe, expect, it, layer } from 'effect-rstest';

import {
  assertLocalFrameworkTarball,
  previewPackageSpec,
  resolveFrameworkSpec,
  runtimeSpecForFramework,
  validatedRuntimeSpecForFramework,
} from '../src/framework.ts';
import { UsageError } from '../src/options.ts';
import {
  packageTarball,
  tamperedPackageTarball,
  tamperedTrailingHeaderPackageTarball,
} from './support/package-tarball.ts';

/** A scoped temp directory holding the named tarballs; removed when the test scope closes. */
const tarballDirectory = Effect.fnUntraced(function* (tarballs: Readonly<Record<string, Buffer>>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'create-agent-bundle-tarball-' });
  for (const [name, contents] of Object.entries(tarballs)) {
    yield* fs.writeFile(path.join(directory, name), contents);
  }
  return directory;
});

const expectUsageError = (error: unknown, message?: string): void => {
  expect(error).toBeInstanceOf(UsageError);
  if (message !== undefined) expect((error as Error).message).toContain(message);
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

layer(NodeServices.layer, { excludeTestServices: true })('assertLocalFrameworkTarball', (it) => {
  it.effect('leaves registry and preview specs to npm', () => Effect.gen(function* () {
    expect(yield* assertLocalFrameworkTarball('0.1.0', tmpdir())).toBeUndefined();
    expect(yield* assertLocalFrameworkTarball('next', tmpdir())).toBeUndefined();
    expect(yield* assertLocalFrameworkTarball(
      'https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@da5df1d',
      tmpdir(),
    )).toBeUndefined();
  }));

  it.effect('rejects a local tarball that cannot be read, naming the Node error', () => Effect.gen(function* () {
    const error = yield* Effect.flip(assertLocalFrameworkTarball('file:/tmp/absent-agent-bundle.tgz', tmpdir()));
    // The platform wrapper is peeled off: the message is the ENOENT Node error's.
    expectUsageError(error, 'Cannot inspect local package tarball "file:/tmp/absent-agent-bundle.tgz": ENOENT');
  }));

  it.effect('accepts a well-formed tarball whose tar header checksum is correct', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({ 'agent-bundle-0.0.0.tgz': packageTarball('agent-bundle') });
    const tarball = path.join(directory, 'agent-bundle-0.0.0.tgz');
    expect(yield* assertLocalFrameworkTarball(`file:${tarball}`, directory)).toBeUndefined();
  }));

  it.effect('rejects an inflatable tarball whose tar header checksum does not match', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({ 'agent-bundle-0.0.0.tgz': tamperedPackageTarball('agent-bundle') });
    const tarball = path.join(directory, 'agent-bundle-0.0.0.tgz');
    expectUsageError(yield* Effect.flip(assertLocalFrameworkTarball(`file:${tarball}`, directory)), 'Invalid tar header checksum');
  }));

  it.effect('rejects a tarball whose manifest is valid but a later tar header is corrupt', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({
      'agent-bundle-0.0.0.tgz': tamperedTrailingHeaderPackageTarball('agent-bundle'),
    });
    const tarball = path.join(directory, 'agent-bundle-0.0.0.tgz');
    expectUsageError(yield* Effect.flip(assertLocalFrameworkTarball(`file:${tarball}`, directory)), 'Invalid tar header checksum');
  }));

  it.effect('resolves a relative file: spec against the base directory, not the process working directory', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({ 'agent-bundle-0.0.0.tgz': packageTarball('agent-bundle') });
    const spec = 'file:../agent-bundle-0.0.0.tgz';
    expect(yield* assertLocalFrameworkTarball(spec, path.join(directory, 'project'))).toBeUndefined();
    expectUsageError(yield* Effect.flip(assertLocalFrameworkTarball(spec, process.cwd())));
  }));
});

layer(NodeServices.layer, { excludeTestServices: true })('validatedRuntimeSpecForFramework', (it) => {
  it.effect('leaves registry and preview specs to npm', () => Effect.gen(function* () {
    expect(yield* validatedRuntimeSpecForFramework('0.1.0', tmpdir())).toBe('0.1.0');
  }));

  it.effect('fails closed on the typed usage error when no runtime spec can be derived', () => Effect.gen(function* () {
    expectUsageError(
      yield* Effect.flip(validatedRuntimeSpecForFramework('file:/tmp/framework.tgz', tmpdir())),
      'npm registry version, range, or tag',
    );
  }));

  it.effect('resolves a relative file: pair against the base directory', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({
      'agent-bundle-0.0.0.tgz': packageTarball('agent-bundle'),
      'agent-bundle-runtime-0.0.0.tgz': packageTarball('@agent-bundle/runtime'),
    });
    const spec = 'file:../agent-bundle-0.0.0.tgz';
    expect(yield* validatedRuntimeSpecForFramework(spec, path.join(directory, 'project')))
      .toBe('file:../agent-bundle-runtime-0.0.0.tgz');
    expectUsageError(yield* Effect.flip(validatedRuntimeSpecForFramework(spec, process.cwd())));
  }));

  it.effect('rejects a pair whose runtime tarball has a tampered tar header', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({
      'agent-bundle-0.0.0.tgz': packageTarball('agent-bundle'),
      'agent-bundle-runtime-0.0.0.tgz': tamperedPackageTarball('@agent-bundle/runtime'),
    });
    expectUsageError(
      yield* Effect.flip(validatedRuntimeSpecForFramework(`file:${path.join(directory, 'agent-bundle-0.0.0.tgz')}`, directory)),
      'Invalid tar header checksum',
    );
  }));
});
