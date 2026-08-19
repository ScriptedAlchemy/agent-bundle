import { AsyncLocalStorage } from 'node:async_hooks';

import type { CanonicalPostToolUse, RuntimeSnapshot } from './contracts.js';

export interface RenderContext {
  edit: CanonicalPostToolUse;
  snapshot: RuntimeSnapshot;
}

const renderContext = new AsyncLocalStorage<RenderContext>();

const getRenderContext = (): RenderContext => {
  const context = renderContext.getStore();
  if (context === undefined) {
    throw new Error('RSC runtime hook used outside a render request');
  }

  return context;
};

export const withRenderContext = <T>(context: RenderContext, operation: () => T): T =>
  renderContext.run(context, operation);

export const useEdit = (): CanonicalPostToolUse => getRenderContext().edit;

export const useRuntimeSnapshot = (): RuntimeSnapshot => getRenderContext().snapshot;
