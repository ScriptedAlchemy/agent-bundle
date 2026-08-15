import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { digest, stableJson } from '../core/digest.ts';
import { freezeJsonValue, type JsonObject, type JsonValue } from './types.ts';

const manifestFileName = 'generation.manifest.json';
const defaultRetainInactive = 5;

export interface RuntimeGenerationAsset {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

export interface RuntimeGenerationMetadataCodec<TMetadata> {
  decode(value: JsonValue): TMetadata;
  encode(value: TMetadata): JsonValue;
}

export interface RuntimeGenerationManifestInput<TMetadata = unknown> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly metadata: TMetadata;
}

export interface RuntimeGenerationManifest<TMetadata = unknown> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly createdAt: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly metadata: TMetadata;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationValidationInput<TMetadata> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly metadata: TMetadata;
  readonly root: string;
}

export type RuntimeGenerationValidator<TMetadata> = (
  input: RuntimeGenerationValidationInput<TMetadata>,
) => Promise<TMetadata> | TMetadata;

export interface RuntimeGenerationActivationGuard<TMetadata> {
  wait(manifest: RuntimeGenerationManifest<TMetadata>): Promise<void>;
  check(manifest: RuntimeGenerationManifest<TMetadata>): boolean;
}

export interface RuntimeGenerationPrepareOptions<TMetadata> {
  readonly guard?: RuntimeGenerationActivationGuard<TMetadata>;
}

export interface RuntimeGenerationCandidate {
  readonly id: string;
  readonly root: string;
  readonly sequence: number;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationPreparedActivation<TMetadata = unknown> {
  readonly generation: RuntimeGeneration<TMetadata>;
  readonly sequence: number;
}

export interface RuntimeGeneration<TMetadata = unknown> {
  readonly id: string;
  readonly manifest: RuntimeGenerationManifest<TMetadata>;
  readonly root: string;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationLease<TMetadata = unknown> {
  readonly generation: RuntimeGeneration<TMetadata>;
  release(): Promise<void>;
}

export interface RuntimeGenerationStoreOptions<TMetadata> {
  readonly metadataCodec: RuntimeGenerationMetadataCodec<TMetadata>;
  readonly now?: () => Date;
  /** Test seam for cleanup failures; production callers use recursive `rm`. */
  readonly remove?: (path: string) => Promise<void>;
  readonly retainInactive?: number;
  readonly storageRoot: string;
  readonly validateMetadata: RuntimeGenerationValidator<TMetadata>;
}

export interface RuntimeGenerationCloseFailure {
  readonly error: unknown;
  readonly path: string;
}

export class RuntimeGenerationStoreCloseError extends Error {
  readonly failures: readonly RuntimeGenerationCloseFailure[];

