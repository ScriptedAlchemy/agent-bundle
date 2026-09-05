import { readFile } from 'node:fs/promises';

import {
  isServeAppAllowCapability,
  type ServeAppAllowCapability,
} from '../core/mcp-app-allow.ts';
import { hasDataKeys, isPlainRecord } from '../core/strict-json.ts';

export interface WebManifestApp {
  readonly allow: readonly ServeAppAllowCapability[];
  readonly app: string;
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

type JsonRecord = Record<string, unknown>;

const prefix = 'agent-bundle.manifest.json web section is invalid:';

const fail = (message: string): never => {
  throw new Error(`${prefix} ${message}`);
};

const record = (value: unknown, location: string): JsonRecord =>
  isPlainRecord(value) ? value as JsonRecord : fail(`${location} must be a plain object.`);

/** Exact required/optional key contract (`hasDataKeys`), naming the location and expected keys on failure. */
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

const stringRecord = (value: unknown, location: string): Readonly<Record<string, string>> => {
  const candidate = record(value, location);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(candidate)) {
    if (typeof entry !== 'string') fail(`${location}.${key} must be a string.`);
    result[key] = entry as string;
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
    ['allow', 'app', 'entry', 'env', 'name', 'resourceUri', 'server'],
    ['input', 'tool'],
  );
  if (!Array.isArray(app.allow)) fail(`${location}.allow must be an array.`);
  const declaredAllow = app.allow as unknown[];
  const allow = declaredAllow.map((capability: unknown, capabilityIndex: number) => {
    if (typeof capability !== 'string' || !isServeAppAllowCapability(capability)) {
      return fail(`${location}.allow[${capabilityIndex}] is not an App-initiated consent capability.`);
    }
    return capability;
  });
  return {
    allow,
    app: string(app.app, `${location}.app`),
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
  if (!Array.isArray(manifest.apps)) fail('apps must be an array.');
  if (manifest.open !== 'browser' && manifest.open !== 'never') {
    fail('open must be "browser" or "never".');
  }
  const apps = (manifest.apps as unknown[]).map(parseApp);
  for (let index = 1; index < apps.length; index += 1) {
    if (apps[index - 1]!.app.localeCompare(apps[index]!.app) >= 0) {
      fail('apps must be sorted by app with no duplicates.');
    }
  }
  return { apps, open: manifest.open as WebManifest['open'] };
};

export const readWebManifest = async (manifestPath: string): Promise<WebManifest | undefined> => {
  try {
    const document: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    const manifest = record(document, 'manifest');
    return manifest['web'] === undefined ? undefined : parseWebManifest(manifest['web']);
  } catch (error) {
    throw new Error(`Unable to read web section from ${manifestPath}: ${(error as Error).message}`, { cause: error });
  }
};
