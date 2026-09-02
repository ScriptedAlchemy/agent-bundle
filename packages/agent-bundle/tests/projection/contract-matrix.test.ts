import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';

import stateDefinition from '../../fixtures/route-harness/src/state.ts';
import { AgentTestError } from '../../src/test/errors.ts';
import { MCP_IN_MEMORY_PROOF_LEVEL, proofLevelLabel } from '../../src/test/manifest.ts';
import {
  runContractMatrix,
  type ContractMatrixOptions,
  type ContractRouteFixture,
} from '../../src/test/contract.ts';

const proofLabel = proofLevelLabel(MCP_IN_MEMORY_PROOF_LEVEL);

const baseFixtures = (): Record<string, ContractRouteFixture> => ({
  'prompt:harness/summarize': { input: { note: 'chapter one' } },
  'resource:harness/notes': {},
  'tool:harness/catalog': { input: { genre: 'mystery' }, resultCompat: 'additive' },
  'tool:harness/echo': { input: { message: 'contract matrix' }, resultCompat: 'additive' },
  'tool:harness/journal': { input: { note: 'matrix proof' }, resultCompat: 'closed' },
  'tool:harness/publish-notice': {
    input: { message: 'matrix notice', recipientSession: 'matrix-session' },
    resultCompat: 'closed',
  },
  'tool:harness/strict-report': { input: { reportId: 'closed-1' }, resultCompat: 'closed' },
  'tool:harness/ticket': {
    input: { status: 'completed' },
    inputs: [{ status: 'pending' }, { includeDiagnostics: true, status: 'running' }],
    previousResults: [{ status: 'completed' }],
    resultCompat: 'additive',
  },
  'tool:harness/unavailable': { resultCompat: 'additive' },
  'tool:harness/wait': {
    cancellation: { abortAfterMs: 50, input: { holdMs: 5000 } },
    input: { holdMs: 1 },
    resultCompat: 'additive',
  },
});

const withStatefulMatrix = async <T>(
  fixtures: Record<string, ContractRouteFixture>,
  body: (options: ContractMatrixOptions) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-contract-matrix-'));
  try {
    return await body({
      fixtures,
      state: {
        definition: stateDefinition,
        driver: createSqliteStateDriver({ root }),
      },
    } as unknown as ContractMatrixOptions);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe('the generated-plugin contract matrix', () => {
  it('passes every check for the route-harness server at mcp-in-memory', async () => {
    const report = await withStatefulMatrix(baseFixtures(), (options) => runContractMatrix(options));

    expect(report.provenance.proofLevel).toBe('mcp-in-memory');
    expect(report.routes['tool:harness/wait']?.checks.cancellation).toEqual({ status: 'passed' });
    expect(report.routes['tool:harness/ticket']?.checks['version-skew']).toEqual({ status: 'passed' });
    expect(report.routes['app:harness/panel']?.checks['surface-completeness']).toEqual({
      reason: 'MCP Apps are not registered by the in-memory projection level.',
      status: 'not-applicable',
    });
    expect(report.routes['tool:harness/unavailable']?.checks.sweep).toEqual({
      reason: 'Invocation returned isError; sweep proves successful invocation paths only.',
      status: 'not-applicable',
    });
  }, 30_000);

  it('aggregates missing route coverage with the proof-level label', async () => {
    const fixtures = { ...baseFixtures() };
    delete fixtures['tool:harness/echo'];

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/echo');
    expect((error as AgentTestError).message).toContain('coverage');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates unknown fixture keys with the proof-level label', async () => {
    const fixtures = {
      ...baseFixtures(),
      'tool:harness/missing-route': { input: {} },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/missing-route');
    expect((error as AgentTestError).message).toContain('coverage');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates additive declared on a closed schema with the proof-level label', async () => {
    const fixtures = {
      ...baseFixtures(),
      'tool:harness/strict-report': { input: {}, resultCompat: 'additive' as const },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/strict-report');
    expect((error as AgentTestError).message).toContain('compat-probe');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates closed declared on an additive schema with the proof-level label', async () => {
    const fixtures = {
      ...baseFixtures(),
      'tool:harness/ticket': { input: { status: 'completed' }, resultCompat: 'closed' as const },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/ticket');
    expect((error as AgentTestError).message).toContain('compat-probe');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates previousResults schema violations with the proof-level label', async () => {
    const fixtures = {
      ...baseFixtures(),
      'tool:harness/ticket': {
        input: { status: 'completed' },
        previousResults: [{ status: 'not-a-valid-status' }],
        resultCompat: 'additive' as const,
      },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/ticket');
    expect((error as AgentTestError).message).toContain('version-skew');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);

  it('aggregates missing resultCompat on a tool with the proof-level label', async () => {
    const fixtures = {
      ...baseFixtures(),
      'tool:harness/echo': { input: { message: 'no policy' } },
    };

    const error = await withStatefulMatrix(fixtures, (options) =>
      runContractMatrix(options).catch((thrown: unknown) => thrown));

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('contract-violation');
    expect((error as AgentTestError).message).toContain('tool:harness/echo');
    expect((error as AgentTestError).message).toContain('compat-probe');
    expect((error as AgentTestError).message).toContain(proofLabel);
  }, 30_000);
});
