import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createJiti } from 'jiti';

import type { Diagnostic } from '../core/diagnostics.ts';
import { errorMessage } from '../core/errors.ts';
import { isInsideOrEqual } from '../core/paths.ts';
import { isRecord } from '../core/strict-json.ts';
import type {
  AgentBundleConfig,
  AgentBundleDevContractsConfig,
} from '../core/types.ts';
import type { ContractRouteFixture } from '../test/contract.ts';

export interface PreparedDevContractMatrix {
  readonly diagnostics: readonly Diagnostic[];
  readonly fixtures?: Readonly<Record<string, ContractRouteFixture>>;
  readonly modulePath: string;
  readonly server?: string;
}

const diagnostic = (sourcePath: string, message: string): Diagnostic => Object.freeze({
  code: 'AB7210',
  message,
  recovery: 'Correct dev.contracts and its fixture module, then rebuild; contract failures do not invalidate the artifact.',
  severity: 'error',
  sourcePath,
});

const invalid = (reason: string): never => {
  throw new TypeError(reason);
};

const optionalArray = (value: unknown, name: string): void => {
  if (value !== undefined && !Array.isArray(value)) invalid(`${name} must be an array when provided.`);
};

const fields = (value: Readonly<Record<string, unknown>>, allowed: readonly string[], name: string): void => {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0) invalid(`${name} has unknown field(s): ${unknown.sort().join(', ')}.`);
};

const requiredString = (value: unknown, name: string): void => {
  if (typeof value !== 'string' || value.length === 0) invalid(`${name} must be a nonempty string.`);
};

const requiredStringArray = (value: unknown, name: string): void => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    invalid(`${name} must be an array of strings.`);
  }
};

const lifecyclePhase = (value: unknown, name: string): void => {
  if (value !== 'setup' && value !== 'active' && value !== 'terminal') {
    invalid(`${name} must be "setup", "active", or "terminal".`);
  }
};

const lifecycleStateEntry = (
  value: unknown,
  name: string,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return invalid(`${name} must be an object.`);
  fields(value, allowed, name);
  return value;
};

const validateLifecycleState = (value: Readonly<Record<string, unknown>>, routeId: string): void => {
  const name = `Fixture ${JSON.stringify(routeId)} lifecycle.state`;
  fields(value, ['budget', 'durability', 'idempotency', 'journal', 'notice'], name);
  if (value.budget !== undefined) {
    const entry = lifecycleStateEntry(
      value.budget,
      `${name}.budget`,
      ['codePath', 'expectedCode', 'input', 'revisionPath'],
    );
    requiredStringArray(entry.codePath, `${name}.budget.codePath`);
    requiredString(entry.expectedCode, `${name}.budget.expectedCode`);
    requiredStringArray(entry.revisionPath, `${name}.budget.revisionPath`);
    if (!Object.hasOwn(entry, 'input')) invalid(`${name}.budget.input is required.`);
  }
  if (value.durability !== undefined) {
    const entry = lifecycleStateEntry(
      value.durability,
      `${name}.durability`,
      ['expectedStructuredContent', 'input'],
    );
    if (!Object.hasOwn(entry, 'expectedStructuredContent') || !Object.hasOwn(entry, 'input')) {
      invalid(`${name}.durability requires expectedStructuredContent and input.`);
    }
  }
  if (value.idempotency !== undefined) {
    const entry = lifecycleStateEntry(
      value.idempotency,
      `${name}.idempotency`,
      ['phase', 'replayedPath', 'revisionPath'],
    );
    lifecyclePhase(entry.phase, `${name}.idempotency.phase`);
    requiredStringArray(entry.replayedPath, `${name}.idempotency.replayedPath`);
    requiredStringArray(entry.revisionPath, `${name}.idempotency.revisionPath`);
  }
  if (value.journal !== undefined) {
    const entry = lifecycleStateEntry(value.journal, `${name}.journal`, ['expected', 'path']);
    if (!Object.hasOwn(entry, 'expected')) invalid(`${name}.journal.expected is required.`);
    requiredStringArray(entry.path, `${name}.journal.path`);
  }
  if (value.notice !== undefined) {
    const entry = lifecycleStateEntry(value.notice, `${name}.notice`, ['expected', 'path', 'phase']);
    if (!Object.hasOwn(entry, 'expected')) invalid(`${name}.notice.expected is required.`);
    requiredStringArray(entry.path, `${name}.notice.path`);
    lifecyclePhase(entry.phase, `${name}.notice.phase`);
  }
};

const validateLifecycle = (value: unknown, routeId: string): void => {
  if (value === undefined) return;
  if (!isRecord(value)) return invalid(`Fixture ${JSON.stringify(routeId)} lifecycle must be an object.`);
  fields(value, ['state', 'transitionDriver'], `Fixture ${JSON.stringify(routeId)} lifecycle`);
  if (typeof value.transitionDriver !== 'function') {
    return invalid(`Fixture ${JSON.stringify(routeId)} lifecycle must provide a transitionDriver function.`);
  }
  if (value.state !== undefined && !isRecord(value.state)) {
    return invalid(`Fixture ${JSON.stringify(routeId)} lifecycle.state must be an object when provided.`);
  }
  if (value.state !== undefined) validateLifecycleState(value.state, routeId);
};

