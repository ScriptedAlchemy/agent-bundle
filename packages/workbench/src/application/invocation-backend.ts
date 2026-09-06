/**
 * The one invocation abstraction the route workspace runs every executable
 * leaf through (#600 §3). Two backends satisfy it:
 *
 * - the dev-server backend (`POST /api/routes/invocations`), which renders any
 *   conventional route through the production runtime in a child process and
 *   is available for every project;
 * - the runtime-provider backend (`/api/runtime/runs`), which is present only
 *   when the project declares a `devRuntime` provider and maps a leaf onto a
 *   runtime surface; it adds run history, HMR generation tracking, and App
 *   preview bindings.
 *
 * The workspace never knows which backend answered: both yield the same
 * `RouteInvocation` envelope.
 */
import type {
  RunningRouteInvocation,
  RouteInvocation,
  RouteInvocationRequest,
  RouteInvocationStreamMessage,
  RouteInvocationSummary,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';

export type InvocationBackendKind = 'dev-server' | 'runtime';
export type InvocationBackendUpdate = RunningRouteInvocation | RouteInvocationStreamMessage;

export interface InvocationBackend {
  /** Names the backend for the inspector's "Execution" panel. */
  readonly kind: InvocationBackendKind;
  /** True when this backend can run the leaf; the workspace picks the first backend that accepts. */
  accepts(leaf: ApplicationLeaf): boolean;
  /** Runs the leaf and resolves with the completed envelope; rejects with an `InvocationClientError`. */
  invoke(
    leaf: ApplicationLeaf,
    request: RouteInvocationRequest,
    signal?: AbortSignal,
    listener?: (update: InvocationBackendUpdate) => void,
  ): Promise<RouteInvocation>;
  cancel?(invocationId: string, signal?: AbortSignal): Promise<RouteInvocation>;
  /** Recent invocations of the leaf this backend knows about, newest first. */
  history(leaf: ApplicationLeaf, signal?: AbortSignal): Promise<readonly RouteInvocationSummary[]>;
  /** Loads one invocation snapshot by id (deep links, trace entries). */
  read(invocationId: string, signal?: AbortSignal): Promise<RouteInvocation>;
  /** Fires when an invocation completes anywhere (this tab, another tab, a host); the trace and history subscribe. */
  subscribe(listener: (summary: RouteInvocationSummary) => void): () => void;
}
