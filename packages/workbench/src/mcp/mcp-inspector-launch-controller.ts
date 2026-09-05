import { errorMessage } from '../client-helpers.ts';
import {
  createMcpInspectorLaunchModel,
  reduceMcpInspectorLaunch,
  type McpInspectorLaunchDiagnostic,
  type McpInspectorLaunchEvent,
  type McpInspectorLaunchModel,
} from './mcp-inspector-launch-model.ts';
import type { McpInspectorRouteStatus } from './mcp-route-client.ts';

export interface McpInspectorLaunchRoutes {
  inspectorLaunch(): Promise<Readonly<{ readonly url: string }>>;
  inspectorStatus(): Promise<McpInspectorRouteStatus>;
}

export type McpInspectorLaunchListener = (model: McpInspectorLaunchModel) => void;

export interface McpInspectorLaunchControllerOptions {
  readonly routes: McpInspectorLaunchRoutes;
}

export interface McpInspectorLaunchController {
  readonly model: McpInspectorLaunchModel;
  /**
   * Asks the dev server to launch the standalone Inspector. Publishes
   * `starting`, then `ready` with its tokenized URL or `error`. Never rejects;
   * concurrent calls while a launch is in flight share that one route call.
   */
  launch(): Promise<void>;
  /**
   * Re-reads the launcher status. A running Inspector publishes `ready`; any
   * other state publishes `idle` unless a launch is in flight. Never rejects.
   */
  refresh(): Promise<void>;
  /** Invokes `listener` immediately with the current model, then on every change. Listener exceptions are swallowed. */
  subscribe(listener: McpInspectorLaunchListener): () => void;
}

const LAUNCH_FAILED = Object.freeze({ code: 'mcp.inspector.launch.failed', message: 'MCP Inspector could not be launched.' });
const STATUS_FAILED = Object.freeze({ code: 'mcp.inspector.status.failed', message: 'MCP Inspector status is not available.' });

/** Route-client errors carry the server's diagnostic code as an own property; anything else gets the local fallback. */
const failureDiagnostic = (reason: unknown, fallback: McpInspectorLaunchDiagnostic): McpInspectorLaunchDiagnostic => {
  if (reason instanceof Error && Object.hasOwn(reason, 'code')) {
    const { code } = reason as Error & { readonly code?: unknown };
    if (typeof code === 'string') return { code, message: reason.message };
  }
  return { code: fallback.code, message: errorMessage(reason, fallback.message) || fallback.message };
};

class McpInspectorLaunchControllerImpl implements McpInspectorLaunchController {
  readonly #listeners = new Set<McpInspectorLaunchListener>();
  readonly #routes: McpInspectorLaunchRoutes;
  #launching: Promise<void> | undefined;
  /** Count of launches started; a refresh that began under an older count is superseded. */
  #launches = 0;
  #model = createMcpInspectorLaunchModel();

  constructor(options: McpInspectorLaunchControllerOptions) {
    this.#routes = options.routes;
  }

  get model(): McpInspectorLaunchModel {
    return this.#model;
  }

  launch(): Promise<void> {
    if (this.#launching !== undefined) return this.#launching;
    this.#launches += 1;
    this.#publish({ type: 'launch' });
    this.#launching = this.#runLaunch().finally(() => {
      this.#launching = undefined;
    });
    return this.#launching;
  }

  /**
   * A status read is evidence about the moment it was requested. One that began while a launch
   * was in flight, completes while one is in flight, or completes after a later launch began is
   * superseded and discarded: it would otherwise turn a fresh `ready` back into `idle` or erase
   * a launch diagnostic.
   */
  async refresh(): Promise<void> {
    const launches = this.#launches;
    const beganDuringLaunch = this.#launching !== undefined;
    const superseded = (): boolean => beganDuringLaunch || this.#launching !== undefined || launches !== this.#launches;
    try {
      const status = await this.#routes.inspectorStatus();
      if (superseded()) return;
      if (status.state === 'running' && status.url !== undefined) {
        this.#publish({ type: 'running', url: status.url });
      } else {
        this.#publish({ type: 'stopped' });
      }
    } catch (reason) {
      if (superseded()) return;
      this.#publish({ diagnostic: failureDiagnostic(reason, STATUS_FAILED), type: 'failed' });
    }
  }

  subscribe(listener: McpInspectorLaunchListener): () => void {
    this.#listeners.add(listener);
    this.#notify(listener, this.#model);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async #runLaunch(): Promise<void> {
    try {
      const { url } = await this.#routes.inspectorLaunch();
      this.#publish({ type: 'running', url });
    } catch (reason) {
      this.#publish({ diagnostic: failureDiagnostic(reason, LAUNCH_FAILED), type: 'failed' });
    }
  }

  #publish(event: McpInspectorLaunchEvent): void {
    const next = reduceMcpInspectorLaunch(this.#model, event);
    if (next === this.#model) return;
    this.#model = next;
    for (const listener of this.#listeners) this.#notify(listener, next);
  }

  #notify(listener: McpInspectorLaunchListener, model: McpInspectorLaunchModel): void {
    try {
      listener(model);
    } catch {
      // A view listener must not affect the launch lifecycle.
    }
  }
}

export const createMcpInspectorLaunchController = (options: McpInspectorLaunchControllerOptions): McpInspectorLaunchController =>
  new McpInspectorLaunchControllerImpl(options);
