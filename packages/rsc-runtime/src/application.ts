import type { RscOperationDefinition } from './operation.js';

/**
 * Framework mode's application: structure (targets, skills, servers,
 * scripts) lives in `agent-bundle.config.ts` and file conventions; the
 * application is only the runtime identity plus the operation catalog whose
 * results the RSC layer renders.
 */
export interface RscApplicationOptions {
  readonly description?: string;
  readonly name: string;
  readonly operations: readonly Readonly<RscOperationDefinition>[];
  readonly version: string;
}

/** Structurally identical to its options: validation freezes but never reshapes. */
export type RscApplication = RscApplicationOptions;

const canonicalName = /^[a-z][a-z0-9._-]{0,63}$/u;

const duplicate = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) {
    throw new Error(`RSC application contains a duplicate ${label}`);
  }
};

export const defineRscApplication = (
  options: RscApplicationOptions,
): Readonly<RscApplication> => {
  if (typeof options.name !== 'string' || !canonicalName.test(options.name)) {
    throw new Error('RSC application name must be a canonical lowercase identifier');
  }
  if (typeof options.version !== 'string' || options.version.trim() === '') {
    throw new Error('RSC application version must be non-empty');
  }
  if (options.description !== undefined && (typeof options.description !== 'string' || options.description.trim() === '')) {
    throw new Error('RSC application description must be non-empty when present');
  }
  const operations = [...options.operations];
  for (const operation of operations) {
    if (operation === null || typeof operation !== 'object' || !Object.isFrozen(operation)) {
      throw new Error('RSC application operations must come from defineOperation');
    }
  }
  duplicate(operations.map((operation) => operation.id), 'operation id');
  duplicate(operations.flatMap((operation) => operation.cli === undefined ? [] : [operation.cli.name]), 'CLI command');
  duplicate(
    operations.flatMap((operation) => operation.mcp === undefined ? [] : [`${operation.mcp.server}:${operation.mcp.name}`]),
    'MCP tool',
  );

  return Object.freeze({
    ...(options.description === undefined ? {} : { description: options.description }),
    name: options.name,
    operations: Object.freeze(operations),
    version: options.version,
  });
};
