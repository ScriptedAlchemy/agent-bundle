import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { describe, expect, it, layer } from 'effect-rstest';

import {
  assertLocalFrameworkTarball,
  previewPackageSpec,
  resolveFrameworkSpec,
  runtimePairingFromManifest,
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

const releasePairing = { framework: '0.2.0', runtime: '0.1.0' } as const;

it('reads release pairing metadata but ignores source and preview peer rewrites', () => {
  expect(runtimePairingFromManifest({
    peerDependencies: {
      '@agent-bundle/runtime': '0.1.0',
      'agent-bundle': '0.2.0',
    },
    version: '0.1.0',
  })).toEqual(releasePairing);
  expect(runtimePairingFromManifest({
    peerDependencies: {
      '@agent-bundle/runtime': '0.0.0-preview-da5df1d',
      'agent-bundle': '0.0.0-preview-da5df1d',
    },
    version: '0.0.0-preview-da5df1d',
  })).toBeUndefined();
  expect(runtimePairingFromManifest({
    peerDependencies: {
      '@agent-bundle/runtime': 'workspace:*',
      'agent-bundle': 'workspace:*',
    },
    version: '0.0.0',
  })).toBeUndefined();
});

it('declares the compiler/runtime release pair as optional workspace peers', async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'packages/create-agent-bundle/package.json'), 'utf8'),
  ) as {
    readonly peerDependencies: Record<string, string>;
    readonly peerDependenciesMeta: Record<string, { readonly optional?: boolean }>;
  };
  expect(manifest.peerDependencies).toMatchObject({
    '@agent-bundle/runtime': 'workspace:*',
    'agent-bundle': 'workspace:*',
  });
  expect(manifest.peerDependenciesMeta).toMatchObject({
    '@agent-bundle/runtime': { optional: true },
    'agent-bundle': { optional: true },
  });
});

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
    expect(resolveFrameworkSpec('0.0.0-preview-da5df1d', 'file:/tmp/agent-bundle.tgz', releasePairing))
      .toBe('file:/tmp/agent-bundle.tgz');
    expect(resolveFrameworkSpec('0.1.0', ' 0.2.0 ', releasePairing)).toBe('0.2.0');
  });

  it('pins the compiler selected by an installed registry scaffolder', () => {
    expect(resolveFrameworkSpec('0.1.0', undefined, releasePairing)).toBe('0.2.0');
  });

  it('refuses to guess outside a preview build (the npm agent-bundle name is unrelated)', () => {
    expect(() => resolveFrameworkSpec('0.0.0', undefined)).toThrow(UsageError);
    expect(() => resolveFrameworkSpec('0.0.0', undefined)).toThrow('--framework-version');
  });
});

