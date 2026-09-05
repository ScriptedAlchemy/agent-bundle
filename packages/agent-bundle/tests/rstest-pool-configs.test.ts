import { execFile as executeFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from '@rstest/core';

import {
  examplePayloadGlobalSetup,
  poolTimeouts,
  processPoolMaxWorkers,
  processPoolTimeScale,
  workspaceGlobalSetup,
  workspaceSetupFiles,
} from '../../../rstest.pools.ts';
import { rstestHygiene } from '../../../rstest.rslib.ts';

/**
 * Pool-level policy the #576 audit found missing or uneven: every pool runs
 * the orchestrator hooks (stale-dist refusal, worker-root teardown), loads
 * the per-worker isolation setup before any other setup file, and carries an
 * explicit test/hook timeout floor. The adapter-level contract (libId,
 * plugin filtering, hygiene through `extends`) is
 * rstest-rslib-adapter.test.ts's; this file pins what each config spells out
 * itself.
 *
 * Inside a pool `@rstest/core` is the runtime API, without `defineConfig`,
 * so the configs cannot be imported here. A child Node process (type
 * stripping is on by default from Node 22.18) evaluates them the way the
 * `rstest` CLI does and reports the asserted fields.
 */

const execFile = promisify(executeFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const poolConfigs = [
  'rstest.config.ts',
  'rstest.unit.config.ts',
  'rstest.route-unit.config.ts',
  'rstest.projection.config.ts',
  'rstest.integration.config.ts',
  'rstest.packed.config.ts',
  'rstest.mcp-conformance.config.ts',
  'rstest.native-host.config.ts',
] as const;

type PoolConfigName = (typeof poolConfigs)[number];

interface ResolvedPoolConfig {
  readonly clearMocks?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly globalSetup?: string | readonly string[];
  readonly hookTimeout?: number;
  readonly maxWorkers?: number | string;
  readonly restoreMocks?: boolean;
  readonly setupFiles?: string | readonly string[];
  readonly testTimeout?: number;
  readonly unstubEnvs?: boolean;
  readonly unstubGlobals?: boolean;
}

const resolverSource = `
const names = ${JSON.stringify(poolConfigs)};
const out = {};
for (const name of names) {
  const { default: c } = await import('./' + name);
  out[name] = {
    clearMocks: c.clearMocks, env: c.env, globalSetup: c.globalSetup, hookTimeout: c.hookTimeout,
    maxWorkers: typeof c.pool === 'object' ? c.pool.maxWorkers : undefined, restoreMocks: c.restoreMocks,
    setupFiles: c.setupFiles, testTimeout: c.testTimeout, unstubEnvs: c.unstubEnvs, unstubGlobals: c.unstubGlobals,
  };
}
process.stdout.write(JSON.stringify(out));
`;

const list = (value: string | readonly string[] | undefined): readonly string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : value;

interface PoolExpectation {
  /** Setup files the pool appends after the shared isolation setup. */
  readonly extraSetupFiles: number;
  readonly globalSetup: readonly string[];
  readonly testTimeout: number;
}

const expectations: Readonly<Record<PoolConfigName, PoolExpectation>> = {
  'rstest.config.ts': { extraSetupFiles: 0, globalSetup: examplePayloadGlobalSetup, testTimeout: 30_000 },
  'rstest.integration.config.ts': { extraSetupFiles: 0, globalSetup: examplePayloadGlobalSetup, testTimeout: 30_000 },
  'rstest.mcp-conformance.config.ts': { extraSetupFiles: 0, globalSetup: workspaceGlobalSetup, testTimeout: 180_000 },
  'rstest.native-host.config.ts': { extraSetupFiles: 0, globalSetup: workspaceGlobalSetup, testTimeout: 60_000 },
  'rstest.packed.config.ts': { extraSetupFiles: 0, globalSetup: workspaceGlobalSetup, testTimeout: 120_000 },
  'rstest.projection.config.ts': { extraSetupFiles: 1, globalSetup: workspaceGlobalSetup, testTimeout: 30_000 },
  'rstest.route-unit.config.ts': { extraSetupFiles: 1, globalSetup: workspaceGlobalSetup, testTimeout: 30_000 },
  'rstest.unit.config.ts': { extraSetupFiles: 0, globalSetup: workspaceGlobalSetup, testTimeout: 15_000 },
};

let resolved: Readonly<Record<PoolConfigName, ResolvedPoolConfig>>;

beforeAll(async () => {
  const { stdout } = await execFile(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', '--input-type=module', '--eval', resolverSource],
    { cwd: workspaceRoot, maxBuffer: 8 * 1024 * 1024 },
  );
  resolved = JSON.parse(stdout) as Readonly<Record<PoolConfigName, ResolvedPoolConfig>>;
}, 60_000);

describe('shared pool policy', () => {
  it('names orchestrator hooks and a setup file that exist on disk', () => {
    for (const path of [...examplePayloadGlobalSetup, ...workspaceSetupFiles]) {
      expect(existsSync(resolve(workspaceRoot, path)), `${path} is missing`).toBe(true);
    }
    // Fail fast on a stale dist before a run id is handed out; the payload
    // build comes after both.
    expect(examplePayloadGlobalSetup.slice(0, workspaceGlobalSetup.length)).toEqual(workspaceGlobalSetup);
    expect(workspaceGlobalSetup[0]).toBe('./rstest.dist-freshness.setup.ts');
    expect(workspaceGlobalSetup).toContain('./rstest.global-setup.ts');
    expect(examplePayloadGlobalSetup.at(-1)).toBe('./rstest.integration.setup.ts');
  });

  it('gives hooks the same budget as tests', () => {
    expect(poolTimeouts(7_000)).toEqual({ hookTimeout: 7_000, testTimeout: 7_000 });
  });

  it('caps process pools at 1..4 workers and scales polling with the shape', () => {
    const workers = processPoolMaxWorkers();
    expect(workers).toBeGreaterThanOrEqual(1);
    if (process.env['AGENT_BUNDLE_INTEGRATION_MAX_WORKERS'] === undefined) expect(workers).toBeLessThanOrEqual(4);
    expect(processPoolTimeScale(1)).toBeGreaterThanOrEqual(1);
    expect(processPoolTimeScale(2)).toBeGreaterThanOrEqual(2);
  });
});

describe.each(poolConfigs.map((name) => [name, expectations[name]] as const))('%s', (name, expected) => {
  it('runs the orchestrator hooks', () => {
    expect(list(resolved[name].globalSetup), `${name}: globalSetup`).toEqual([...expected.globalSetup]);
  });

  it('loads the per-worker isolation setup first', () => {
    const setupFiles = list(resolved[name].setupFiles);
    expect(setupFiles.slice(0, workspaceSetupFiles.length), `${name}: setupFiles`).toEqual([...workspaceSetupFiles]);
    expect(setupFiles.length - workspaceSetupFiles.length, `${name}: extra setup files`).toBe(expected.extraSetupFiles);
  });

  it('sets an explicit test timeout and matches the hook timeout to it', () => {
    expect(resolved[name].testTimeout, `${name}: testTimeout`).toBe(expected.testTimeout);
    expect(resolved[name].hookTimeout, `${name}: hookTimeout`).toBe(expected.testTimeout);
  });
});

describe('helper-built pools', () => {
  it.each(['rstest.route-unit.config.ts', 'rstest.projection.config.ts'] as const)(
    '%s appends the generated route registry after the isolation setup and restores between tests',
    (name) => {
      const setupFiles = list(resolved[name].setupFiles);
      expect(setupFiles[1]).toMatch(/[\\/]\.agent-bundle[\\/]test[\\/]route-setup\.mjs$/u);
      expect(resolved[name]).toMatchObject(rstestHygiene);
    },
  );
});

describe('process pools', () => {
  it.each(['rstest.config.ts', 'rstest.integration.config.ts'] as const)('%s shares the worker cap and the polling scale', (name) => {
    const workers = processPoolMaxWorkers();
    expect(resolved[name].maxWorkers).toBe(workers);
    expect(resolved[name].env?.['AGENT_BUNDLE_TEST_TIME_SCALE']).toBe(String(processPoolTimeScale(workers)));
  });

  it('runs the conformance and native-host journeys on one worker', () => {
    expect(resolved['rstest.mcp-conformance.config.ts'].maxWorkers).toBe(1);
    expect(resolved['rstest.native-host.config.ts'].maxWorkers).toBe(1);
  });
});
