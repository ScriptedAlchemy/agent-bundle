import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

type SessionStartViewInput = {
  readonly host: string;
  readonly logPath: string;
  readonly state: string;
};

export default function SessionStartView({
  renderInput,
}: AgentEventRouteProps<'session/start', SessionStartViewInput>) {
  if (renderInput === undefined) throw new Error('Session start view requires render input.');
  return (
    <Agent.Result>
      <Agent.Context>
        {`host-test probe is recording this ${renderInput.host} session to ${renderInput.logPath} (durable state: ${renderInput.state}).`}
      </Agent.Context>
    </Agent.Result>
  );
}
