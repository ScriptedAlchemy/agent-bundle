import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { digest, stableJson } from '../src/core/digest.ts';
import {
  RuntimeGenerationStore,
  type DevRuntimeMcpServerDescriptor,
  type JsonObject,
  type JsonValue,
  type RuntimeGenerationActivationGuard,
  type RuntimeGenerationManifestInput,
  type RuntimeGenerationMetadataCodec,
  type RuntimeGenerationValidationInput,
} from '../src/dev/index.ts';

interface TestMetadata {
  readonly label: string;
  readonly nested: Readonly<{
    readonly enabled: boolean;
    readonly tags: readonly string[];
  }>;
}

interface CapturedMetadata {
  readonly descriptors: readonly (Readonly<{
    readonly name: string;
    readonly path: string;
    readonly sha256: string;
  }>)[];
  readonly entries: Readonly<{
    readonly primary: string;
  }>;
}

type Fixture = Readonly<{
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly manifest: RuntimeGenerationManifestInput<TestMetadata>;
}>;

const sha256 = (value: Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fixture = (id: string): Fixture => {
  const files = Object.freeze({
    'client/ref.json': Buffer.from(JSON.stringify({ id, target: 'portable' })),
    'server/main.bin': Buffer.from(`server:${id}`),
  });

  return Object.freeze({
    files,
    manifest: Object.freeze({
      assets: Object.freeze(Object.entries(files).map(([path, value]) => Object.freeze({
        bytes: value.byteLength,
        path,
        sha256: sha256(value),
      }))),
      metadata: Object.freeze({
        label: id,
        nested: Object.freeze({ enabled: true, tags: Object.freeze(['portable', id]) }),
      }),
    }),
  });
};

const writeGeneration = async (
  root: string,
  value: Fixture,
): Promise<void> => {
  await Promise.all(Object.entries(value.files).map(async ([path, bytes]) => {
    const destination = join(root, ...path.split('/'));
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, bytes);
  }));
};

const metadataCodec: RuntimeGenerationMetadataCodec<TestMetadata> = {
  decode(value: JsonValue): TestMetadata {
    if (!isJsonObject(value) || typeof value.label !== 'string' || !isJsonObject(value.nested)) {
      throw new TypeError('Fixture metadata is malformed.');
    }
    const nested = value.nested;
    const tags = nested.tags;
    if (typeof nested.enabled !== 'boolean' || !Array.isArray(tags) || !tags.every((tag: unknown) => typeof tag === 'string')) {
      throw new TypeError('Fixture metadata is malformed.');
    }

    return Object.freeze({
      label: value.label,
      nested: Object.freeze({
        enabled: nested.enabled,
        tags: Object.freeze([...tags]),
      }),
    });
  },
  encode(value: TestMetadata): JsonValue {
    return {
      label: value.label,
      nested: {
        enabled: value.nested.enabled,
        tags: [...value.nested.tags],
      },
    };
  },
};

const capturedMetadataCodec: RuntimeGenerationMetadataCodec<CapturedMetadata> = Object.freeze({
  decode(value: JsonValue): CapturedMetadata {
    if (!isJsonObject(value) || !isJsonObject(value.entries) || !Array.isArray(value.descriptors)) {
      throw new TypeError('Captured metadata is malformed.');
    }
    if (typeof value.entries.primary !== 'string') throw new TypeError('Captured metadata is malformed.');

    const descriptors = value.descriptors.map((descriptor) => {
      if (!isJsonObject(descriptor) ||
        typeof descriptor.name !== 'string' ||
        typeof descriptor.path !== 'string' ||
        typeof descriptor.sha256 !== 'string') {
        throw new TypeError('Captured metadata is malformed.');
      }
      return Object.freeze({ name: descriptor.name, path: descriptor.path, sha256: descriptor.sha256 });
    });
    return Object.freeze({
      descriptors: Object.freeze(descriptors),
      entries: Object.freeze({ primary: value.entries.primary }),
    });
  },
  encode(value: CapturedMetadata): JsonValue {
    return {
      descriptors: value.descriptors.map((descriptor) => ({
        name: descriptor.name,
        path: descriptor.path,
        sha256: descriptor.sha256,
      })),
      entries: { primary: value.entries.primary },
    };
  },
});

