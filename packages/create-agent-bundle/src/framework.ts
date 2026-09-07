import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import { Effect, FileSystem, Path } from 'effect';

import { describeError } from './effect/boundary.ts';
import { liftPromise, liftTry } from './effect/lift.ts';
import { UsageError } from './options.ts';

const previewPattern = /-preview-([0-9a-f]{7,40})$/u;
const npmRegistrySelectorPattern = /^[0-9A-Za-z*._+<>=~^|\-\s]+$/u;
const unzip = promisify(gunzip);

export type PreviewPackageName = 'agent-bundle' | '@agent-bundle/runtime' | 'create-agent-bundle';

export interface FrameworkRuntimePairing {
  readonly framework: string;
  readonly runtime: string;
}

export const runtimePairingFromManifest = (manifest: {
  readonly peerDependencies?: Readonly<Record<string, unknown>>;
  readonly version: string;
}): FrameworkRuntimePairing | undefined => {
  if (previewPattern.test(manifest.version)) return undefined;
  const framework = manifest.peerDependencies?.['agent-bundle'];
  const runtime = manifest.peerDependencies?.['@agent-bundle/runtime'];
  if (typeof framework !== 'string' || typeof runtime !== 'string') return undefined;
  if (framework.startsWith('workspace:') || runtime.startsWith('workspace:')) return undefined;
  return { framework, runtime };
};

export const previewPackageSpec = (packageName: PreviewPackageName, sha: string): string =>
  `https://pkg.pr.new/ScriptedAlchemy/agent-bundle/${packageName}@${sha}`;

export const previewFrameworkSpec = (sha: string): string => previewPackageSpec('agent-bundle', sha);

/**
 * Exact previews pair by commit. Released scaffolders carry the compiler and
 * runtime versions their packed manifest selected from the workspace.
 */
export const runtimeSpecForFramework = (
  frameworkSpec: string,
  pairing?: FrameworkRuntimePairing,
): string => {
  const preview = /^(https:\/\/pkg\.pr\.new\/ScriptedAlchemy\/agent-bundle\/)agent-bundle@([0-9a-f]{7,40})$/u.exec(frameworkSpec);
  if (preview !== null) return `${preview[1]}@agent-bundle/runtime@${preview[2]}`;
  const localTarball = /^(file:(?:.*[/\\])?)agent-bundle(-[^/\\]+)?\.tgz$/u.exec(frameworkSpec);
  if (localTarball !== null) {
    if (localTarball[2] === undefined) return `${localTarball[1]}agent-bundle-runtime.tgz`;
    if (pairing === undefined) {
      throw new UsageError(
        `Cannot select @agent-bundle/runtime for agent-bundle spec "${frameworkSpec}": `
        + 'this create-agent-bundle package has no release pairing metadata.',
      );
    }
    return `${localTarball[1]}agent-bundle-runtime-${pairing.runtime}.tgz`;
  }
  if (
    frameworkSpec !== ''
    && frameworkSpec.trim() === frameworkSpec
    && npmRegistrySelectorPattern.test(frameworkSpec)
    && !frameworkSpec.endsWith('.tgz')
    && !frameworkSpec.endsWith('.tar.gz')
  ) {
    if (pairing === undefined) {
      throw new UsageError(
        `Cannot select @agent-bundle/runtime for agent-bundle spec "${frameworkSpec}": `
        + 'this create-agent-bundle package has no release pairing metadata.',
      );
    }
    if (frameworkSpec !== pairing.framework) {
      throw new UsageError(
        `This create-agent-bundle release is paired with agent-bundle ${pairing.framework} `
        + `and @agent-bundle/runtime ${pairing.runtime}; agent-bundle spec "${frameworkSpec}" may resolve `
        + 'an incompatible compiler. Omit --framework-version or install the matching create-agent-bundle release.',
      );
    }
    return pairing.runtime;
  }
  throw new UsageError(
    `Cannot derive a paired @agent-bundle/runtime package from agent-bundle spec "${frameworkSpec}". `
    + 'This package spec cannot be reused for @agent-bundle/runtime. Use the npm registry version paired '
    + 'with this create-agent-bundle release, an exact pkg.pr.new preview URL, or a file: tarball '
    + 'named agent-bundle.tgz or agent-bundle-<version>.tgz.',
  );
};

