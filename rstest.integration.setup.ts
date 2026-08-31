import { ensureRuntimeExamplePayload } from './packages/workbench/tests/helpers/runtime-example-payload.ts';

/**
 * Builds the rsc-agent-runtime example's prebuilt payload trees once, in the
 * orchestrator, before any pool worker starts. Four e2e files copy that
 * shared `examples/rsc-agent-runtime/dist` tree through
 * runtime-playground-fixture.ts; on a cold tree (every CI runner) two
 * parallel workers would otherwise race the same ensure-build and one of
 * them could copy a torn payload.
 */
export const setup = async (): Promise<void> => {
  await ensureRuntimeExamplePayload();
};
