import { setTimeout as delay } from 'node:timers/promises';

import { expect, it } from '@rstest/core';

import { runScript, scriptJson } from '../../src/test/index.ts';
import {
  AGENT_TEST_REGISTRY_SYMBOL_KEY,
  registerTestRoutes,
  type AgentStateModuleLoader,
  type AgentTestRouteRegistry,
} from '../../src/test/registry.ts';

/**
 * The generated rendered-script executable terminates its render worker the
 * moment its signal aborts: whatever the worker had not yet done — loading
 * the script module after the state mount, opening the render — never
 * happens. The harness renders in this process, where work already in flight
 * cannot be recalled, so it must refuse to start each following step once
 * the run has reported its cancellation.
 *
 * This file runs in a worker of its own: the fixture's evaluation counters
 * are zero when it starts, so they can tell "never loaded" from "loaded
 * late". The registered state loader is held at a gate the test controls,
 * which pins the abort to a known point — the state mount in flight — and
 * makes the run's continuation observable after the fact.
 */
const stateLoads = (): number => (globalThis as { routeHarnessStateLoads?: number }).routeHarnessStateLoads ?? 0;
const summaryLoads = (): number => (globalThis as { routeHarnessSummaryLoads?: number }).routeHarnessSummaryLoads ?? 0;

const registrySymbol = Symbol.for(AGENT_TEST_REGISTRY_SYMBOL_KEY);
const registeredRegistry = (): AgentTestRouteRegistry => {
  const registry = (globalThis as { [registrySymbol]?: AgentTestRouteRegistry })[registrySymbol];
  if (registry === undefined) throw new Error('The projection pool registered no test routes.');
  return registry;
};

it('loads no script module once a rendered run is aborted during its state mount, then prepares fully for the next accepted run', async () => {
  expect(stateLoads()).toBe(0);
  expect(summaryLoads()).toBe(0);

  const registry = registeredRegistry();
  const realStateLoader = registry.stateLoader;
  if (realStateLoader === undefined) throw new Error('The route-harness fixture registers a state loader.');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const mountStarted = new Promise<void>((resolve) => { entered = resolve; });
  const gatedStateLoader: AgentStateModuleLoader = async () => {
    entered();
    await gate;
    return realStateLoader();
  };
  registerTestRoutes({ ...registry, stateLoader: gatedStateLoader });
  try {
    const controller = new AbortController();
    const pending = runScript('summary', ['--json', 'aborted'], { signal: controller.signal });
    // The shell accepted argv, opened its session, loaded the renderer, and
    // is now inside the state mount, waiting at the gate.
    await mountStarted;
    controller.abort();
    const aborted = await pending;

    expect(aborted.exitCode).toBe(1);
    expect(aborted.stdout).toBe('');
    expect(aborted.stderr).toBe('Aborted.\n');
    expect(aborted.value).toBeUndefined();
    expect(summaryLoads()).toBe(0);

    // The mount that was in flight completes when released — the state
    // module evaluates, as the executable's worker could not have been kept
    // from finishing a load already begun — but the module load that would
    // have followed it never starts.
    release();
    await delay(250);
    expect(stateLoads()).toBe(1);
    expect(summaryLoads()).toBe(0);
  } finally {
    registerTestRoutes(registry);
  }

  const accepted = await runScript('summary', ['--json', 'after-abort']);
  expect(accepted.exitCode).toBe(0);
  expect(scriptJson(accepted)).toMatchObject({ arguments: ['after-abort'], stateMounted: true });
  expect(stateLoads()).toBe(1);
  expect(summaryLoads()).toBe(1);
}, 20_000);
