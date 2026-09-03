import type { ScriptRouteProps } from 'agent-bundle';

/**
 * A rendered script whose module never finishes evaluating. The generated
 * executable loads it inside its render worker; only an abort — SIGINT or
 * SIGTERM failing the parent stream and terminating the worker — ends the
 * run, so the harness must honor an abort while the module is still loading.
 */
await new Promise<never>(() => undefined);

export default function Stalled(_props: ScriptRouteProps) {
  return null;
}
