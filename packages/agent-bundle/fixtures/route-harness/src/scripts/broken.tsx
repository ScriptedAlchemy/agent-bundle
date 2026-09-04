import type { ScriptRouteProps } from 'agent-bundle';

/**
 * A rendered script whose module fails to evaluate. The generated executable
 * loads it inside its render worker and the failure reaches the shell as an
 * event-stream error: stderr carries the message and the process exits 1.
 */
const tally = globalThis as { routeHarnessBrokenLoads?: number };
tally.routeHarnessBrokenLoads = (tally.routeHarnessBrokenLoads ?? 0) + 1;

const loadFailure = ((): Error | undefined => new Error('broken script failed to load'))();
if (loadFailure !== undefined) throw loadFailure;

export default function Broken(_props: ScriptRouteProps) {
  return null;
}
