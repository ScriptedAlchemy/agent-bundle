import type { HookHandler } from 'agent-bundle';

import { releaseContext } from '../release-context.ts';

export default ((event) => ({
  additionalContext: releaseContext(
    event.sessionId,
    event.cwd ?? process.cwd(),
    event.source ?? 'an unknown source',
  ),
  outcome: 'continue',
})) satisfies HookHandler<'sessionStart'>;