  constructor(failures: readonly RuntimeGenerationCloseFailure[]) {
    super('Runtime generation store could not release every path.');
    this.name = 'RuntimeGenerationStoreCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

export type RuntimeGenerationStoreErrorCode =
  | 'RUNTIME_GENERATION_CLOSED'
  | 'RUNTIME_GENERATION_CONFLICT'
  | 'RUNTIME_GENERATION_INVALID'
  | 'RUNTIME_GENERATION_NOT_FOUND'
  | 'RUNTIME_GENERATION_SUPERSEDED';

export class RuntimeGenerationStoreError extends Error {
  readonly code: RuntimeGenerationStoreErrorCode;

  constructor(code: RuntimeGenerationStoreErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeGenerationStoreError';
    this.code = code;
  }
}

interface CandidateRecord {
  readonly candidate: RuntimeGenerationCandidate;
  state: 'staging' | 'preparing' | 'prepared' | 'failed';
}

interface PreparedRecord<TMetadata> {
  readonly candidate: CandidateRecord;
  readonly prepared: RuntimeGenerationPreparedActivation<TMetadata>;
}

interface CommittedRecord<TMetadata> {
  readonly generation: RuntimeGeneration<TMetadata>;
  pruning: boolean;
  readonly sequence: number;
  references: number;
}

interface DiskManifest {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly createdAt: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly metadata: JsonValue;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
}

const invalid = (message: string): RuntimeGenerationStoreError =>
  new RuntimeGenerationStoreError('RUNTIME_GENERATION_INVALID', message);

const closed = (): RuntimeGenerationStoreError =>
  new RuntimeGenerationStoreError('RUNTIME_GENERATION_CLOSED', 'Runtime generation store is closed.');

const superseded = (): RuntimeGenerationStoreError =>
  new RuntimeGenerationStoreError('RUNTIME_GENERATION_SUPERSEDED', 'Runtime generation candidate was superseded.');

const conflict = (message: string): RuntimeGenerationStoreError =>
  new RuntimeGenerationStoreError('RUNTIME_GENERATION_CONFLICT', message);

const notFound = (id: string): RuntimeGenerationStoreError =>
  new RuntimeGenerationStoreError('RUNTIME_GENERATION_NOT_FOUND', `Runtime generation ${JSON.stringify(id)} was not found.`);

const bytesSha256 = (value: Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const isSafeSegment = (value: string): boolean =>
  value.length > 0 && value !== '.' && value !== '..' &&
  !value.includes('/') && !value.includes('\\') && !value.includes('\0');

const normalizedAssetPath = (value: string): string => {
  if (value.length === 0 || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw invalid('Runtime generation asset paths must be relative slash-separated paths.');
  }

  const segments = value.split('/');
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw invalid('Runtime generation asset paths cannot escape their candidate root.');
  }

  return segments.join('/');
};

const assertInside = (root: string, candidate: string): void => {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const path = relative(normalizedRoot, normalizedCandidate);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw invalid('Runtime generation path escaped its candidate root.');
  }
};

const freezeAssets = (input: readonly RuntimeGenerationAsset[]): readonly RuntimeGenerationAsset[] => {
  const paths = new Set<string>();
  const assets = input.map((asset) => {
    const path = normalizedAssetPath(asset.path);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0) {
      throw invalid(`Runtime generation asset ${JSON.stringify(path)} has an invalid byte length.`);
    }
    if (!/^[a-f0-9]{64}$/u.test(asset.sha256)) {
      throw invalid(`Runtime generation asset ${JSON.stringify(path)} has an invalid SHA-256 digest.`);
    }
    if (path === manifestFileName) {
      throw invalid(`Runtime generation asset ${JSON.stringify(path)} conflicts with reserved metadata.`);
    }
    if (paths.has(path)) {
      throw invalid(`Runtime generation manifest contains duplicate asset ${JSON.stringify(path)}.`);
    }
    paths.add(path);
    return Object.freeze({ bytes: asset.bytes, path, sha256: asset.sha256 });
  });

  return Object.freeze(assets.sort((left, right) => left.path.localeCompare(right.path)));
};

const freezeMetadata = <TMetadata>(value: TMetadata, seen = new WeakSet<object>()): TMetadata => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      freezeMetadata(descriptor.value, seen);
    }
  }

  return Object.freeze(value);
};

const jsonObject = (value: JsonValue, message: string): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(message);
  return value as JsonObject;
};

const jsonArray = (value: JsonValue | undefined, message: string): readonly JsonValue[] => {
  if (!Array.isArray(value)) throw invalid(message);
  return value;
};

const jsonString = (value: JsonValue | undefined, message: string): string => {
  if (typeof value !== 'string') throw invalid(message);
  return value;
};

const jsonNumber = (value: JsonValue | undefined, message: string): number => {
  if (typeof value !== 'number') throw invalid(message);
  return value;
};

const parseAssets = (value: JsonValue | undefined): readonly RuntimeGenerationAsset[] => {
  const assets = jsonArray(value, 'Runtime generation manifest assets are malformed.').map((entry) => {
    const asset = jsonObject(entry, 'Runtime generation manifest asset is malformed.');
    return Object.freeze({
      bytes: jsonNumber(asset.bytes, 'Runtime generation manifest asset bytes are malformed.'),
      path: jsonString(asset.path, 'Runtime generation manifest asset path is malformed.'),
      sha256: jsonString(asset.sha256, 'Runtime generation manifest asset digest is malformed.'),
    });
  });
  return freezeAssets(assets);
};