const tarBlockSize = 512;
const tarChecksumOffset = 148;
const tarChecksumLength = 8;

/** An all-zero block is the end-of-archive marker, not a header to verify. */
const isEndOfArchiveBlock = (header: Buffer): boolean => !header.some((byte) => byte !== 0);

/**
 * ustar checksums the 512-byte header with its own checksum field read as
 * ASCII spaces. npm packs with node-tar, which writes the unsigned sum, so
 * that is the authoritative value; the historical signed sum is accepted as
 * well, as GNU tar does, so an archive written by an older packer is not
 * reported as corrupt.
 */
const tarHeaderChecksumMatches = (header: Buffer): boolean => {
  const storedText = header
    .subarray(tarChecksumOffset, tarChecksumOffset + tarChecksumLength)
    .toString('ascii')
    .replace(/\0.*$/u, '')
    .trim();
  const stored = Number.parseInt(storedText, 8);
  if (!Number.isSafeInteger(stored)) return false;
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < tarBlockSize; index += 1) {
    if (index >= tarChecksumOffset && index < tarChecksumOffset + tarChecksumLength) {
      unsigned += 0x20;
      signed += 0x20;
      continue;
    }
    unsigned += header[index]!;
    signed += header.readInt8(index);
  }
  return stored === unsigned || stored === signed;
};

interface PackedPackageManifest {
  readonly name: string;
  readonly version: string;
}

const packedPackageManifest = Effect.fnUntraced(function* (
  tarballPath: string,
): Effect.fn.Return<PackedPackageManifest, Error, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const compressed = yield* fs.readFile(tarballPath);
  const archive = yield* liftPromise(() => unzip(compressed));
  let packageManifest: PackedPackageManifest | undefined;
  for (let offset = 0; offset + tarBlockSize <= archive.length;) {
    const header = archive.subarray(offset, offset + tarBlockSize);
    if (isEndOfArchiveBlock(header)) break;
    if (!tarHeaderChecksumMatches(header)) {
      return yield* Effect.fail(new Error(`Invalid tar header checksum at offset ${offset}: the archive is corrupt.`));
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    if (name === '') break;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      return yield* Effect.fail(new Error(`Invalid tar entry size "${sizeText}".`));
    }
    const contentsOffset = offset + tarBlockSize;
    if (name === 'package/package.json') {
      const manifest = yield* liftTry(() => JSON.parse(
        archive.subarray(contentsOffset, contentsOffset + size).toString('utf8'),
      ) as { readonly name?: unknown; readonly version?: unknown });
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
        return yield* Effect.fail(new Error('Packed package manifest has no string name and version.'));
      }
      packageManifest = { name: manifest.name, version: manifest.version };
    }
    offset = contentsOffset + Math.ceil(size / tarBlockSize) * tarBlockSize;
  }
  if (packageManifest === undefined) {
    return yield* Effect.fail(new Error('Packed package manifest was not found.'));
  }
  return packageManifest;
});

/**
 * `baseDirectory` is the scaffolded project root, because a relative `file:`
 * spec is written verbatim into that project's `package.json` and npm resolves
 * it from there — never from this CLI's working directory.
 */
const localTarballPackageManifest = Effect.fnUntraced(function* (
  packageSpec: string,
  baseDirectory: string,
): Effect.fn.Return<PackedPackageManifest, UsageError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  return yield* packedPackageManifest(path.resolve(baseDirectory, packageSpec.slice('file:'.length))).pipe(
    Effect.catch((error) => Effect.fail(
      new UsageError(`Cannot inspect local package tarball "${packageSpec}": ${describeError(error)}`),
    )),
  );
});