const validateCapturedMetadata = (
  input: RuntimeGenerationValidationInput<CapturedMetadata>,
): CapturedMetadata => {
  const primary = input.metadata.entries.primary;
  if (primary !== 'server/main.bin') throw new Error('Primary entry did not reference the required server asset.');
  const asset = input.assets.find((candidate) => candidate.path === primary);
  if (asset === undefined) throw new Error('Primary entry did not reference a captured asset.');
  if (input.metadata.descriptors.length !== 1) throw new Error('Primary entry did not have exactly one descriptor.');
  const descriptor = input.metadata.descriptors[0];
  if (descriptor === undefined ||
    descriptor.name !== 'primary' ||
    descriptor.path !== primary ||
    descriptor.sha256 !== asset.sha256) {
    throw new Error('Primary entry descriptor did not match its captured asset.');
  }
  return Object.freeze({
    descriptors: Object.freeze([Object.freeze({
      name: descriptor.name,
      path: descriptor.path,
      sha256: descriptor.sha256,
    })]),
    entries: Object.freeze({ primary }),
  });
};

const nestedDescriptorCodec: RuntimeGenerationMetadataCodec<Readonly<{
  readonly servers: readonly DevRuntimeMcpServerDescriptor[];
}>> = {
  decode: () => Object.freeze({ servers: Object.freeze([]) }),
  encode: () => Object.freeze({ servers: Object.freeze([]) }),
};

const createStore = async (options: Readonly<{
  readonly metadataCodec?: RuntimeGenerationMetadataCodec<TestMetadata>;
  readonly remove?: (path: string) => Promise<void>;
  readonly retainInactive?: number;
  readonly validateMetadata?: (input: RuntimeGenerationValidationInput<TestMetadata>) => TestMetadata | Promise<TestMetadata>;
}> = {}): Promise<Readonly<{
  readonly root: string;
  readonly store: RuntimeGenerationStore<TestMetadata>;
}>> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-generations-'));
  return Object.freeze({
    root,
    store: new RuntimeGenerationStore({
      metadataCodec: options.metadataCodec ?? metadataCodec,
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      ...(options.remove === undefined ? {} : { remove: options.remove }),
      ...(options.retainInactive === undefined ? {} : { retainInactive: options.retainInactive }),
      storageRoot: root,
      validateMetadata: options.validateMetadata ?? ((input) => Object.freeze({
        label: input.metadata.label,
        nested: Object.freeze({
          enabled: input.metadata.nested.enabled,
          tags: Object.freeze([...input.metadata.nested.tags]),
        }),
      })),
    }),
  });
};

const commitFixture = async (
  store: RuntimeGenerationStore<TestMetadata>,
  id: string,
): Promise<void> => {
  const candidate = await store.begin({ id, sourceRevision: `source-${id}` });
  const value = fixture(id);
  await writeGeneration(candidate.root, value);
  store.commit(await store.prepare(candidate, value.manifest));
};

const expectMissing = async (path: string): Promise<void> => {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
};

const mutateManifestBeforeReopen = async (
  root: string,
  mutateMetadata: (metadata: JsonObject) => JsonValue,
): Promise<void> => {
  const manifestPath = join(root, 'generation.manifest.json');
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isJsonObject(parsed) || !isJsonObject(parsed.metadata)) {
    throw new TypeError('Test generation manifest was malformed.');
  }
  const { manifestDigest: _manifestDigest, ...withoutDigest } = parsed;
  const updated = Object.freeze({
    ...withoutDigest,
    metadata: mutateMetadata(parsed.metadata),
  });
  await writeFile(manifestPath, stableJson({
    ...updated,
    manifestDigest: digest(updated),
  }), 'utf8');
};