const fsync = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'EINVAL' && code !== 'EPERM') throw error;
  } finally {
    await handle.close();
  }
};

/**
 * Provider-neutral immutable generations. The store accepts only JSON through
 * a provider-supplied codec and never interprets provider metadata keys.
 */
export class RuntimeGenerationStore<TMetadata = unknown> {
  readonly #candidates = new WeakMap<RuntimeGenerationCandidate, CandidateRecord>();
  readonly #committed = new Map<string, CommittedRecord<TMetadata>>();
  readonly #generationsRoot: string;
  readonly #metadataCodec: RuntimeGenerationMetadataCodec<TMetadata>;
  readonly #now: () => Date;
  #prepared = new Map<RuntimeGenerationPreparedActivation<TMetadata>, PreparedRecord<TMetadata>>();
  readonly #remove: (path: string) => Promise<void>;
  readonly #retainInactive: number;
  readonly #stagingRoot: string;
  readonly #storageRoot: string;
  readonly #validateMetadata: RuntimeGenerationValidator<TMetadata>;
  #activeId: string | undefined;
  #cleanupFailures: RuntimeGenerationCloseFailure[] = [];
  #cleanupScheduled = false;
  #cleanupTail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #closeState: 'open' | 'closing' | 'closed' = 'open';
  #initialized = false;
  #initialization: Promise<void> | undefined;
  #newestSequence = 0;

  constructor(options: RuntimeGenerationStoreOptions<TMetadata>) {
    if (!Number.isSafeInteger(options.retainInactive ?? defaultRetainInactive) || (options.retainInactive ?? defaultRetainInactive) < 0) {
      throw new TypeError('retainInactive must be a nonnegative safe integer.');
    }
    if (typeof options.metadataCodec.decode !== 'function' || typeof options.metadataCodec.encode !== 'function') {
      throw new TypeError('Runtime generation metadata codec must provide encode and decode functions.');
    }
    if (typeof options.validateMetadata !== 'function') {
      throw new TypeError('Runtime generation metadata validator must be a function.');
    }

    this.#storageRoot = resolve(options.storageRoot);
    this.#stagingRoot = join(this.#storageRoot, 'staging');
    this.#generationsRoot = join(this.#storageRoot, 'generations');
    this.#metadataCodec = options.metadataCodec;
    this.#validateMetadata = options.validateMetadata;
    this.#now = options.now ?? (() => new Date());
    this.#retainInactive = options.retainInactive ?? defaultRetainInactive;
    this.#remove = options.remove ?? (async (path) => rm(path, { force: true, recursive: true }));
  }

  active(): RuntimeGeneration<TMetadata> | undefined {
    return this.#activeId === undefined ? undefined : this.#committed.get(this.#activeId)?.generation;
  }

