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

const localTarballPackageName = async (packageSpec: string): Promise<string> => {
  const path = resolve(packageSpec.slice('file:'.length));
  try {
    const archive = await unzip(await readFile(path));
    for (let offset = 0; offset + 512 <= archive.length;) {
      const header = archive.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
      if (name === '') break;
      const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
      const size = Number.parseInt(sizeText, 8);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Invalid tar entry size "${sizeText}".`);
      }
      const contentsOffset = offset + 512;
      if (name === 'package/package.json') {
        const manifest = JSON.parse(archive.subarray(contentsOffset, contentsOffset + size).toString('utf8')) as {
          readonly name?: unknown;
        };
        if (typeof manifest.name === 'string') return manifest.name;
        throw new Error('Packed package manifest has no string name.');
      }
      offset = contentsOffset + Math.ceil(size / 512) * 512;
    }
    throw new Error('Packed package manifest was not found.');
  } catch (error) {
    throw new UsageError(
      `Cannot inspect local package tarball "${packageSpec}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/** Derives and verifies a coherent local framework/runtime tarball pair. */
export const validatedRuntimeSpecForFramework = async (frameworkSpec: string): Promise<string> => {
  const runtimeSpec = runtimeSpecForFramework(frameworkSpec);
  if (!frameworkSpec.startsWith('file:')) return runtimeSpec;
  const [frameworkName, runtimeName] = await Promise.all([
    localTarballPackageName(frameworkSpec),
    localTarballPackageName(runtimeSpec),
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
