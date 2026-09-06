/**
 * Browser-safe host-session wire types (#600 PR 3, frozen HTTP contract).
 * Declared here until `agent-bundle/src/contracts/host-sessions.ts` lands;
 * the integrator switches this module to a re-export of that file.
 */
export type HostSessionHost = 'claude' | 'codex';

export type HostSessionState = 'exited' | 'running' | 'terminated';

export interface HostSessionAuthority {
  readonly epochId: string;
  readonly install: string;
  readonly projectRoot: string;
}

export interface HostSession {
  readonly authority: HostSessionAuthority;
  readonly cols: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly host: HostSessionHost;
  readonly id: string;
  readonly pid?: number;
  readonly prompt?: string;
  readonly restartOf?: string;
  readonly rows: number;
  readonly signal?: string;
  readonly startedAt: number;
  readonly state: HostSessionState;
  /** The host's own session id once a hook receipt revealed it; the trace join key. */
  readonly traceSessionId?: string;
}

export interface HostAvailability {
  readonly executable?: string;
  readonly host: HostSessionHost;
  readonly launchable: boolean;
  readonly reason?: string;
}

export interface HostSessionLaunchRequest {
  readonly cols: number;
  readonly host: HostSessionHost;
  readonly prompt?: string;
  readonly rows: number;
}

export interface HostSessionSize {
  readonly cols: number;
  readonly rows: number;
}

export interface HostSessionList {
  readonly hosts: readonly HostAvailability[];
  readonly sessions: readonly HostSession[];
}
