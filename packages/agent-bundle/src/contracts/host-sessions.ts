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

export interface HostSessionSize {
  readonly cols: number;
  readonly rows: number;
}

export interface HostSessionLaunchRequest extends HostSessionSize {
  readonly host: HostSessionHost;
  readonly prompt?: string;
}

export interface HostSessionList {
  readonly hosts: readonly HostAvailability[];
  readonly sessions: readonly HostSession[];
}

export const isHostSessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^hs_[0-9a-z]{16}$/.test(value);
