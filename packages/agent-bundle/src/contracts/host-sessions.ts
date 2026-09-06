export type HostSessionHost = 'claude' | 'codex';
export type HostSessionState = 'running' | 'exited' | 'terminated';

export interface HostSession {
  readonly id: string;
  readonly host: HostSessionHost;
  readonly state: HostSessionState;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly pid?: number;
  readonly cols: number;
  readonly rows: number;
  readonly prompt?: string;
  readonly authority: {
    readonly projectRoot: string;
    readonly epochId: string;
    readonly install: string;
  };
  readonly restartOf?: string;
  readonly traceSessionId?: string;
}

export interface HostAvailability {
  readonly host: HostSessionHost;
  readonly launchable: boolean;
  readonly reason?: string;
  readonly executable?: string;
}
