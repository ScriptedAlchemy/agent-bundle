import type { RuntimeKernel } from './contracts.js';
import {
  createFileRuntimeKernelForTesting,
  type FileRuntimeKernelOptions,
  type RuntimeStateTestAdapter,
} from './state-file.js';

export interface TestFileRuntimeKernelOptions extends FileRuntimeKernelOptions {
  readonly adapter?: RuntimeStateTestAdapter;
}

/** Test-only factory. This module is intentionally not imported by a runtime entry. */
export const createTestFileRuntimeKernel = (options: TestFileRuntimeKernelOptions): RuntimeKernel =>
  createFileRuntimeKernelForTesting(options, {
    lockTiming: { staleMs: 2_000, updateMs: 1_000 },
    ...options.adapter,
  });
