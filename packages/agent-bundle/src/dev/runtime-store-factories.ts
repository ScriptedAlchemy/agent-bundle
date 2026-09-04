import { RuntimeGenerationStore } from './runtime-generation-store.ts';
import { RuntimeMcpRegistry } from './runtime-mcp-registry.ts';
import type {
  DevRuntimeGenerationStore,
  DevRuntimeProviderMcpRegistry,
  RuntimeGenerationStoreOptions,
  RuntimeMcpRegistryOptions,
} from './runtime-store-contracts.ts';

/**
 * The public constructors of the generation store and MCP registry a
 * `dev.runtime.provider` session drives (#485). They return the effect-free
 * contracts rather than the classes, so `agent-bundle/api`'s declaration
 * graph never reaches the `YieldableFrameworkError` hierarchy behind them.
 * Errors the store and registry throw are recognised by `name` and `code`
 * (`RuntimeGenerationStoreErrorCode`, `RuntimeMcpRegistryErrorCode`).
 */
export const createRuntimeGenerationStore = <TMetadata = unknown>(
  options: RuntimeGenerationStoreOptions<TMetadata>,
): DevRuntimeGenerationStore<TMetadata> => new RuntimeGenerationStore<TMetadata>(options);

export const createRuntimeMcpRegistry = (options: RuntimeMcpRegistryOptions): DevRuntimeProviderMcpRegistry =>
  new RuntimeMcpRegistry(options);
