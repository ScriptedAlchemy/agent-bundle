import { createRscRequestContext } from '@agent-bundle/rsc-runtime';

import type { CanonicalPostToolUse, RuntimeSnapshot } from './contracts.js';

export interface RenderContext {
  edit: CanonicalPostToolUse;
  snapshot: RuntimeSnapshot;
}

const renderContext = createRscRequestContext<RenderContext>('RSC runtime hook');

export const withRenderContext = <T>(context: RenderContext, operation: () => T): T =>
  renderContext.run(context, operation);

export const useEdit = (): CanonicalPostToolUse => renderContext.use().edit;

export const useRuntimeSnapshot = (): RuntimeSnapshot => renderContext.use().snapshot;
