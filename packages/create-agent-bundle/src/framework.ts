import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import { UsageError } from './options.ts';

const previewPattern = /-preview-([0-9a-f]{7,40})$/u;
const npmRegistrySelectorPattern = /^[0-9A-Za-z*._+<>=~^|\-\s]+$/u;
const unzip = promisify(gunzip);

export type PreviewPackageName = 'agent-bundle' | '@agent-bundle/runtime' | 'create-agent-bundle';

export const previewPackageSpec = (packageName: PreviewPackageName, sha: string): string =>
  `https://pkg.pr.new/ScriptedAlchemy/agent-bundle/${packageName}@${sha}`;

export const previewFrameworkSpec = (sha: string): string => previewPackageSpec('agent-bundle', sha);

/**
 * Derives a paired runtime package from an exact preview/local framework
 * build, or reuses an npm version, range, or tag that resolves independently
 * under each package name.
 */
export const runtimeSpecForFramework = (frameworkSpec: string): string => {
  const preview = /^(https:\/\/pkg\.pr\.new\/ScriptedAlchemy\/agent-bundle\/)agent-bundle@([0-9a-f]{7,40})$/u.exec(frameworkSpec);
  if (preview !== null) return `${preview[1]}@agent-bundle/runtime@${preview[2]}`;
  const localTarball = /^(file:(?:.*[/\\])?)agent-bundle(-[^/\\]+)?\.tgz$/u.exec(frameworkSpec);
  if (localTarball !== null) {
    return `${localTarball[1]}agent-bundle-runtime${localTarball[2] ?? ''}.tgz`;
  }
  if (
    frameworkSpec !== ''
    && frameworkSpec.trim() === frameworkSpec
    && npmRegistrySelectorPattern.test(frameworkSpec)
    && !frameworkSpec.endsWith('.tgz')
    && !frameworkSpec.endsWith('.tar.gz')
  ) {
    return frameworkSpec;
  }
  throw new UsageError(
    `Cannot derive a paired @agent-bundle/runtime package from agent-bundle spec "${frameworkSpec}". `
    + 'This package spec cannot be reused for @agent-bundle/runtime. Use an npm registry version, range, or tag; '
    + 'an exact pkg.pr.new preview URL; or a file: tarball '
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

/**
 * `baseDirectory` is the scaffolded project root, because a relative `file:`
 * spec is written verbatim into that project's `package.json` and npm resolves
 * it from there — never from this CLI's working directory.
 */
const localTarballPackageName = async (packageSpec: string, baseDirectory: string): Promise<string> => {
  const path = resolve(baseDirectory, packageSpec.slice('file:'.length));
  try {
    const archive = await unzip(await readFile(path));
    let packageName: string | undefined;
    for (let offset = 0; offset + tarBlockSize <= archive.length;) {
      const header = archive.subarray(offset, offset + tarBlockSize);
      if (isEndOfArchiveBlock(header)) break;
      if (!tarHeaderChecksumMatches(header)) {
        throw new Error(`Invalid tar header checksum at offset ${offset}: the archive is corrupt.`);
      }
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
      if (name === '') break;
      const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
      const size = Number.parseInt(sizeText, 8);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Invalid tar entry size "${sizeText}".`);
      }
      const contentsOffset = offset + tarBlockSize;
      if (name === 'package/package.json') {
        const manifest = JSON.parse(archive.subarray(contentsOffset, contentsOffset + size).toString('utf8')) as {
          readonly name?: unknown;
        };
        if (typeof manifest.name !== 'string') {
          throw new Error('Packed package manifest has no string name.');
        }
        packageName = manifest.name;
      }
      offset = contentsOffset + Math.ceil(size / tarBlockSize) * tarBlockSize;
    }
    if (packageName === undefined) {
      throw new Error('Packed package manifest was not found.');
    }
    return packageName;
  } catch (error) {
    throw new UsageError(
      `Cannot inspect local package tarball "${packageSpec}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

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
export const assertLocalFrameworkTarball = async (frameworkSpec: string, baseDirectory: string): Promise<void> => {
  if (!frameworkSpec.startsWith('file:')) return;
  const frameworkName = await localTarballPackageName(frameworkSpec, baseDirectory);
  if (frameworkName !== 'agent-bundle') {
    throw new UsageError(
      `Local package tarball "${frameworkSpec}" is not the agent-bundle package: expected agent-bundle, `
      + `received ${JSON.stringify(frameworkName)}.`,
    );
  }
};

/**
 * Derives and verifies a coherent local framework/runtime tarball pair,
 * resolving relative `file:` specs against the scaffold target directory.
 */
export const validatedRuntimeSpecForFramework = async (
  frameworkSpec: string,
  baseDirectory: string,
): Promise<string> => {
  const runtimeSpec = runtimeSpecForFramework(frameworkSpec);
  if (!frameworkSpec.startsWith('file:')) return runtimeSpec;
  const [frameworkName, runtimeName] = await Promise.all([
    localTarballPackageName(frameworkSpec, baseDirectory),
    localTarballPackageName(runtimeSpec, baseDirectory),
  ]);
  if (frameworkName !== 'agent-bundle' || runtimeName !== '@agent-bundle/runtime') {
    throw new UsageError(
      `Local package tarballs are not a valid agent-bundle/runtime pair: expected agent-bundle and `
      + `@agent-bundle/runtime, received ${JSON.stringify(frameworkName)} and ${JSON.stringify(runtimeName)}.`,
    );
  }
  return runtimeSpec;
};

/**
 * Resolve the dependency spec the scaffolded project pins `agent-bundle` to.
 *
 * `--framework-version` wins verbatim (a version, a `file:` tarball, or any
 * URL npm accepts). Otherwise the sha is derived from this scaffolder's own
 * preview version: pkg.pr.new publishes every workspace package of one
 * commit under the same `<version>-preview-<sha>` string, so the paired
 * `agent-bundle` preview of the very build that shipped this scaffolder is
 * always the right default. There is no derivable default outside a preview
 * build — the `agent-bundle` name on npm belongs to an unrelated project, so
 * falling back to a semver range would install the wrong package.
 */
export const resolveFrameworkSpec = (ownVersion: string, flag: string | undefined): string => {
  if (flag !== undefined && flag.trim() !== '') return flag.trim();
  const preview = previewPattern.exec(ownVersion);
  if (preview !== null) return previewFrameworkSpec(preview[1]!);
  throw new UsageError(
    `This build of create-agent-bundle (${ownVersion}) is not a pkg.pr.new preview, so it cannot derive `
    + 'a default agent-bundle version. Pass --framework-version <spec> — for example '
    + '--framework-version https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@<sha>.',
  );
};