const validateFixture = (value: unknown, routeId: string): ContractRouteFixture => {
  if (!isRecord(value)) return invalid(`Fixture ${JSON.stringify(routeId)} must be an object.`);
  fields(
    value,
    ['cancellation', 'input', 'inputs', 'kind', 'lifecycle', 'previousResults', 'resultCompat'],
    `Fixture ${JSON.stringify(routeId)}`,
  );
  if (value.kind !== undefined && value.kind !== 'resource') {
    return invalid(`Fixture ${JSON.stringify(routeId)} kind must be "resource" when provided.`);
  }
  if (value.resultCompat !== undefined && value.resultCompat !== 'additive' && value.resultCompat !== 'closed') {
    return invalid(`Fixture ${JSON.stringify(routeId)} resultCompat must be "additive" or "closed".`);
  }
  optionalArray(value.inputs, `Fixture ${JSON.stringify(routeId)} inputs`);
  optionalArray(value.previousResults, `Fixture ${JSON.stringify(routeId)} previousResults`);
  if (value.cancellation !== undefined) {
    if (!isRecord(value.cancellation)) {
      return invalid(`Fixture ${JSON.stringify(routeId)} cancellation must be an object when provided.`);
    }
    fields(
      value.cancellation,
      ['abortAfterMs', 'input'],
      `Fixture ${JSON.stringify(routeId)} cancellation`,
    );
    const abortAfterMs = value.cancellation.abortAfterMs;
    if (abortAfterMs !== undefined && (typeof abortAfterMs !== 'number' || !Number.isFinite(abortAfterMs) || abortAfterMs < 0)) {
      return invalid(`Fixture ${JSON.stringify(routeId)} cancellation.abortAfterMs must be a non-negative finite number.`);
    }
  }
  validateLifecycle(value.lifecycle, routeId);
  return Object.freeze({ ...value }) as ContractRouteFixture;
};

const validateFixtures = (value: unknown): Readonly<Record<string, ContractRouteFixture>> => {
  if (!isRecord(value)) return invalid('The development contract fixture module must default-export an object.');
  const fixtures: Record<string, ContractRouteFixture> = {};
  for (const [routeId, fixture] of Object.entries(value)) {
    if (routeId.trim().length === 0) return invalid('Development contract fixture route ids must be nonempty.');
    fixtures[routeId] = validateFixture(fixture, routeId);
  }
  return Object.freeze(fixtures);
};

const declaration = (config: AgentBundleConfig): AgentBundleDevContractsConfig | undefined => {
  const configured: unknown = config.dev?.contracts;
  if (configured === undefined) return undefined;
  if (!isRecord(configured) || typeof configured.fixtures !== 'string' || configured.fixtures.trim().length === 0) {
    return invalid('dev.contracts.fixtures must be a nonempty project-relative module path.');
  }
  fields(configured, ['fixtures', 'server'], 'dev.contracts');
  if (configured.server !== undefined && (typeof configured.server !== 'string' || configured.server.trim().length === 0)) {
    invalid('dev.contracts.server must be a nonempty string when provided.');
  }
  return configured as unknown as AgentBundleDevContractsConfig;
};

/** Loads the optional dev-only fixture module without making its diagnostics build-fatal. */
export const loadDevContractMatrix = async (
  config: AgentBundleConfig,
  configPath: string,
  projectRoot: string,
): Promise<PreparedDevContractMatrix | undefined> => {
  let configured: AgentBundleDevContractsConfig | undefined;
  try {
    configured = declaration(config);
  } catch (error) {
    return Object.freeze({
      diagnostics: Object.freeze([diagnostic(configPath, errorMessage(error))]),
      modulePath: configPath,
    });
  }
  if (configured === undefined) return undefined;
  const requestedPath = resolve(dirname(configPath), configured.fixtures);
  const base = {
    modulePath: requestedPath,
    ...(configured.server === undefined ? {} : { server: configured.server }),
  };
  try {
    const [root, modulePath] = await Promise.all([realpath(projectRoot), realpath(requestedPath)]);
    if (!isInsideOrEqual(root, modulePath)) {
      invalid('dev.contracts.fixtures must resolve inside the project root.');
    }
    const jiti = createJiti(configPath, {
      interopDefault: true,
      jsx: { runtime: 'automatic' },
      moduleCache: false,
      nativeModules: ['typescript'],
    });
    const exported = await jiti.import<unknown>(modulePath, { default: true });
    return Object.freeze({
      diagnostics: Object.freeze([]),
      fixtures: validateFixtures(exported),
      modulePath,
      ...(configured.server === undefined ? {} : { server: configured.server }),
    });
  } catch (error) {
    return Object.freeze({
      ...base,
      diagnostics: Object.freeze([diagnostic(requestedPath, errorMessage(error))]),
    });
  }
};
