import { RuntimeGenerationStore } from './runtime-generation-store.ts';
import type {
  DevRuntimeGenerationStore,
  RuntimeGenerationStoreOptions,
} from './runtime-store-contracts.ts';

/**
 * The public constructor of the generation store a `dev.runtime.provider`
 * session drives (#485). It returns the effect-free contract rather than the
 * class, so `agent-bundle/api`'s declaration graph never reaches the
 * `YieldableFrameworkError` hierarchy behind it. Errors the store throws are
 * recognised by `name` and `code` (`RuntimeGenerationStoreErrorCode`).
 */
export const createRuntimeGenerationStore = <TMetadata = unknown>(
  options: RuntimeGenerationStoreOptions<TMetadata>,
): DevRuntimeGenerationStore<TMetadata> => new RuntimeGenerationStore<TMetadata>(options);
