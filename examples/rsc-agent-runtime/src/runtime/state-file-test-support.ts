import type { RuntimeKernel } from './contracts.js';
import { open } from 'node:fs/promises';
import {
  createNodeStateStorage,
  createRuntimeStateKernel,
  type StateKernelPolicy,
  type StateLeaseRelease,
  type StateStorage,
} from './state-file-core.js';
import type { FileRuntimeKernelOptions } from './state-file.js';

export interface RuntimeStateTestAdapter {
  readonly acquireLock?: StateStorage['acquire'];
  readonly beforeAppend?: () => Promise<void>;
  readonly beforeAppendSync?: () => Promise<void>;
  readonly beforeAppendWrite?: () => Promise<void>;
  readonly beforeRead?: () => Promise<void>;
  readonly beforeRelease?: () => Promise<void>;
  readonly beforeRepair?: () => Promise<void>;
  readonly criticalSectionMs?: number;
  readonly fatalOwnerTeardown?: (error: Error) => void;
  readonly ownerSettlementMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly prepareStateFile?: (input: Readonly<{ stateFile: string }>) => Promise<string>;
  readonly readState?: StateStorage['read'];
  readonly releaseMs?: number;
  readonly syncParent?: (directory: string) => Promise<void>;
}

export interface TestFileRuntimeKernelOptions extends FileRuntimeKernelOptions {
  readonly adapter?: RuntimeStateTestAdapter;
}

const wrapRelease = (
  release: StateLeaseRelease,
  adapter: RuntimeStateTestAdapter,
): StateLeaseRelease => async () => {
  await adapter.beforeRelease?.();
  await release();
};

export const createTestFileRuntimeKernel = ({ adapter = {}, ...options }: TestFileRuntimeKernelOptions): RuntimeKernel => {
  const native = createNodeStateStorage({ platform: adapter.platform, syncParent: adapter.syncParent });
  const storage: StateStorage = {
    ...native,
    acquire: async (input) => wrapRelease(
      await (adapter.acquireLock === undefined ? native.acquire(input) : adapter.acquireLock(input)),
      adapter,
    ),
    async append(stateFile, contents, signal) {
      await adapter.beforeAppend?.();
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Runtime state mutation was aborted');
      }
      if (adapter.beforeAppendWrite !== undefined || adapter.beforeAppendSync !== undefined) {
        const handle = await open(stateFile, 'a');
        try {
          await adapter.beforeAppendWrite?.();
          if (signal.aborted) throw signal.reason;
          await handle.writeFile(contents);
          await adapter.beforeAppendSync?.();
          if (signal.aborted) throw signal.reason;
          await handle.sync();
          return;
        } finally {
          await handle.close();
        }
      }
      return native.append(stateFile, contents, signal);
    },
    prepare: adapter.prepareStateFile === undefined
      ? native.prepare
      : (stateFile) => adapter.prepareStateFile!({ stateFile }),
    read: adapter.readState ?? (async (stateFile, signal) => {
      await adapter.beforeRead?.();
      return native.read(stateFile, signal);
    }),
    async repair(stateFile, completeBytes, signal) {
      await adapter.beforeRepair?.();
      if (signal.aborted) throw signal.reason;
      return native.repair(stateFile, completeBytes, signal);
    },
  };
  const policy: StateKernelPolicy = {
    acquireLimitMs: 30_000,
    mutationMs: adapter.criticalSectionMs ?? 10_000,
    ownerSettlementMs: adapter.ownerSettlementMs ?? 100,
    releaseMs: adapter.releaseMs ?? 100,
    retryDelayMs: 25,
    staleMs: 2_000,
    terminateOwner: (error) => adapter.fatalOwnerTeardown?.(error),
    updateMs: 1_000,
  };
  return createRuntimeStateKernel({
    createId: options.createId,
    now: options.now,
    policy,
    stateFile: options.stateFile,
    storage,
  });
};
