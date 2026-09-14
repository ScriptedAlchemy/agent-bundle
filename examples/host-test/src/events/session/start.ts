import { events } from 'agent-bundle/routes';

import { observeEvent } from '../../event-route.js';

export default events.session.start({
  fallback: 'standalone',
  runtime: 'shared',
  targets: ['claude', 'codex', 'cursor'],
}, async (event) => {
  const outcome = await observeEvent(event);
  return event.render('./start.view.js', {
    host: event.canonical.provenance.host,
    logPath: outcome.log.path,
    state: outcome.state.state,
  });
});