  async begin(input: Readonly<{ readonly id: string; readonly sourceRevision: string }>): Promise<RuntimeGenerationCandidate> {
    this.#assertOpen();
    await this.#initialize();
    this.#assertOpen();

    if (!isSafeSegment(input.id)) throw invalid('Runtime generation id must be a single nonempty path segment.');
    if (input.sourceRevision.length === 0) throw invalid('Runtime generation source revision must not be empty.');
    if (this.#committed.has(input.id)) throw conflict(`Runtime generation ${JSON.stringify(input.id)} already exists.`);

    const sequence = this.#newestSequence + 1;
    this.#newestSequence = sequence;
    const root = join(this.#stagingRoot, `${sequence}-${input.id}`);
    assertInside(this.#stagingRoot, root);
    try {
      await mkdir(root, { recursive: false });
    } catch (error) {
      throw error instanceof RuntimeGenerationStoreError
        ? error
        : conflict(`Runtime generation candidate ${JSON.stringify(input.id)} could not reserve staging.`);
    }

    const candidate = Object.freeze({
      id: input.id,
      root,
      sequence,
      sourceRevision: input.sourceRevision,
    });
    this.#candidates.set(candidate, { candidate, state: 'staging' });
    return candidate;
  }

  async prepare(
    candidate: RuntimeGenerationCandidate,
    input: RuntimeGenerationManifestInput<TMetadata>,
    options: RuntimeGenerationPrepareOptions<TMetadata> = {},
  ): Promise<RuntimeGenerationPreparedActivation<TMetadata>> {
    this.#assertOpen();
    const record = this.#candidate(candidate);
    this.#assertCurrent(record);
    if (record.state !== 'staging') throw conflict('Runtime generation candidate is not available for preparation.');
    record.state = 'preparing';

    let renamedRoot: string | undefined;
    try {
      const assets = freezeAssets(input.assets);
      await this.#validateAssetTree(candidate.root, assets, false);

      const validatedMetadata = freezeMetadata(await this.#validateMetadata(Object.freeze({
        assets,
        metadata: input.metadata,
        root: candidate.root,
      })));
      const metadata = freezeJsonValue(this.#metadataCodec.encode(validatedMetadata));
      const manifestWithoutDigest = Object.freeze({
        assets,
        createdAt: this.#now().toISOString(),
        id: candidate.id,
        metadata,
        schemaVersion: 1 as const,
        sourceRevision: candidate.sourceRevision,
      });
      const diskManifest = Object.freeze({
        ...manifestWithoutDigest,
        manifestDigest: digest(manifestWithoutDigest),
      });
      const manifestPath = join(candidate.root, manifestFileName);
      assertInside(candidate.root, manifestPath);
      await writeFile(manifestPath, stableJson(diskManifest), { encoding: 'utf8', flag: 'wx' });
      await fsync(manifestPath);
      await fsync(candidate.root);

      const provisional = this.#manifestFromDisk(diskManifest, metadata);
      const destination = join(this.#generationsRoot, candidate.id);
      assertInside(this.#generationsRoot, destination);
      await lstat(destination).then(
        () => { throw conflict(`Runtime generation ${JSON.stringify(candidate.id)} already exists.`); },
        (error: unknown) => {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      const guard = options.guard;
      if (guard !== undefined) {
        await guard.wait(provisional);
        if (!guard.check(provisional)) throw superseded();
      }
      this.#assertCurrent(record);

      await rename(candidate.root, destination);
      renamedRoot = destination;
      const generation = await this.#readGeneration(destination, candidate.id, candidate.sourceRevision);
      if (guard !== undefined) {
        await guard.wait(generation.manifest);
        if (!guard.check(generation.manifest)) throw superseded();
      }
      this.#assertCurrent(record);

      const prepared = Object.freeze({ generation, sequence: candidate.sequence });
      this.#prepared.set(prepared, { candidate: record, prepared });
      record.state = 'prepared';
      return prepared;
    } catch (error) {
      record.state = 'failed';
      await this.#removeNeverPublic(renamedRoot ?? candidate.root);
      if (error instanceof RuntimeGenerationStoreError) throw error;
      throw invalid('Runtime generation preparation failed.');
    }
  }

  canCommit(prepared: RuntimeGenerationPreparedActivation<TMetadata>): boolean {
    if (this.#closed || !this.#initialized) return false;
    const record = this.#prepared.get(prepared);
    return record !== undefined &&
      record.prepared === prepared &&
      record.candidate.state === 'prepared' &&
      record.candidate.candidate.sequence === this.#newestSequence;
  }

  commit(prepared: RuntimeGenerationPreparedActivation<TMetadata>): RuntimeGeneration<TMetadata> {
    if (!this.canCommit(prepared)) {
      if (this.#closed) throw closed();
      throw superseded();
    }

    const record = this.#prepared.get(prepared);
    if (record === undefined) throw superseded();
    const generation = record.prepared.generation;
    this.#prepared.delete(prepared);
    record.candidate.state = 'prepared';
    this.#committed.set(generation.id, {
      generation,
      pruning: false,
      references: 0,
      sequence: record.candidate.candidate.sequence,
    });
    this.#activeId = generation.id;
    this.#requestCleanup();
    return generation;
  }

  async abort(prepared: RuntimeGenerationPreparedActivation<TMetadata>): Promise<void> {
    const record = this.#prepared.get(prepared);
    if (record === undefined) return;
    this.#prepared.delete(prepared);
    record.candidate.state = 'failed';
    await this.#removeNeverPublic(prepared.generation.root);
  }

  async fail(candidate: RuntimeGenerationCandidate): Promise<void> {
    const record = this.#candidate(candidate);
    if (record.state === 'prepared') {
      throw conflict('Prepared runtime generations must be aborted with their prepared activation token.');
    }
    record.state = 'failed';
    await this.#removeNeverPublic(candidate.root);
  }

  async lease(id?: string): Promise<RuntimeGenerationLease<TMetadata>> {
    this.#assertOpen();
    await this.#initialize();
    this.#assertOpen();

    const generationId = id ?? this.#activeId;
    if (generationId === undefined) throw notFound('(active)');
    const record = this.#committed.get(generationId);
    if (record === undefined || record.pruning) throw notFound(generationId);
    record.references += 1;

    let released = false;
    return Object.freeze({
      generation: record.generation,
      release: async () => {
        if (released) return;
        released = true;
        record.references -= 1;
        if (record.references < 0) {
          record.references = 0;
          throw new Error('Runtime generation lease reference count underflowed.');
        }
        await this.#enqueueCleanup();
      },
    });
  }

  close(): Promise<void> {
    if (this.#closeState === 'closing') return this.#closePromise!;
    if (this.#closeState === 'closed') return Promise.resolve();

    this.#closeState = 'closing';
    this.#closed = true;
    const closePromise = this.#closeInternal().then(
      () => { this.#closeState = 'closed'; },
      (error: unknown) => {
        this.#closeState = 'closed';
        throw error;
      },
    );
    this.#closePromise = closePromise;
    return closePromise;
  }

  async #closeInternal(): Promise<void> {
    const failures: RuntimeGenerationCloseFailure[] = [];

    if (this.#initialization !== undefined) {
      try {
        await this.#initialization;
      } catch (error) {
        failures.push(Object.freeze({ error, path: this.#storageRoot }));
      }
    }

    const prepared = Array.from(this.#prepared.values());
    this.#prepared = new Map<RuntimeGenerationPreparedActivation<TMetadata>, PreparedRecord<TMetadata>>();
    for (const record of prepared) {
      record.candidate.state = 'failed';
      await this.#removeWithFailure(record.prepared.generation.root, failures);
    }
    await this.#removeWithFailure(this.#stagingRoot, failures);
    if (this.#cleanupScheduled) {
      this.#cleanupScheduled = false;
      await this.#enqueueCleanup();
    }
    await this.#cleanupTail;
    failures.push(...this.#cleanupFailures.splice(0));

    if (failures.length > 0) throw new RuntimeGenerationStoreCloseError(failures);
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    if (this.#initialization === undefined) {
      this.#initialization = (async () => {
        await mkdir(this.#storageRoot, { recursive: true });
        await this.#remove(this.#stagingRoot);
        await this.#remove(this.#generationsRoot);
        await Promise.all([
          mkdir(this.#stagingRoot, { recursive: true }),
          mkdir(this.#generationsRoot, { recursive: true }),
        ]);
        this.#initialized = true;
      })();
    }
    try {
      await this.#initialization;
    } catch (error) {
      this.#initialization = undefined;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw closed();
  }

  #candidate(candidate: RuntimeGenerationCandidate): CandidateRecord {
    const record = this.#candidates.get(candidate);
    if (record === undefined || record.candidate !== candidate) {
      throw conflict('Runtime generation candidate was not created by this store.');
    }
    return record;
  }

  #assertCurrent(record: CandidateRecord): void {
    this.#assertOpen();
    if (record.candidate.sequence !== this.#newestSequence || record.state === 'failed') throw superseded();
  }

  #manifestFromDisk(
    manifest: Readonly<{
      readonly assets: readonly RuntimeGenerationAsset[];
      readonly createdAt: string;
      readonly id: string;
      readonly manifestDigest: string;
      readonly metadata: JsonValue;
      readonly schemaVersion: 1;
      readonly sourceRevision: string;
    }>,
    metadata: JsonValue,
  ): RuntimeGenerationManifest<TMetadata> {
    const decoded = freezeMetadata(this.#metadataCodec.decode(metadata));
    return Object.freeze({
      assets: manifest.assets,
      createdAt: manifest.createdAt,
      id: manifest.id,
      manifestDigest: manifest.manifestDigest,
      metadata: decoded,
      schemaVersion: manifest.schemaVersion,
      sourceRevision: manifest.sourceRevision,
    });
  }

  async #readGeneration(
    root: string,
    expectedId: string,
    expectedSourceRevision: string,
  ): Promise<RuntimeGeneration<TMetadata>> {
    const manifestPath = join(root, manifestFileName);
    assertInside(root, manifestPath);
    const bytes = await readFile(manifestPath, 'utf8');
    let parsed: JsonValue;
    try {
      parsed = freezeJsonValue(JSON.parse(bytes) as unknown);
    } catch {
      throw invalid('Runtime generation manifest JSON is malformed.');
    }
    if (stableJson(parsed) !== bytes) throw invalid('Runtime generation manifest bytes are not canonical.');

    const object = jsonObject(parsed, 'Runtime generation manifest must be a JSON object.');
    const expectedKeys = ['assets', 'createdAt', 'id', 'manifestDigest', 'metadata', 'schemaVersion', 'sourceRevision'];
    const keys = Object.keys(object).sort((left, right) => left.localeCompare(right));
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw invalid('Runtime generation manifest fields are malformed.');
    }
    const schemaVersion = jsonNumber(object.schemaVersion, 'Runtime generation manifest schema version is malformed.');
    if (schemaVersion !== 1) throw invalid('Runtime generation manifest schema version is unsupported.');
    const metadata = object.metadata;
    if (metadata === undefined) throw invalid('Runtime generation manifest metadata is missing.');
    const diskManifest: DiskManifest = Object.freeze({
      assets: parseAssets(object.assets),
      createdAt: jsonString(object.createdAt, 'Runtime generation manifest creation time is malformed.'),
      id: jsonString(object.id, 'Runtime generation manifest id is malformed.'),
      manifestDigest: jsonString(object.manifestDigest, 'Runtime generation manifest digest is malformed.'),
      metadata,
      schemaVersion: 1,
      sourceRevision: jsonString(object.sourceRevision, 'Runtime generation manifest source revision is malformed.'),
    });
    if (diskManifest.id !== expectedId || diskManifest.sourceRevision !== expectedSourceRevision) {
      throw invalid('Runtime generation manifest did not match its candidate.');
    }
    if (!/^[a-f0-9]{64}$/u.test(diskManifest.manifestDigest)) {
      throw invalid('Runtime generation manifest digest is malformed.');
    }

    const expectedDigest = digest({
      assets: diskManifest.assets,
      createdAt: diskManifest.createdAt,
      id: diskManifest.id,
      metadata: diskManifest.metadata,
      schemaVersion: diskManifest.schemaVersion,
      sourceRevision: diskManifest.sourceRevision,
    });
    if (expectedDigest !== diskManifest.manifestDigest) throw invalid('Runtime generation manifest digest did not match its contents.');

    await this.#validateAssetTree(root, diskManifest.assets, true);
    const decodedManifest = this.#manifestFromDisk(diskManifest, diskManifest.metadata);
    const validatedMetadata = freezeMetadata(await this.#validateMetadata(Object.freeze({
      assets: diskManifest.assets,
      metadata: decodedManifest.metadata,
      root,
    })));
    let encoded: JsonValue;
    try {
      encoded = freezeJsonValue(this.#metadataCodec.encode(validatedMetadata));
    } catch {
      throw invalid('Runtime generation manifest metadata could not be re-encoded.');
    }
    if (stableJson(encoded) !== stableJson(diskManifest.metadata)) {
      throw invalid('Runtime generation manifest metadata codec did not round-trip canonical bytes.');
    }
    const manifest = this.#manifestFromDisk(diskManifest, encoded);

    return Object.freeze({
      id: manifest.id,
      manifest,
      root,
      sourceRevision: manifest.sourceRevision,
    });
  }

  async #validateAssetTree(
    root: string,
    assets: readonly RuntimeGenerationAsset[],
    hasManifest: boolean,
  ): Promise<void> {
    const paths = await this.#walkRegularFiles(root);
    const actual = new Set(paths);
    if (hasManifest) {
      if (!actual.delete(manifestFileName)) throw invalid('Runtime generation manifest file is missing.');
    }
    const expected = new Set(assets.map((asset) => asset.path));
    if (actual.size !== expected.size || Array.from(actual).some((path) => !expected.has(path))) {
      throw invalid('Runtime generation candidate files did not exactly match its manifest.');
    }

    await Promise.all(assets.map(async (asset) => {
      const path = join(root, ...asset.path.split('/'));
      assertInside(root, path);
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw invalid(`Runtime generation asset ${JSON.stringify(asset.path)} is not a regular file.`);
      }
      if (status.size !== asset.bytes) {
        throw invalid(`Runtime generation asset ${JSON.stringify(asset.path)} did not match its byte length.`);
      }
      const bytes = await readFile(path);
      if (bytesSha256(bytes) !== asset.sha256) {
        throw invalid(`Runtime generation asset ${JSON.stringify(asset.path)} did not match its SHA-256 digest.`);
      }
    }));
  }

  async #walkRegularFiles(root: string): Promise<readonly string[]> {
    const rootStatus = await lstat(root);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      throw invalid('Runtime generation candidate root is not a regular directory.');
    }
    const paths: string[] = [];
    const walk = async (current: string, prefix: string): Promise<void> => {
      assertInside(root, current);
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!isSafeSegment(entry.name)) throw invalid('Runtime generation tree contained an unsafe filesystem name.');
        const path = join(current, entry.name);
        assertInside(root, path);
        const status = await lstat(path);
        if (status.isSymbolicLink()) throw invalid('Runtime generation tree cannot contain symbolic links.');
        const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        if (status.isDirectory()) {
          await walk(path, relativePath);
        } else if (status.isFile()) {
          paths.push(relativePath);
        } else {
          throw invalid('Runtime generation tree can contain only regular files and directories.');
        }
      }
    };
    await walk(root, '');
    return Object.freeze(paths);
  }

  async #removeNeverPublic(path: string): Promise<void> {
    try {
      await this.#remove(path);
    } catch (error) {
      // The original validation/supersession error is the useful outcome. Close records owned cleanup failures.
      this.#cleanupFailures.push(Object.freeze({ error, path }));
    }
  }

  #requestCleanup(): void {
    if (this.#cleanupScheduled || this.#closed) return;
    this.#cleanupScheduled = true;
    queueMicrotask(() => {
      if (!this.#cleanupScheduled) return;
      this.#cleanupScheduled = false;
      void this.#enqueueCleanup().catch(() => undefined);
    });
  }

  #enqueueCleanup(): Promise<void> {
    const current = this.#cleanupTail.then(async () => {
      await this.#prune();
    });
    this.#cleanupTail = current.catch(() => undefined);
    return current;
  }

  async #prune(): Promise<void> {
    const inactive = Array.from(this.#committed.values())
      .filter((record) => record.generation.id !== this.#activeId)
      .sort((left, right) => right.sequence - left.sequence);
    const retainedIds = new Set(inactive.slice(0, this.#retainInactive).map((record) => record.generation.id));
    const pruning = inactive.filter((record) =>
      !retainedIds.has(record.generation.id) && record.references === 0 && !record.pruning,
    );
    for (const record of pruning) {
      record.pruning = true;
    }
    for (const record of pruning) {
      try {
        await this.#remove(record.generation.root);
        this.#committed.delete(record.generation.id);
      } catch (error) {
        record.pruning = false;
        this.#cleanupFailures.push(Object.freeze({ error, path: record.generation.root }));
      }
    }
  }

  async #removeWithFailure(path: string, failures: RuntimeGenerationCloseFailure[]): Promise<void> {
    try {
      await this.#remove(path);
    } catch (error) {
      failures.push(Object.freeze({ error, path }));
    }
  }
}