/**
 * Verifies a local framework tarball for templates that pin no runtime
 * dependency, so a missing, corrupt, or misnamed archive fails the scaffold
 * instead of surfacing as an install failure — or, under `--no-install`, as a
 * project reported ready with an unusable dependency. Non-`file:` specs stay
 * npm's business: no filesystem read, no registry lookup.
 *
 * `baseDirectory` is the scaffold target directory, so a relative `file:` spec
 * is probed exactly where the emitted `package.json` will point.
 */
export const assertLocalFrameworkTarball = Effect.fnUntraced(function* (
  frameworkSpec: string,
  baseDirectory: string,
): Effect.fn.Return<void, UsageError, FileSystem.FileSystem | Path.Path> {
  if (!frameworkSpec.startsWith('file:')) return;
  const framework = yield* localTarballPackageManifest(frameworkSpec, baseDirectory);
  if (framework.name !== 'agent-bundle') {
    return yield* Effect.fail(new UsageError(
      `Local package tarball "${frameworkSpec}" is not the agent-bundle package: expected agent-bundle, `
      + `received ${JSON.stringify(framework.name)}.`,
    ));
  }
});

/**
 * Derives and verifies a coherent local framework/runtime tarball pair,
 * resolving relative `file:` specs against the scaffold target directory.
 */
export const validatedRuntimeSpecForFramework = Effect.fnUntraced(function* (
  frameworkSpec: string,
  baseDirectory: string,
  pairing?: FrameworkRuntimePairing,
): Effect.fn.Return<string, UsageError, FileSystem.FileSystem | Path.Path> {
  const runtimeSpec = yield* liftTry(() => runtimeSpecForFramework(frameworkSpec, pairing)).pipe(
    Effect.catch((error) => (error instanceof UsageError ? Effect.fail(error) : Effect.die(error))),
  );
  if (!frameworkSpec.startsWith('file:')) return runtimeSpec;
  const [framework, runtime] = yield* Effect.all([
    localTarballPackageManifest(frameworkSpec, baseDirectory),
    localTarballPackageManifest(runtimeSpec, baseDirectory),
  ], { concurrency: 'unbounded' });
  if (framework.name !== 'agent-bundle' || runtime.name !== '@agent-bundle/runtime') {
    return yield* Effect.fail(new UsageError(
      `Local package tarballs are not a valid agent-bundle/runtime pair: expected agent-bundle and `
      + `@agent-bundle/runtime, received ${JSON.stringify(framework.name)} and ${JSON.stringify(runtime.name)}.`,
    ));
  }
  if (pairing !== undefined && (framework.version !== pairing.framework || runtime.version !== pairing.runtime)) {
    return yield* Effect.fail(new UsageError(
      `Local package tarballs do not match this create-agent-bundle release: expected agent-bundle `
      + `${pairing.framework} and @agent-bundle/runtime ${pairing.runtime}, received agent-bundle `
      + `${framework.version} and @agent-bundle/runtime ${runtime.version}.`,
    ));
  }
  return runtimeSpec;
});

/**
 * Resolve the dependency spec the scaffolded project pins `agent-bundle` to.
 *
 * `--framework-version` wins verbatim (a version, a `file:` tarball, or any
 * URL npm accepts). Otherwise the sha is derived from this scaffolder's own
 * preview version: pkg.pr.new publishes every workspace package of one
 * commit under the same `<version>-preview-<sha>` string, so the paired
 * `agent-bundle` preview of the very build that shipped this scaffolder is
 * always the right default. A registry release instead uses the compiler
 * version recorded in its packed pairing metadata.
 */
export const resolveFrameworkSpec = (
  ownVersion: string,
  flag: string | undefined,
  pairing?: FrameworkRuntimePairing,
): string => {
  if (flag !== undefined && flag.trim() !== '') return flag.trim();
  const preview = previewPattern.exec(ownVersion);
  if (preview !== null) return previewFrameworkSpec(preview[1]!);
  if (pairing !== undefined) return pairing.framework;
  throw new UsageError(
    `This build of create-agent-bundle (${ownVersion}) is not a pkg.pr.new preview and has no release `
    + 'pairing metadata, so it cannot derive a default agent-bundle version. Pass --framework-version <spec> — for example '
    + '--framework-version https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@<sha>.',
  );
};
