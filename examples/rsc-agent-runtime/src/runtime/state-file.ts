import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';

import type { RuntimeKernel } from './contracts.js';
import {
  createNodeStateStorage,
  createRuntimeStateKernel,
  RuntimeStateCorruptionError,
  RuntimeStateLockError,
  type StateKernelPolicy,
} from './state-file-core.js';

const PRODUCTION_POLICY: StateKernelPolicy = Object.freeze({
  acquireLimitMs: 30_000,
  mutationMs: 10_000,
  ownerSettlementMs: 10_000,
  releaseMs: 10_000,
  retryDelayMs: 25,
  staleMs: 30_000,
  terminateOwner(error: RuntimeStateLockError) {
    process.stderr.write(`${error.message}\n`);
    process.kill(process.pid, 'SIGTERM');
  },
  updateMs: 5_000,
});

export { RuntimeStateCorruptionError, RuntimeStateLockError };

export interface FileRuntimeKernelOptions {
  stateFile: string;
  now?: () => Date;
  createId?: () => string;
}

export const createFileRuntimeKernel = (options: FileRuntimeKernelOptions): RuntimeKernel =>
  createRuntimeStateKernel({
    createId: options.createId,
    now: options.now,
    policy: PRODUCTION_POLICY,
    stateFile: options.stateFile,
    storage: createNodeStateStorage(),
  });

const stateHome = (): string => {
  const configured = process.env.XDG_STATE_HOME;
  return configured !== undefined && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.local', 'state');
};

/** Resolves implicit host state outside the repository from one canonical workspace identity. */
export const resolveImplicitRuntimeStateFile = async (workspaceRoot: string): Promise<string> => {
  const canonicalWorkspace = await realpath(resolve(workspaceRoot));
  const workspaceId = createHash('sha256').update(canonicalWorkspace).digest('hex');
  return join(stateHome(), 'agent-bundle', 'rsc-agent-runtime', workspaceId, 'events.jsonl');
};
