import type { ApplicationLeaf } from '../application/application-tree-model.ts';
import type {
  HostAvailability,
  HostSession,
  HostSessionHost,
  HostSessionSize,
  HostSessionState,
} from '../../../agent-bundle/src/contracts/host-sessions.ts';

/** The Sessions pane's view of the list; scrollback belongs to xterm, not here. */
export interface HostSessionsState {
  readonly error?: string;
  readonly hosts: readonly HostAvailability[];
  readonly loaded: boolean;
  readonly sessions: readonly HostSession[];
}

export type HostSessionsAction =
  | Readonly<{ readonly hosts: readonly HostAvailability[]; readonly sessions: readonly HostSession[]; readonly type: 'list' }>
  /** A launch, terminate, restart response or a `state`/`end` frame: the record replaces its predecessor. */
  | Readonly<{ readonly session: HostSession; readonly type: 'session' }>
  | Readonly<{ readonly id: string; readonly type: 'forget' }>
  | Readonly<{ readonly message: string; readonly type: 'error' }>;

export const hosts: readonly HostSessionHost[] = Object.freeze(['claude', 'codex']);

/** A launch before any terminal has fitted its pane starts here; the first fit resizes it. */
export const defaultHostSessionSize: HostSessionSize = Object.freeze({ cols: 120, rows: 32 });

export const initialHostSessionsState: HostSessionsState = Object.freeze({ hosts: Object.freeze([]), loaded: false, sessions: Object.freeze([]) });

const newestFirst = (left: HostSession, right: HostSession): number =>
  right.startedAt - left.startedAt || left.id.localeCompare(right.id);

const sorted = (sessions: readonly HostSession[]): readonly HostSession[] => Object.freeze([...sessions].sort(newestFirst));

export const reduceHostSessions = (state: HostSessionsState, action: HostSessionsAction): HostSessionsState => {
  switch (action.type) {
    case 'list':
      return Object.freeze({ hosts: Object.freeze([...action.hosts]), loaded: true, sessions: sorted(action.sessions) });
    case 'session':
      return Object.freeze({
        ...state,
        error: undefined,
        sessions: sorted([...state.sessions.filter((session) => session.id !== action.session.id), action.session]),
      });
    case 'forget':
      return Object.freeze({ ...state, sessions: Object.freeze(state.sessions.filter((session) => session.id !== action.id)) });
    case 'error':
      return Object.freeze({ ...state, error: action.message, loaded: true });
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
};

export const hostLabel = (host: HostSessionHost): string => {
  switch (host) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    default: {
      const exhaustive: never = host;
      return exhaustive;
    }
  }
};

export const sessionStateLabel = (state: HostSessionState): string => {
  switch (state) {
    case 'running':
      return 'Running';
    case 'exited':
      return 'Exited';
    case 'terminated':
      return 'Terminated';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

export const availabilityFor = (available: readonly HostAvailability[], host: HostSessionHost): HostAvailability | undefined =>
  available.find((entry) => entry.host === host);

/** The prompt `Open in <host>` seeds for a route leaf; leaves without one offer no launch. */
export const hostSessionPromptFor = (leaf: ApplicationLeaf): string | undefined => {
  switch (leaf.ref.kind) {
    case 'tool':
      return leaf.routeId === undefined ? undefined : `Call the ${leaf.routeId} tool of this plugin and explain the result.`;
    case 'event':
      return `Trigger the ${leaf.ref.event} hook of this plugin and explain what it did.`;
    case 'cli':
      return `Run the ${leaf.ref.path.join(' ')} command of this plugin and explain the result.`;
    case 'resource':
    case 'prompt':
    case 'app':
    case 'script':
    case 'skill':
    case 'command':
    case 'rule':
      return undefined;
    default: {
      const exhaustive: never = leaf.ref;
      return exhaustive;
    }
  }
};
