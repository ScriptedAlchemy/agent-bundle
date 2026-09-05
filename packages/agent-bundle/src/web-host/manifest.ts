import { readFile } from 'node:fs/promises';

import {
  isServeAppAllowCapability,
  type ServeAppAllowCapability,
} from '../core/mcp-app-allow.ts';
import { errorMessage } from '../core/errors.ts';
import { isRelocatablePosixPath } from '../core/paths.ts';
import { hasDataKeys, isPlainRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { pathTokens } from '../core/types.ts';

/**
 * The `manifestVersion` every reader of `agent-bundle.manifest.json` requires,
 * declared here so the lean web reader bundled into generated bins and the
 * full parser in `build/manifest.ts` refuse the same set of documents.
 */
export const artifactManifestVersion = 2;

/** The roots the `agent-bundle:path:*` tokens of a launch record expand to. */
export interface LaunchRoots {
  readonly pluginData: string;
  readonly pluginRoot: string;
  readonly workspaceRoot: string;
}

export const expandLaunchTokens = (value: string, roots: LaunchRoots): string => value
  .replaceAll(pathTokens.pluginRoot, roots.pluginRoot)
  .replaceAll(pathTokens.pluginData, roots.pluginData)
  .replaceAll(pathTokens.workspaceRoot, roots.workspaceRoot);

/**
 * One argument of a server launch record, after the entry. An author
 * argument written as `agent-bundle:path:plugin-root/<path>` is an
 * `artifact` reference — a root-relative POSIX path inside the composite root
 * (a `files[]` row, or a path under a declared payload directory). Every other
 * argument is a `literal` the launcher passes through with its remaining
 * `agent-bundle:path:*` tokens expanded; a literal that merely looks like a
 * path stays a literal, because the manifest records the author's declaration
 * and cwd-relative normalization is a projection concern (#633).
 */
export type ArtifactManifestLaunchArgument =
  | { readonly kind: 'artifact'; readonly path: string }
  | { readonly kind: 'literal'; readonly value: string };

/**
 * The one launch record of a compiled or prebuilt MCP server
 * (`executables.mcpServers[]` with `kind: 'compiled'` or `'prebuilt'`): what
 * `<plugin> web` starts and what every host MCP document projects. Tokens in
 * `args` and `env` are expanded by the launcher, never by the manifest.
 */
export interface ArtifactManifestLaunch {
  /** Arguments after the entry, in order. */
  readonly args: readonly ArtifactManifestLaunchArgument[];
  /** Root-relative POSIX path of the entry (a `files[]` row). */
  readonly entry: string;
  /** Declared environment; values may carry `agent-bundle:path:*` tokens. */
  readonly env: Readonly<Record<string, string>>;
  /** Root-relative POSIX path of the Flight worker the entry spawns (a `files[]` row). */
  readonly worker?: string;
}

export interface WebManifestApp {
  readonly allow: readonly ServeAppAllowCapability[];
  readonly app: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly resourceUri: string;
  /** The configured server name; its launch is the `executables.mcpServers[]` row of that name. */
  readonly server: string;
  readonly tool?: string;
}

export interface WebManifest {
  readonly apps: readonly WebManifestApp[];
  readonly open: 'browser' | 'never';
}

type JsonRecord = Readonly<Record<string, unknown>>;

const prefix = 'agent-bundle.manifest.json is invalid:';

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

const relativePath = (value: unknown, location: string): string => {
  const path = string(value, location);
  return isRelocatablePosixPath(path) ? path : fail(`${location} must be a safe relative POSIX path.`);
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

const parseLaunchArgument = (value: unknown, location: string): ArtifactManifestLaunchArgument => {
  const argument = record(value, location);
  switch (argument.kind) {
    case 'artifact':
      keyedRecord(argument, location, ['kind', 'path']);
      return { kind: 'artifact', path: relativePath(argument.path, `${location}.path`) };
    case 'literal':
      keyedRecord(argument, location, ['kind', 'value']);
      if (typeof argument.value !== 'string') throw invalid(`${location}.value must be a string.`);
      return { kind: 'literal', value: argument.value };
    default:
      return fail(`${location}.kind must be "artifact" or "literal".`);
  }
};

/** Parses one launch record; `location` names the row for the failure message. */
export const parseLaunch = (value: unknown, location: string): ArtifactManifestLaunch => {
  const launch = keyedRecord(value, location, ['args', 'entry', 'env'], ['worker']);
  if (!Array.isArray(launch.args)) throw invalid(`${location}.args must be an array.`);
  return {
    args: launch.args.map((argument: unknown, index: number) => parseLaunchArgument(argument, `${location}.args[${index}]`)),
    entry: relativePath(launch.entry, `${location}.entry`),
    env: stringRecord(launch.env, `${location}.env`),
    ...(launch.worker === undefined ? {} : { worker: relativePath(launch.worker, `${location}.worker`) }),
  };
};

const parseApp = (value: unknown, index: number): WebManifestApp => {
  const location = `web.apps[${index}]`;
  const app = keyedRecord(
    value,
    location,
    ['allow', 'app', 'name', 'resourceUri', 'server'],
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
    ...(app.input === undefined ? {} : { input: inputRecord(app.input, `${location}.input`) }),
    name: string(app.name, `${location}.name`),
    resourceUri: string(app.resourceUri, `${location}.resourceUri`),
    server: string(app.server, `${location}.server`),
    ...(app.tool === undefined ? {} : { tool: string(app.tool, `${location}.tool`) }),
  };
};

export const parseWebManifest = (value: unknown): WebManifest => {
  const manifest = keyedRecord(value, 'web', ['apps', 'open']);
  if (!Array.isArray(manifest.apps)) throw invalid('web.apps must be an array.');
  if (manifest.open !== 'browser' && manifest.open !== 'never') {
    throw invalid('web.open must be "browser" or "never".');
  }
  const apps = manifest.apps.map(parseApp);
  for (let index = 1; index < apps.length; index += 1) {
    if (apps[index - 1]!.app.localeCompare(apps[index]!.app) >= 0) {
      fail('web.apps must be sorted by app with no duplicates.');
    }
  }
  return { apps, open: manifest.open };
};

/**
 * The web-relevant read of one artifact manifest: the exposed Apps, the
 * declared projections, and the launch record of every compiled or prebuilt
 * server. Only these slices are read; the rest of the document is not
 * validated here.
 */
export interface WebManifestDocument {
  /** The projection names the artifact manifest declares for this composite root. */
  readonly hosts: readonly string[];
  /** Compiled MCP servers' launch records, keyed by configured server name. */
  readonly launches: ReadonlyMap<string, ArtifactManifestLaunch>;
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

const compiledLaunches = (value: unknown): ReadonlyMap<string, ArtifactManifestLaunch> => {
  const launches = new Map<string, ArtifactManifestLaunch>();
  const servers = isPlainRecord(value) ? value['mcpServers'] : undefined;
  if (!Array.isArray(servers)) return launches;
  servers.forEach((server: unknown, index: number) => {
    if (!isPlainRecord(server) || (server['kind'] !== 'compiled' && server['kind'] !== 'prebuilt')) return;
    const location = `executables.mcpServers[${index}]`;
    launches.set(string(server['name'], `${location}.name`), parseLaunch(server['launch'], `${location}.launch`));
  });
  return launches;
};

export const readWebManifestDocument = async (manifestPath: string): Promise<WebManifestDocument> => {
  try {
    const document = parseJsonWithoutDuplicateKeys(await readFile(manifestPath, 'utf8'));
    const manifest = record(document, 'manifest');
    if (manifest['manifestVersion'] !== artifactManifestVersion) {
      throw new Error(`manifestVersion must be ${artifactManifestVersion}.`);
    }
    return {
      hosts: projectionHosts(manifest['projections']),
      launches: compiledLaunches(manifest['executables']),
      ...(manifest['web'] === undefined ? {} : { web: parseWebManifest(manifest['web']) }),
    };
  } catch (error) {
    throw new Error(`Unable to read web section from ${manifestPath}: ${errorMessage(error)}`, { cause: error });
  }
};

export const readWebManifest = async (manifestPath: string): Promise<WebManifest | undefined> =>
  (await readWebManifestDocument(manifestPath)).web;
