/**
 * Closed-key inventory for `artifactManifestSchema`.
 *
 * `manifestVersion` (and `compiler.recordVersion`) bump on any change an old
 * closed reader would reject: add, rename, or remove a key (optional or not),
 * or change an enumerated value set a reader closes. Within one version the
 * inventory is frozen. Optional is not backward compatible.
 *
 * Regenerate after such a change (bump the version constant and add
 * `manifest-keys.vN+1.json` / `manifest-compiler-keys.vN+1.json`):
 *
 * `MANIFEST_KEYS_WRITE=1 pnpm exec rstest -c rstest.unit.config.ts packages/agent-bundle/tests/manifest-key-inventory.test.ts`
 *
 * or `node --experimental-strip-types packages/agent-bundle/tests/manifest-key-inventory.test.ts --write`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  artifactCompilerRecordVersion,
  artifactManifestVersion,
} from '../src/build/manifest.ts';
import { artifactManifestSchema } from '../src/build/manifest-schema.ts';
import { isRecord, snapshotStrictJsonValue, type JsonObject, type JsonValue } from '../src/core/strict-json.ts';

type SchemaNode = Readonly<Record<string, unknown>>;

const packageRoot = join(process.cwd(), 'packages/agent-bundle');

interface KeyInventory {
  readonly enums: Readonly<Record<string, readonly JsonValue[]>>;
  readonly keys: readonly string[];
}

interface PublicKeyInventory extends KeyInventory {
  readonly manifestVersion: number;
}

interface CompilerKeyInventory extends KeyInventory {
  readonly recordVersion: number;
}

const defsOf = (schema: JsonObject): JsonObject => {
  const defs = schema.$defs;
  if (!isRecord(defs)) throw new TypeError('artifactManifestSchema is missing $defs.');
  return defs;
};

const resolveRef = (schema: JsonObject, ref: string): SchemaNode => {
  const prefix = '#/$defs/';
  if (!ref.startsWith(prefix)) {
    throw new TypeError(`Unsupported schema $ref ${JSON.stringify(ref)}.`);
  }
  const resolved = defsOf(schema)[ref.slice(prefix.length)];
  if (!isRecord(resolved)) {
    throw new TypeError(`artifactManifestSchema $defs is missing ${JSON.stringify(ref)}.`);
  }
  return resolved;
};

const deref = (schema: JsonObject, node: SchemaNode): SchemaNode => {
  const ref = node.$ref;
  if (typeof ref !== 'string') return node;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== '$ref') rest[key] = value;
  }
  return { ...resolveRef(schema, ref), ...rest };
};

const childPath = (path: string, segment: string): string =>
  path === '' ? segment : `${path}.${segment}`;

const compareJson = (left: JsonValue, right: JsonValue): number =>
  JSON.stringify(left).localeCompare(JSON.stringify(right));

const recordEnum = (
  enums: Map<string, JsonValue[]>,
  path: string,
  values: readonly JsonValue[],
): void => {
  const existing = enums.get(path) ?? [];
  const seen = new Set(existing.map((value) => JSON.stringify(value)));
  for (const value of values) {
    const serialized = JSON.stringify(value);
    if (!seen.has(serialized)) {
      seen.add(serialized);
      existing.push(value);
    }
  }
  existing.sort(compareJson);
  enums.set(path, existing);
};

const walk = (
  schema: JsonObject,
  node: SchemaNode,
  path: string,
  keys: Set<string>,
  enums: Map<string, JsonValue[]>,
  skipProperties: ReadonlySet<string>,
): void => {
  const resolved = deref(schema, node);
  if (Array.isArray(resolved.enum)) {
    recordEnum(enums, path, resolved.enum.map((value) => snapshotStrictJsonValue(value)));
  }
  if (Object.hasOwn(resolved, 'const')) {
    recordEnum(enums, path, [snapshotStrictJsonValue(resolved.const)]);
  }

  const properties = resolved.properties;
  if (isRecord(properties)) {
    for (const [key, property] of Object.entries(properties)) {
      if (!isRecord(property)) continue;
      const next = childPath(path, key);
      keys.add(next);
      if (skipProperties.has(next)) continue;
      walk(schema, property, next, keys, enums, skipProperties);
    }
  }

  const items = resolved.items;
  if (isRecord(items)) {
    walk(schema, items, `${path}[]`, keys, enums, skipProperties);
  } else if (Array.isArray(items)) {
    for (const item of items) {
      if (isRecord(item)) walk(schema, item, `${path}[]`, keys, enums, skipProperties);
    }
  }

  const additional = resolved.additionalProperties;
  if (isRecord(additional)) {
    walk(schema, additional, `${path}.*`, keys, enums, skipProperties);
  }

  for (const combinator of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = resolved[combinator];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (isRecord(branch)) walk(schema, branch, path, keys, enums, skipProperties);
    }
  }
};

const freezeInventory = (keys: Set<string>, enums: Map<string, JsonValue[]>): KeyInventory => {
  const enumRecord: Record<string, readonly JsonValue[]> = {};
  for (const path of [...enums.keys()].sort((left, right) => left.localeCompare(right))) {
    enumRecord[path] = enums.get(path) ?? [];
  }
  return {
    enums: enumRecord,
    keys: [...keys].sort((left, right) => left.localeCompare(right)),
  };
};

const publicContractInventory = (schema: JsonObject): PublicKeyInventory => {
  const keys = new Set<string>();
  const enums = new Map<string, JsonValue[]>();
  walk(schema, schema, '', keys, enums, new Set(['compiler']));
  return {
    ...freezeInventory(keys, enums),
    manifestVersion: artifactManifestVersion,
  };
};

const compilerRecordInventory = (schema: JsonObject): CompilerKeyInventory => {
  const compiler = defsOf(schema).compiler;
  if (!isRecord(compiler)) throw new TypeError('artifactManifestSchema is missing $defs/compiler.');
  const keys = new Set<string>();
  const enums = new Map<string, JsonValue[]>();
  walk(schema, compiler, '', keys, enums, new Set());
  return {
    ...freezeInventory(keys, enums),
    recordVersion: artifactCompilerRecordVersion,
  };
};

const publicFixturePath = join(packageRoot, `tests/fixtures/manifest-keys.v${String(artifactManifestVersion)}.json`);
const compilerFixturePath = join(
  packageRoot,
  `tests/fixtures/manifest-compiler-keys.v${String(artifactCompilerRecordVersion)}.json`,
);

const writeKeyInventoryFixtures = (): void => {
  writeFileSync(publicFixturePath, `${JSON.stringify(publicContractInventory(artifactManifestSchema), null, 2)}\n`);
  writeFileSync(compilerFixturePath, `${JSON.stringify(compilerRecordInventory(artifactManifestSchema), null, 2)}\n`);
};

if (process.env.MANIFEST_KEYS_WRITE === '1' || process.argv.includes('--write')) {
  writeKeyInventoryFixtures();
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

it('pins the closed public-contract key inventory of the current manifestVersion', () => {
  const actual = publicContractInventory(artifactManifestSchema);
  const expected = readJson(publicFixturePath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `the key inventory of manifestVersion ${String(artifactManifestVersion)} changed; bump \`artifactManifestVersion\` (and add \`manifest-keys.v${String(artifactManifestVersion + 1)}.json\`) — a closed reader of version ${String(artifactManifestVersion)} rejects this document`,
    );
  }
  expect(actual.keys).toContain('executables.mcpServers[].apps[].resourceUri');
  expect(actual).toEqual(expected);
});

it('pins the closed compiler-record key inventory of the current recordVersion', () => {
  const actual = compilerRecordInventory(artifactManifestSchema);
  const expected = readJson(compilerFixturePath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `the key inventory of compiler.recordVersion ${String(artifactCompilerRecordVersion)} changed; bump \`artifactCompilerRecordVersion\` (and add \`manifest-compiler-keys.v${String(artifactCompilerRecordVersion + 1)}.json\`) — a closed reader of version ${String(artifactCompilerRecordVersion)} rejects this document`,
    );
  }
  expect(actual).toEqual(expected);
});
