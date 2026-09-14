import { events } from 'agent-bundle/routes';

import { observeEvent } from '../../event-route.js';

export default events.workspace.open({
  targets: ['cursor'],
}, async (event) => {
  await observeEvent(event);
});
