import { assertFreshDist, workspaceBuildOutputs } from './scripts/dist-freshness.mjs';

/**
 * Refuses to start a pool over a stale or missing `dist` (#576). Unit,
 * route-unit and projection files import `@agent-bundle/runtime` and
 * `agent-bundle` from dist, and the process pools read
 * `packages/{agent-bundle,workbench}/dist`, so a green run over yesterday's
 * build proves nothing about today's sources. Runs once in the orchestrator
 * before any worker starts; the thrown Error fails the pool fast with the
 * rebuild instruction. The mtime rule and the per-package input lists live
 * in scripts/dist-freshness.mjs.
 */
export const setup = (): void => {
  assertFreshDist(workspaceBuildOutputs(import.meta.dirname), { relativeTo: import.meta.dirname });
};
