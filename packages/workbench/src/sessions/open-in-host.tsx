import React, { useEffect, useState } from 'react';

import type { ApplicationLeaf } from '../application/application-tree-model.ts';
import { errorMessage, isAbortError } from '../client-helpers.ts';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { HostAvailability, HostSessionHost } from '../../../agent-bundle/src/contracts/host-sessions.ts';
import type { HostSessionClient } from './host-session-client.ts';
import { availabilityFor, defaultHostSessionSize, hostLabel, hosts, hostSessionPromptFor } from './host-session-model.ts';

export interface OpenInHostProps {
  readonly client: HostSessionClient;
  readonly leaf: ApplicationLeaf;
  readonly onNavigate: (location: WorkbenchLocation) => void;
}

type Availability =
  | Readonly<{ readonly state: 'loading' }>
  | Readonly<{ readonly hosts: readonly HostAvailability[]; readonly state: 'ready' }>
  | Readonly<{ readonly message: string; readonly state: 'unavailable' }>;

/** `Open in Claude` / `Open in Codex` beside Run: launches the host with the leaf's seeded prompt and lands on the session. */
export const OpenInHost = ({ client, leaf, onNavigate }: OpenInHostProps): React.ReactNode => {
  const prompt = hostSessionPromptFor(leaf);
  const [availability, setAvailability] = useState<Availability>({ state: 'loading' });
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (prompt === undefined) return;
    const controller = new AbortController();
    client.list(controller.signal).then(
      (list) => { if (!controller.signal.aborted) setAvailability({ hosts: list.hosts, state: 'ready' }); },
      (reason: unknown) => { if (!controller.signal.aborted && !isAbortError(reason)) setAvailability({ message: errorMessage(reason, 'Host availability could not be loaded.'), state: 'unavailable' }); },
    );
    return () => controller.abort();
  }, [client, prompt]);

  if (prompt === undefined) return undefined;

  const reasonFor = (host: HostSessionHost): string | undefined => {
    switch (availability.state) {
      case 'loading':
        return 'Checking host availability…';
      case 'unavailable':
        return availability.message;
      case 'ready': {
        const entry = availabilityFor(availability.hosts, host);
        return entry?.launchable === true ? undefined : entry?.reason ?? `${hostLabel(host)} is not available in this project.`;
      }
      default: {
        const exhaustive: never = availability;
        return exhaustive;
      }
    }
  };
  const open = (host: HostSessionHost): void => {
    client.launch({ host, prompt, ...defaultHostSessionSize }).then(
      (session) => onNavigate({ area: 'sessions', session: session.id }),
      (reason: unknown) => setError(errorMessage(reason, 'The host could not be launched.')),
    );
  };

  return <>
    {hosts.map((host) => {
      const reason = reasonFor(host);
      return <button
        className="route-open-in-host"
        data-testid={`route-open-in-${host}`}
        disabled={reason !== undefined}
        key={host}
        onClick={() => open(host)}
        title={reason ?? prompt}
        type="button"
      >Open in {hostLabel(host)}</button>;
    })}
    {error === undefined ? undefined : <span className="route-input-error" role="alert">{error}</span>}
  </>;
};