const deferred = <T = void>(): Readonly<{
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
}> => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
};

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

it('prepares an opaque validated generation without publishing it before synchronous commit', async () => {
  const { root, store } = await createStore();
  const value = fixture('g1');
  try {
    const candidate = await store.begin({ id: 'g1', sourceRevision: 'source-g1' });
    await writeGeneration(candidate.root, value);

    const prepared = await store.prepare(candidate, value.manifest);

    expect(store.active()).toBeUndefined();
    await expect(store.lease('g1')).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_NOT_FOUND' });
    expect(prepared.generation).toMatchObject({
      id: 'g1',
      manifest: {
        createdAt: '2026-08-15T00:00:00.000Z',
        metadata: value.manifest.metadata,
        schemaVersion: 1,
        sourceRevision: 'source-g1',
      },
    });
    expect(Object.isFrozen(prepared.generation.manifest)).toBe(true);
    expect(Object.isFrozen(prepared.generation.manifest.metadata)).toBe(true);
    expect(await lstat(prepared.generation.root)).toMatchObject({ isDirectory: expect.any(Function) });

    expect(store.commit(prepared)).toMatchObject({ id: 'g1' });
    expect(store.active()).toMatchObject({ id: 'g1' });
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects incomplete, altered, unsafe, and invalid candidate inputs', async () => {
  const { root, store } = await createStore();
  const missing = fixture('missing');
  const extra = fixture('extra');
  const bytes = fixture('bytes');
  const hash = fixture('hash');
  const duplicate = fixture('duplicate');
  const escaped = fixture('escaped');
  const linked = fixture('linked');
  const malformed = fixture('malformed');
  try {
    const missingCandidate = await store.begin({ id: 'missing', sourceRevision: 'source-missing' });
    await writeGeneration(missingCandidate.root, missing);
    await rm(join(missingCandidate.root, 'server', 'main.bin'));
    await expect(store.prepare(missingCandidate, missing.manifest)).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });

    const extraCandidate = await store.begin({ id: 'extra', sourceRevision: 'source-extra' });
    await writeGeneration(extraCandidate.root, extra);
    await writeFile(join(extraCandidate.root, 'extra.bin'), 'unexpected');
    await expect(store.prepare(extraCandidate, extra.manifest)).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });

    const bytesCandidate = await store.begin({ id: 'bytes', sourceRevision: 'source-bytes' });
    await writeGeneration(bytesCandidate.root, bytes);
    await writeFile(join(bytesCandidate.root, 'server', 'main.bin'), 'different bytes');
    await expect(store.prepare(bytesCandidate, bytes.manifest)).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });

    const hashCandidate = await store.begin({ id: 'hash', sourceRevision: 'source-hash' });
    await writeGeneration(hashCandidate.root, hash);
    await expect(store.prepare(hashCandidate, {
      ...hash.manifest,
      assets: hash.manifest.assets.map((asset) => asset.path === 'server/main.bin'
        ? { ...asset, sha256: '0'.repeat(64) }
        : asset),
    })).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });

    const duplicateCandidate = await store.begin({ id: 'duplicate', sourceRevision: 'source-duplicate' });
    await writeGeneration(duplicateCandidate.root, duplicate);
    await expect(store.prepare(duplicateCandidate, {
      ...duplicate.manifest,
      assets: [...duplicate.manifest.assets, duplicate.manifest.assets[0]!],
    })).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });

    const escapeCandidate = await store.begin({ id: 'escaped', sourceRevision: 'source-escaped' });
    await writeGeneration(escapeCandidate.root, escaped);
    await expect(store.prepare(escapeCandidate, {
      ...escaped.manifest,
      assets: escaped.manifest.assets.map((asset) => asset.path === 'server/main.bin'
        ? { ...asset, path: '../outside.bin' }
        : asset),
    })).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });

    const linkedCandidate = await store.begin({ id: 'linked', sourceRevision: 'source-linked' });
    await writeGeneration(linkedCandidate.root, linked);
    await rm(join(linkedCandidate.root, 'client', 'ref.json'));
    await symlink(join(linkedCandidate.root, 'server', 'main.bin'), join(linkedCandidate.root, 'client', 'ref.json'));
    await expect(store.prepare(linkedCandidate, linked.manifest)).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });

    const malformedCandidate = await store.begin({ id: 'malformed', sourceRevision: 'source-malformed' });
    await writeGeneration(malformedCandidate.root, malformed);
    const malformedStore = await createStore({
      metadataCodec: {
        decode: metadataCodec.decode,
        encode: () => Number.NaN as never,
      },
    });
    try {
      const malformedStoreCandidate = await malformedStore.store.begin({ id: 'malformed', sourceRevision: 'source-malformed' });
      await writeGeneration(malformedStoreCandidate.root, malformed);
      await expect(malformedStore.store.prepare(malformedStoreCandidate, malformed.manifest))
        .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });
    } finally {
      await malformedStore.store.close().catch(() => undefined);
      await rm(malformedStore.root, { force: true, recursive: true });
    }
    await expect(store.prepare(malformedCandidate, malformed.manifest, {
      guard: { check: () => false, wait: async () => undefined },
    })).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_SUPERSEDED' });
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a provider metadata validator failure without publishing the candidate', async () => {
  const { root, store } = await createStore({
    validateMetadata: () => {
      throw new Error('provider metadata rejected');
    },
  });
  const value = fixture('invalid-metadata');
  try {
    const candidate = await store.begin({ id: 'invalid-metadata', sourceRevision: 'source-invalid-metadata' });
    await writeGeneration(candidate.root, value);
    await expect(store.prepare(candidate, value.manifest)).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });
    expect(store.active()).toBeUndefined();
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('revalidates reopened metadata before accepting a required entry redirected to another captured asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-generations-reopen-entry-'));
  let validationCalls = 0;
  const store = new RuntimeGenerationStore<CapturedMetadata>({
    metadataCodec: capturedMetadataCodec,
    now: () => new Date('2026-08-15T00:00:00.000Z'),
    storageRoot: root,
    validateMetadata: (input) => {
      validationCalls += 1;
      return validateCapturedMetadata(input);
    },
  });
  const value = fixture('reopen-entry');
  const serverAsset = value.manifest.assets.find((asset) => asset.path === 'server/main.bin');
  const clientAsset = value.manifest.assets.find((asset) => asset.path === 'client/ref.json');
  if (serverAsset === undefined || clientAsset === undefined) throw new Error('Fixture assets were missing.');
  const metadata: CapturedMetadata = Object.freeze({
    descriptors: Object.freeze([Object.freeze({
      name: 'primary',
      path: 'server/main.bin',
      sha256: serverAsset.sha256,
    })]),
    entries: Object.freeze({ primary: 'server/main.bin' }),
  });
  try {
    const candidate = await store.begin({ id: 'reopen-entry', sourceRevision: 'source-reopen-entry' });
    await writeGeneration(candidate.root, value);
    let waits = 0;
    await expect(store.prepare(candidate, {
      assets: value.manifest.assets,
      metadata,
    }, {
      guard: {
        check: () => true,
        wait: async () => {
          waits += 1;
          if (waits !== 1) return;
          await mutateManifestBeforeReopen(candidate.root, () => ({
            descriptors: [{ name: 'primary', path: 'client/ref.json', sha256: clientAsset.sha256 }],
            entries: { primary: 'client/ref.json' },
          }));
        },
      },
    })).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });
    expect(validationCalls).toBe(2);
    expect(store.active()).toBeUndefined();
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('revalidates reopened metadata before accepting internally inconsistent descriptors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-generations-reopen-descriptor-'));
  let validationCalls = 0;
  const store = new RuntimeGenerationStore<CapturedMetadata>({
    metadataCodec: capturedMetadataCodec,
    now: () => new Date('2026-08-15T00:00:00.000Z'),
    storageRoot: root,
    validateMetadata: (input) => {
      validationCalls += 1;
      return validateCapturedMetadata(input);
    },
  });
  const value = fixture('reopen-descriptor');
  const serverAsset = value.manifest.assets.find((asset) => asset.path === 'server/main.bin');
  const clientAsset = value.manifest.assets.find((asset) => asset.path === 'client/ref.json');
  if (serverAsset === undefined || clientAsset === undefined) throw new Error('Fixture assets were missing.');
  const metadata: CapturedMetadata = Object.freeze({
    descriptors: Object.freeze([Object.freeze({
      name: 'primary',
      path: serverAsset.path,
      sha256: serverAsset.sha256,
    })]),
    entries: Object.freeze({ primary: serverAsset.path }),
  });
  try {
    const candidate = await store.begin({ id: 'reopen-descriptor', sourceRevision: 'source-reopen-descriptor' });
    await writeGeneration(candidate.root, value);
    let waits = 0;
    await expect(store.prepare(candidate, {
      assets: value.manifest.assets,
      metadata,
    }, {
      guard: {
        check: () => true,
        wait: async () => {
          waits += 1;
          if (waits !== 1) return;
          await mutateManifestBeforeReopen(candidate.root, () => ({
            descriptors: [{ name: 'primary', path: serverAsset.path, sha256: clientAsset.sha256 }],
            entries: { primary: serverAsset.path },
          }));
        },
      },
    })).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_INVALID' });
    expect(validationCalls).toBe(2);
    expect(store.active()).toBeUndefined();
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('fences superseded candidates and keeps the last good active generation after a failure', async () => {
  const { root, store } = await createStore();
  try {
    await commitFixture(store, 'g1');
    const candidate2 = await store.begin({ id: 'g2', sourceRevision: 'source-2' });
    const candidate3 = await store.begin({ id: 'g3', sourceRevision: 'source-3' });
    const value3 = fixture('g3');
    await writeGeneration(candidate3.root, value3);
    const prepared3 = await store.prepare(candidate3, value3.manifest);
    expect(store.active()?.id).toBe('g1');
    expect(store.commit(prepared3)).toMatchObject({ id: 'g3' });

    await writeGeneration(candidate2.root, fixture('g2'));
    await expect(store.prepare(candidate2, fixture('g2').manifest))
      .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_SUPERSEDED' });
    expect(store.active()?.id).toBe('g3');

    const failed = await store.begin({ id: 'failed', sourceRevision: 'source-failed' });
    await writeGeneration(failed.root, fixture('failed'));
    await store.fail(failed);
    expect(store.active()?.id).toBe('g3');
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('serializes concurrent begins into distinct monotonic candidate sequences', async () => {
  const { root, store } = await createStore();
  try {
    const [candidate1, candidate2] = await Promise.all([
      store.begin({ id: 'g1', sourceRevision: 'source-1' }),
      store.begin({ id: 'g2', sourceRevision: 'source-2' }),
    ]);
    const value1 = fixture('g1');
    const value2 = fixture('g2');
    await Promise.all([
      writeGeneration(candidate1.root, value1),
      writeGeneration(candidate2.root, value2),
    ]);

    expect(candidate2.sequence).toBeGreaterThan(candidate1.sequence);
    const prepared2 = await store.prepare(candidate2, value2.manifest);
    store.commit(prepared2);
    await expect(store.prepare(candidate1, value1.manifest))
      .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_SUPERSEDED' });
    expect(store.active()?.id).toBe('g2');
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('pins explicit leases to committed generations, defaults implicit leases to active, and releases idempotently', async () => {
  const { root, store } = await createStore();
  try {
    await commitFixture(store, 'g1');
    const explicit = await store.lease('g1');
    await commitFixture(store, 'g2');
    const implicit = await store.lease();

    expect(explicit.generation.id).toBe('g1');
    expect(implicit.generation.id).toBe('g2');
    expect(await readFile(join(explicit.generation.root, 'server', 'main.bin'), 'utf8')).toBe('server:g1');
    await explicit.release();
    await explicit.release();
    await implicit.release();
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('retains active plus five newest inactive generations and defers a leased prune until release', async () => {
  const { root, store } = await createStore({ retainInactive: 5 });
  try {
    await commitFixture(store, 'g1');
    const lease = await store.lease('g1');
    for (const id of ['g2', 'g3', 'g4', 'g5', 'g6', 'g7']) {
      await commitFixture(store, id);
    }

    expect(store.active()?.id).toBe('g7');
    await access(join(root, 'generations', 'g1'));
    await lease.release();
    await expectMissing(join(root, 'generations', 'g1'));
    for (const id of ['g2', 'g3', 'g4', 'g5', 'g6', 'g7']) {
      await access(join(root, 'generations', id));
    }
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('does not admit an explicit lease after pruning has synchronously reserved its generation', async () => {
  const removalStarted = deferred<void>();
  const removalFinished = deferred<void>();
  const allowRemoval = deferred<void>();
  const { root, store } = await createStore({
    remove: async (path) => {
      if (path.endsWith('/g1')) {
        removalStarted.resolve();
        await allowRemoval.promise;
        await rm(path, { force: true, recursive: true });
        removalFinished.resolve();
        return;
      }
      await rm(path, { force: true, recursive: true });
    },
    retainInactive: 5,
  });
  try {
    for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']) {
      await commitFixture(store, id);
    }
    await commitFixture(store, 'g7');
    await removalStarted.promise;

    await expect(store.lease('g1')).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_NOT_FOUND' });
    allowRemoval.resolve();
    await removalFinished.promise;
    await expectMissing(join(root, 'generations', 'g1'));
  } finally {
    allowRemoval.resolve();
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('aborts prepared roots, removes abandoned session roots on reopen, and reports cleanup failures structurally', async () => {
  const { root, store } = await createStore();
  try {
    const value = fixture('prepared');
    const candidate = await store.begin({ id: 'prepared', sourceRevision: 'source-prepared' });
    await writeGeneration(candidate.root, value);
    const prepared = await store.prepare(candidate, value.manifest);
    await store.abort(prepared);
    await expectMissing(prepared.generation.root);

    const orphanCandidate = await store.begin({ id: 'orphan', sourceRevision: 'source-orphan' });
    const orphan = fixture('orphan');
    await writeGeneration(orphanCandidate.root, orphan);
    const orphanPrepared = await store.prepare(orphanCandidate, orphan.manifest);
    const reopened = new RuntimeGenerationStore({
      metadataCodec,
      storageRoot: root,
      validateMetadata: (input) => input.metadata,
    });
    const reopenCandidate = await reopened.begin({ id: 'reopened', sourceRevision: 'source-reopened' });
    expect(reopenCandidate.id).toBe('reopened');
    await expectMissing(orphanPrepared.generation.root);
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }

  const failedRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-generations-close-'));
  const failingStore = new RuntimeGenerationStore<TestMetadata>({
    metadataCodec,
    remove: async (path) => {
      if (path.endsWith('/prepared')) throw new Error('cleanup refused');
      await rm(path, { force: true, recursive: true });
    },
    storageRoot: failedRoot,
    validateMetadata: (input) => input.metadata,
  });
  try {
    const candidate = await failingStore.begin({ id: 'prepared', sourceRevision: 'source-prepared' });
    const value = fixture('prepared');
    await writeGeneration(candidate.root, value);
    await failingStore.prepare(candidate, value.manifest);
    await expect(failingStore.close()).rejects.toMatchObject({
      failures: [expect.objectContaining({ path: join(failedRoot, 'generations', 'prepared') })],
    });
    await expect(failingStore.close()).resolves.toBeUndefined();
    await expect(failingStore.begin({ id: 'closed', sourceRevision: 'source-closed' }))
      .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_CLOSED' });
    await expect(failingStore.lease()).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_CLOSED' });
  } finally {
    await rm(failedRoot, { force: true, recursive: true });
  }
});

it('runs synchronous guard checks directly after both asynchronous guard waits', async () => {
  const { root, store } = await createStore();
  const value = fixture('guarded');
  try {
    const candidate = await store.begin({ id: 'guarded', sourceRevision: 'source-guarded' });
    await writeGeneration(candidate.root, value);
    let liveRevision = 2;
    let waitedRevision = 0;
    const guard: RuntimeGenerationActivationGuard<TestMetadata> = {
      check: () => waitedRevision === liveRevision,
      wait: () => new Promise<void>((resolve) => {
        waitedRevision = liveRevision;
        resolve();
        queueMicrotask(() => { liveRevision = 3; });
      }),
    };

    await expect(store.prepare(candidate, value.manifest, { guard }))
      .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_SUPERSEDED' });
    expect(store.active()?.id).not.toBe('guarded');
    await expect(store.lease('guarded')).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_NOT_FOUND' });
    await expectMissing(join(root, 'generations', 'guarded'));
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps a candidate non-public when the pre-rename guard changes in its wait/check microtask seam', async () => {
  const { root, store } = await createStore();
  const value = fixture('pre-guard-race');
  try {
    const candidate = await store.begin({ id: 'pre-guard-race', sourceRevision: 'source-pre-guard-race' });
    await writeGeneration(candidate.root, value);
    let revision = 1;
    const guard: RuntimeGenerationActivationGuard<TestMetadata> = {
      check: () => revision === 1,
      wait: () => new Promise<void>((resolve) => {
        resolve();
        queueMicrotask(() => { revision = 2; });
      }),
    };

    await expect(store.prepare(candidate, value.manifest, { guard }))
      .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_SUPERSEDED' });
    expect(store.active()).toBeUndefined();
    await expect(store.lease('pre-guard-race')).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_NOT_FOUND' });
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps a candidate non-public when the post-rename guard changes in its wait/check microtask seam', async () => {
  const { root, store } = await createStore();
  const value = fixture('post-guard-race');
  try {
    const candidate = await store.begin({ id: 'post-guard-race', sourceRevision: 'source-post-guard-race' });
    await writeGeneration(candidate.root, value);
    let revision = 1;
    let waits = 0;
    const guard: RuntimeGenerationActivationGuard<TestMetadata> = {
      check: () => revision === 1,
      wait: () => new Promise<void>((resolve) => {
        waits += 1;
        resolve();
        if (waits === 2) queueMicrotask(() => { revision = 2; });
      }),
    };

    await expect(store.prepare(candidate, value.manifest, { guard }))
      .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_SUPERSEDED' });
    expect(store.active()).toBeUndefined();
    await expect(store.lease('post-guard-race')).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_NOT_FOUND' });
    await expectMissing(join(root, 'generations', 'post-guard-race'));
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('drains an admitted post-rename prepare before close removes its owned roots', async () => {
  const postRename = deferred<void>();
  const releasePrepare = deferred<void>();
  let closing = false;
  const closeRemovals: string[] = [];
  const created = await createStore({
    remove: async (path) => {
      if (closing) closeRemovals.push(path);
      await rm(path, { force: true, recursive: true });
    },
  });
  const { root, store } = created;
  const value = fixture('late-close');
  let prepare: Promise<unknown> | undefined;
  let close: Promise<void> | undefined;
  try {
    const candidate = await store.begin({ id: 'late-close', sourceRevision: 'source-late-close' });
    await writeGeneration(candidate.root, value);
    let waits = 0;
    prepare = store.prepare(candidate, value.manifest, {
      guard: {
        check: () => true,
        wait: async () => {
          waits += 1;
          if (waits !== 2) return;
          postRename.resolve();
          await releasePrepare.promise;
        },
      },
    });
    await postRename.promise;

    closing = true;
    close = store.close();
    expect(store.close()).toBe(close);
    let settled = false;
    void close.then(() => { settled = true; }, () => { settled = true; });
    await flushMicrotasks();
    expect(closeRemovals).toEqual([]);
    expect(settled).toBe(false);
    await expect(store.begin({ id: 'after-close', sourceRevision: 'source-after-close' }))
      .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_CLOSED' });

    releasePrepare.resolve();
    await expect(prepare).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_CLOSED' });
    await expect(close).resolves.toBeUndefined();
    await expectMissing(join(root, 'generations', 'late-close'));
    await expectMissing(join(root, 'staging'));
    expect(closeRemovals).toEqual(expect.arrayContaining([
      join(root, 'generations', 'late-close'),
      join(root, 'staging'),
    ]));
  } finally {
    releasePrepare.resolve();
    await prepare?.catch(() => undefined);
    await close?.catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('reports a late post-rename prepare cleanup failure from the close that drains it', async () => {
  const postRename = deferred<void>();
  const releasePrepare = deferred<void>();
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-generations-close-late-failure-'));
  let closing = false;
  const closeRemovals: string[] = [];
  const store = new RuntimeGenerationStore<TestMetadata>({
    metadataCodec,
    remove: async (path) => {
      if (closing) closeRemovals.push(path);
      if (path === join(root, 'generations', 'late-failure')) throw new Error('late cleanup refused');
      await rm(path, { force: true, recursive: true });
    },
    storageRoot: root,
    validateMetadata: (input) => input.metadata,
  });
  const value = fixture('late-failure');
  let prepare: Promise<unknown> | undefined;
  let close: Promise<void> | undefined;
  try {
    const candidate = await store.begin({ id: 'late-failure', sourceRevision: 'source-late-failure' });
    await writeGeneration(candidate.root, value);
    let waits = 0;
    prepare = store.prepare(candidate, value.manifest, {
      guard: {
        check: () => true,
        wait: async () => {
          waits += 1;
          if (waits !== 2) return;
          postRename.resolve();
          await releasePrepare.promise;
        },
      },
    });
    await postRename.promise;

    closing = true;
    close = store.close();
    await flushMicrotasks();
    expect(closeRemovals).toEqual([]);
    releasePrepare.resolve();
    await expect(prepare).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_CLOSED' });
    await expect(close).rejects.toMatchObject({
      failures: [expect.objectContaining({ path: join(root, 'generations', 'late-failure') })],
    });
    await expect(store.close()).resolves.toBeUndefined();
  } finally {
    releasePrepare.resolve();
    await prepare?.catch(() => undefined);
    await close?.catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('shares one in-flight close failure across concurrent callers and remains idempotent afterwards', async () => {
  const started = deferred<void>();
  const allowFailure = deferred<void>();
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-generations-close-race-'));
  const store = new RuntimeGenerationStore<TestMetadata>({
    metadataCodec,
    remove: async (path) => {
      if (path.endsWith('/prepared')) {
        started.resolve();
        await allowFailure.promise;
        throw new Error('deferred cleanup refused');
      }
      await rm(path, { force: true, recursive: true });
    },
    storageRoot: root,
    validateMetadata: (input) => input.metadata,
  });
  try {
    const candidate = await store.begin({ id: 'prepared', sourceRevision: 'source-prepared' });
    const value = fixture('prepared');
    await writeGeneration(candidate.root, value);
    await store.prepare(candidate, value.manifest);

    const first = store.close();
    const second = store.close();
    expect(second).toBe(first);
    await started.promise;
    allowFailure.resolve();
    await expect(first).rejects.toMatchObject({
      failures: [expect.objectContaining({ path: join(root, 'generations', 'prepared') })],
    });
    await expect(second).rejects.toMatchObject({
      failures: [expect.objectContaining({ path: join(root, 'generations', 'prepared') })],
    });
    await expect(store.close()).resolves.toBeUndefined();
  } finally {
    allowFailure.resolve();
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps the nested provider metadata codec type-safe without runtime-specific core keys', () => {
  expect(nestedDescriptorCodec.encode({ servers: [] })).toEqual({ servers: [] });
});
