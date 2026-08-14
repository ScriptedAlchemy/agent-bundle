import type { ReactNode } from 'react';

import type { RenderRequest, RuntimeSnapshot } from '../runtime/contracts.js';
import { AfterFileEdit, RenderEditTimeline, RuntimeStatus } from './components.js';

export const renderRoute = (request: RenderRequest, snapshot: RuntimeSnapshot): ReactNode => {
  if (request.type === 'hook/after-file-edit') {
    return <AfterFileEdit />;
  }

  if (request.type === 'mcp/render-timeline') {
    return <RenderEditTimeline snapshot={request.snapshot} />;
  }

  if (request.type === 'mcp/runtime-status') {
    return <RuntimeStatus snapshot={snapshot} />;
  }

  throw new Error('Unsupported RSC render request');
};
