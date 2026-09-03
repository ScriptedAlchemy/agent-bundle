import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { capture } from './capture.js';

/**
 * Every event family renders through this one observer: record the complete
 * native envelope plus the framework context, then return an empty result so
 * no host decision channel is touched. Only `session/start` announces the log
 * path, because it is the one family every host lets a plugin speak into.
 */
export const observeEvent = async (
  props: AgentEventRouteProps,
  options: { readonly announce?: boolean } = {},
): Promise<React.JSX.Element> => {
  const outcome = await capture({ event: props, kind: 'event' });
  if (options.announce !== true) return <Agent.Result />;
  return (
    <Agent.Result>
      <Agent.Context>
        {`host-test probe is recording this ${props.canonical.provenance.host} session to ${outcome.log.path} (durable state: ${outcome.state.state}).`}
      </Agent.Context>
    </Agent.Result>
  );
};
