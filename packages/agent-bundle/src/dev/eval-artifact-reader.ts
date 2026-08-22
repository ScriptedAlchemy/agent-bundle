import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { sha256Hex } from '../core/digest.ts';
import { isInsideOrEqual, isSafePathSegment, sameFile } from '../core/paths.ts';
import type { EvalArtifactReader } from './eval-service-types.ts';

const maximumArtifactBytes = 8 * 1024 * 1024;

export const artifactSegments = (value: unknown): readonly string[] | undefined => {
  if (typeof value !== 'string' || /%(?:2f|5c)/iu.test(value) || value.includes('\\') || value.includes('\0')) {
    return undefined;
  }
  const segments = value.split('/');
  if (
    segments.length < 2 || segments[0] !== 'artifacts' ||
    segments.some((segment) => !isSafePathSegment(segment))
  ) return undefined;
  return Object.freeze(segments);
};

export const assertNoSymlinkedArtifactPath = async (projectRoot: string, target: string): Promise<void> => {
  const root = resolve(projectRoot);
  const resolvedTarget = resolve(target);
  if (!isInsideOrEqual(root, resolvedTarget)) throw new Error('Raw evidence path escaped the project.');
  const segments = relative(root, resolvedTarget).split(/[/\\]/u);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || index < segments.length - 1 && !entry.isDirectory()) {
      throw new Error('Raw evidence path must contain only real directories and a real file.');
    }
  }
};

export class OpenedEvalArtifact implements EvalArtifactReader {
  readonly digest: string;
  readonly filename: string;
  readonly ref: string;
  readonly size: number;
  readonly #bytes: Buffer;
  readonly #onClose: () => void;
  #closePromise: Promise<void> | undefined;

  constructor(options: {
    readonly bytes: Buffer;
    readonly digest: string;
    readonly filename: string;
    readonly onClose: () => void;
    readonly ref: string;
    readonly size: number;
  }) {
    this.digest = options.digest;
    this.filename = options.filename;
    this.#bytes = options.bytes;
    this.#onClose = options.onClose;
    this.ref = options.ref;
    this.size = options.size;
  }

  read(start = 0, end = this.size - 1): Readable {
    if (this.#closePromise !== undefined) throw new Error('Raw evidence reader is closed.');
    if (this.size === 0 && start === 0 && end === -1) return Readable.from([]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= this.size) {
      throw new RangeError('Raw evidence read range is not valid.');
    }
    return Readable.from([Buffer.from(this.#bytes.subarray(start, end + 1))]);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = Promise.resolve().then(() => { this.#onClose(); });
    return this.#closePromise;
  }
}

export const openEvalArtifactSnapshot = async (options: {
  readonly directory: string;
  readonly onClose: (reader: OpenedEvalArtifact) => void;
  readonly projectRoot: string;
  readonly ref: string;
  readonly segments: readonly string[];
}): Promise<OpenedEvalArtifact> => {
  const artifactRoot = join(options.directory, 'artifacts');
  const target = join(options.directory, ...options.segments);
  await assertNoSymlinkedArtifactPath(options.projectRoot, target);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumArtifactBytes) {
    throw new Error('Raw evidence file metadata is not safe.');
  }
  const [physicalRoot, physicalTarget] = await Promise.all([realpath(artifactRoot), realpath(target)]);
  if (!isInsideOrEqual(physicalRoot, physicalTarget)) throw new Error('Raw evidence file escaped its run artifacts directory.');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [after, descriptor] = await Promise.all([lstat(target), file.stat()]);
    if (
      !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.size > maximumArtifactBytes ||
      !descriptor.isFile() || descriptor.nlink !== 1 || descriptor.size > maximumArtifactBytes ||
      !sameFile(before, descriptor) || !sameFile(after, descriptor)
    ) {
      throw new Error('Raw evidence file changed while opening.');
    }
    const bytes = Buffer.alloc(Math.min(descriptor.size, maximumArtifactBytes) + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const final = await file.stat();
    if (!sameFile(descriptor, final) || final.size !== descriptor.size || bytesRead !== descriptor.size || bytesRead > maximumArtifactBytes) {
      throw new Error('Raw evidence file changed while hashing.');
    }
    const snapshot = Buffer.from(bytes.subarray(0, bytesRead));
    await file.close();
    const reader = new OpenedEvalArtifact({
      bytes: snapshot,
      digest: sha256Hex(snapshot),
      filename: basename(options.ref),
      onClose: () => options.onClose(reader),
      ref: options.ref,
      size: descriptor.size,
    });
    return reader;
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
};
