import { readFile } from 'node:fs/promises';

import {
  isServeAppAllowCapability,
  type ServeAppAllowCapability,
} from '../core/mcp-app-allow.ts';
import { errorMessage } from '../core/errors.ts';
import { hasDataKeys, isPlainRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';

export interface WebManifestApp {
  readonly allow: readonly ServeAppAllowCapability[];
  readonly app: string;
  /** The server's declared arguments after its entry, path tokens unexpanded. */
  readonly args: readonly string[];
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly resourceUri: string;
  readonly server: string;
  readonly tool?: string;
}

export interface WebManifest {
  readonly apps: readonly WebManifestApp[];
  readonly open: 'browser' | 'never';
}

type JsonRecord = Readonly<Record<string, unknown>>;

const prefix = 'agent-bundle.manifest.json web section is invalid:';

const invalid = (message: string): Error => new Error(`${prefix} ${message}`);

const fail = (message: string): never => {
  throw invalid(message);
};

const record = (value: unknown, location: string): JsonRecord =>
  isPlainRecord(value) ? value : fail(`${location} must be a plain object.`);

const keyedRecord = (
  value: unknown,
  location: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonRecord => {
  const candidate = record(value, location);
  if (hasDataKeys(candidate, required, optional)) return candidate;
  const expected = [...required, ...optional.map((key) => `${key}?`)].join(', ');
  return fail(`${location} must have exactly the keys ${expected}; found ${Object.keys(candidate).join(', ') || 'none'}.`);
};

const string = (value: unknown, location: string): string =>
  typeof value === 'string' && value.length > 0
    ? value
    : fail(`${location} must be a non-empty string.`);

const stringArray = (value: unknown, location: string): readonly string[] => {
  if (!Array.isArray(value)) throw invalid(`${location} must be an array.`);
  return value.map((entry: unknown, index: number) =>
    typeof entry === 'string' ? entry : fail(`${location}[${index}] must be a string.`));
};

const stringRecord = (value: unknown, location: string): Readonly<Record<string, string>> => {
  const candidate = record(value, location);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(candidate)) {
    if (typeof entry !== 'string') throw invalid(`${location}.${key} must be a string.`);
    result[key] = entry;
  }
  return result;
};

const inputRecord = (value: unknown, location: string): Readonly<Record<string, unknown>> =>
  record(value, location);

const parseApp = (value: unknown, index: number): WebManifestApp => {
  const location = `apps[${index}]`;
  const app = keyedRecord(
    value,
    location,
    ['allow', 'app', 'args', 'entry', 'env', 'name', 'resourceUri', 'server'],
    ['input', 'tool'],
  );
  if (!Array.isArray(app.allow)) throw invalid(`${location}.allow must be an array.`);
  const allow = app.allow.map((capability: unknown, capabilityIndex: number) => {
    if (typeof capability !== 'string' || !isServeAppAllowCapability(capability)) {
      return fail(`${location}.allow[${capabilityIndex}] is not an App-initiated consent capability.`);
    }
    return capability;
  });
  return {
    allow,
    app: string(app.app, `${location}.app`),
    args: stringArray(app.args, `${location}.args`),
    entry: string(app.entry, `${location}.entry`),
    env: stringRecord(app.env, `${location}.env`),
    ...(app.input === undefined ? {} : { input: inputRecord(app.input, `${location}.input`) }),
    name: string(app.name, `${location}.name`),
    resourceUri: string(app.resourceUri, `${location}.resourceUri`),
    server: string(app.server, `${location}.server`),
    ...(app.tool === undefined ? {} : { tool: string(app.tool, `${location}.tool`) }),
  };
};

export const parseWebManifest = (value: unknown): WebManifest => {
  const manifest = keyedRecord(value, 'root', ['apps', 'open']);
  if (!Array.isArray(manifest.apps)) throw invalid('apps must be an array.');
  if (manifest.open !== 'browser' && manifest.open !== 'never') {
    throw invalid('open must be "browser" or "never".');
  }
  const apps = manifest.apps.map(parseApp);
  for (let index = 1; index < apps.length; index += 1) {
    if (apps[index - 1]!.app.localeCompare(apps[index]!.app) >= 0) {
      fail('apps must be sorted by app with no duplicates.');
    }
  }
  return { apps, open: manifest.open };
};

/** The web-relevant read of one artifact manifest: the exposed Apps and the declared projections. */
export interface WebManifestDocument {
  /** The projection names the artifact manifest declares for this composite root. */
  readonly targets: readonly string[];
  readonly web?: WebManifest;
}

const projectionHosts = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((projection: unknown) => {
    if (!isPlainRecord(projection)) return [];
    const host = projection['host'];
    return typeof host === 'string' && host.length > 0 ? [host] : [];
  }));
};

export const readWebManifestDocument = async (manifestPath: string): Promise<WebManifestDocument> => {
  try {
    const document = parseJsonWithoutDuplicateKeys(await readFile(manifestPath, 'utf8'));
    const manifest = record(document, 'manifest');
    return {
      targets: projectionHosts(manifest['projections']),
      ...(manifest['web'] === undefined ? {} : { web: parseWebManifest(manifest['web']) }),
    };
  } catch (error) {
    throw new Error(`Unable to read web section from ${manifestPath}: ${errorMessage(error)}`, { cause: error });
  }
};

export const readWebManifest = async (manifestPath: string): Promise<WebManifest | undefined> =>
  (await readWebManifestDocument(manifestPath)).web;