describe('runtimeSpecForFramework', () => {
  it('keeps previews on their exact SHA and uses the recorded runtime version for local tarballs', () => {
    expect(runtimeSpecForFramework(
      'https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@da5df1d',
      releasePairing,
    ))
      .toBe('https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/runtime@da5df1d');
    expect(runtimeSpecForFramework('file:/tmp/agent-bundle-0.2.0.tgz', releasePairing))
      .toBe('file:/tmp/agent-bundle-runtime-0.1.0.tgz');
    expect(runtimeSpecForFramework('file:/tmp/agent-bundle.tgz', releasePairing))
      .toBe('file:/tmp/agent-bundle-runtime.tgz');
    expect(runtimeSpecForFramework('file:/tmp/agent-bundle.tgz'))
      .toBe('file:/tmp/agent-bundle-runtime.tgz');
  });

  it('selects the recorded runtime version for the paired registry compiler', () => {
    expect(runtimeSpecForFramework('0.2.0', releasePairing)).toBe('0.1.0');
  });

  it('rejects a registry compiler outside the installed scaffolder pairing', () => {
    expect(() => runtimeSpecForFramework('0.1.0', releasePairing)).toThrow(UsageError);
    expect(() => runtimeSpecForFramework('0.1.0', releasePairing))
      .toThrow('paired with agent-bundle 0.2.0 and @agent-bundle/runtime 0.1.0');
  });

  it('never copies a registry compiler selector when pairing metadata is absent', () => {
    expect(() => runtimeSpecForFramework('0.2.0')).toThrow(UsageError);
    expect(() => runtimeSpecForFramework('0.2.0')).toThrow('same-SHA pkg.pr.new URL');
    expect(() => runtimeSpecForFramework('file:/tmp/agent-bundle-0.2.0.tgz'))
      .toThrow('agent-bundle.tgz and agent-bundle-runtime.tgz');
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
      expect(() => runtimeSpecForFramework(spec, releasePairing)).toThrow(UsageError);
      expect(() => runtimeSpecForFramework(spec, releasePairing)).toThrow('cannot be reused for @agent-bundle/runtime');
    }
  });

  it('fails closed when a paired runtime spec cannot be derived', () => {
    expect(() => runtimeSpecForFramework('file:/tmp/framework.tgz', releasePairing)).toThrow(UsageError);
    expect(() => runtimeSpecForFramework('file:/tmp/framework.tgz', releasePairing)).toThrow('npm registry version');
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
  it.effect('selects the installed scaffolder runtime for its registry compiler', () => Effect.gen(function* () {
    expect(yield* validatedRuntimeSpecForFramework('0.2.0', tmpdir(), releasePairing)).toBe('0.1.0');
  }));

  it.effect('rejects a registry compiler outside the installed scaffolder pairing', () => Effect.gen(function* () {
    expectUsageError(
      yield* Effect.flip(validatedRuntimeSpecForFramework('0.1.0', tmpdir(), releasePairing)),
      'paired with agent-bundle 0.2.0 and @agent-bundle/runtime 0.1.0',
    );
  }));

  it.effect('fails closed on the typed usage error when no runtime spec can be derived', () => Effect.gen(function* () {
    expectUsageError(
      yield* Effect.flip(validatedRuntimeSpecForFramework('file:/tmp/framework.tgz', tmpdir())),
      'npm registry version paired with this create-agent-bundle release',
    );
  }));

  it.effect('resolves a relative file: pair against the base directory', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({
      'agent-bundle-0.2.0.tgz': packageTarball('agent-bundle', '0.2.0'),
      'agent-bundle-runtime-0.1.0.tgz': packageTarball('@agent-bundle/runtime', '0.1.0'),
    });
    const spec = 'file:../agent-bundle-0.2.0.tgz';
    expect(yield* validatedRuntimeSpecForFramework(spec, path.join(directory, 'project'), releasePairing))
      .toBe('file:../agent-bundle-runtime-0.1.0.tgz');
    expectUsageError(yield* Effect.flip(validatedRuntimeSpecForFramework(spec, process.cwd(), releasePairing)));
  }));

  it.effect('rejects a runtime tarball whose package version violates the recorded pairing', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({
      'agent-bundle-0.2.0.tgz': packageTarball('agent-bundle', '0.2.0'),
      'agent-bundle-runtime-0.1.0.tgz': packageTarball('@agent-bundle/runtime', '0.2.0'),
    });
    expectUsageError(
      yield* Effect.flip(validatedRuntimeSpecForFramework(
        `file:${path.join(directory, 'agent-bundle-0.2.0.tgz')}`,
        directory,
        releasePairing,
      )),
      'expected agent-bundle 0.2.0 and @agent-bundle/runtime 0.1.0, '
      + 'received agent-bundle 0.2.0 and @agent-bundle/runtime 0.2.0',
    );
  }));

  it.effect('rejects a pair whose runtime tarball has a tampered tar header', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* tarballDirectory({
      'agent-bundle-0.2.0.tgz': packageTarball('agent-bundle', '0.2.0'),
      'agent-bundle-runtime-0.1.0.tgz': tamperedPackageTarball('@agent-bundle/runtime', '0.1.0'),
    });
    expectUsageError(
      yield* Effect.flip(validatedRuntimeSpecForFramework(
        `file:${path.join(directory, 'agent-bundle-0.2.0.tgz')}`,
        directory,
        releasePairing,
      )),
      'Invalid tar header checksum',
    );
  }));
});
