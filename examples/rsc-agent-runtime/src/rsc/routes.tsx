import type { ReactNode } from 'react';

import type { RenderRequest } from '../runtime/contracts.js';
import { AfterFileEdit } from './components.js';

export const renderHookRoute = (request: RenderRequest): ReactNode => {
  if (request.type === 'hook/after-file-edit') {
    return <AfterFileEdit />;
  }

  throw new Error('Unsupported RSC render request');
};
