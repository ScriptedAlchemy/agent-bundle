import { createHash } from 'node:crypto';
import { open, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { emitRuntimeArtifacts } from '../build/emit-artifacts.js';
import type {
  RscRuntimeGenerationMetadata,
  RscRuntimeSurfaceAsset,
  SerializedRuntimeDefinition,
} from '../runtime/contracts.js';
import type { DevRuntimePreparedProject } from '../../../../packages/agent-bundle/src/dev/runtime-provider.ts';
import type { DevRuntimeMcpServerDescriptor } from '../../../../packages/agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonObject, JsonValue } from '../../../../packages/agent-bundle/src/dev/types.ts';
import type {
  RuntimeGenerationActivationGuard,
  RuntimeGenerationAsset,
  RuntimeGenerationCandidate,
  RuntimeGenerationManifestInput,
  RuntimeGenerationMetadataCodec,
  RuntimeGenerationPreparedActivation,
  RuntimeGenerationStore,
  RuntimeGenerationValidationInput,
} from '../../../../packages/agent-bundle/src/dev/runtime-generation-store.ts';

export type { RscRuntimeGenerationMetadata, RscRuntimeSurfaceAsset } from '../runtime/contracts.js';

const definitionFile = 'rsc/runtime-definition.json';
const runtimeAssetsFile = 'rsc/runtime-assets.json';
const requiredEntries = Object.freeze([
  'hook/index',
  'mcp/http',
  'mcp/stdio',
  'rsc/index',
] as const);
const executableAsyncEntries = Object.freeze(['mcp/http', 'mcp/stdio'] as const);
const maximumDefinitionStdout = 1024 * 1024;
const maximumDefinitionStderr = 64 * 1024;
const definitionTimeoutMs = 5_000;
const definitionTerminationGraceMs = 100;
const sha256Expression = /^[a-f0-9]{64}$/u;
const generatedRscAssetPaths = Object.freeze([
  'agent-runtime.manifest.json',
  'runtime-assets.json',
  'runtime-definition.json',
] as const);

// Rsbuild writes incremental compilations into a persistent directory. Remember the
// last compiler-managed asset bytes so a removed chunk can be recognized as stale
// output, without accepting a newly injected undeclared file.
const priorCompilerAssetDigests = new Map<string, ReadonlyMap<string, string>>();

interface RuntimeAssetsManifest {
  readonly allFiles: readonly string[];
  readonly entries: Readonly<Record<string, RuntimeAssetsEntry>>;
}

interface RuntimeAssetsEntry {
  readonly async?: Readonly<{ readonly js?: readonly string[] }>;
  readonly initial?: Readonly<{ readonly js?: readonly string[] }>;
}

export interface RscRuntimeCapturedGenerationSnapshot {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly attemptId: string;
  readonly candidate: RuntimeGenerationCandidate;
  readonly definition: SerializedRuntimeDefinition;
  readonly preparedRuntime: DevRuntimePreparedProject;
  readonly rscCohortRevision: number;
  readonly sourceRevision: string;
}

export interface CaptureRuntimeGenerationSnapshotOptions {
  readonly attemptId: string;
  readonly candidate: RuntimeGenerationCandidate;
  readonly compilerRoot: string;
  readonly preparedRuntime: DevRuntimePreparedProject;
  readonly rscCohortRevision: number;
  readonly sourceRevision: string;
}

export interface MaterializeRuntimeGenerationOptions {
  readonly guard?: RuntimeGenerationActivationGuard<RscRuntimeGenerationMetadata>;
  readonly snapshot: RscRuntimeCapturedGenerationSnapshot;
  readonly stateStoreId?: string;
  readonly store: RuntimeGenerationStore<RscRuntimeGenerationMetadata>;
}

const digestBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime metadata contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('Runtime metadata is not JSON serializable.');

  const input = value as Record<string, unknown>;
  return `{${Object.keys(input).sort().flatMap((key) => {
    const item = input[key];
    return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(item)}`];
  }).join(',')}}`;
};

const digestValue = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

const freezeJson = (value: unknown, seen = new WeakSet<object>()): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime metadata contains a non-finite number.');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Runtime metadata is not JSON serializable.');
  if (seen.has(value)) throw new TypeError('Runtime metadata cannot contain cyclic values.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item, seen)));
    const input = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(input)) {
      const item = input[key];
      if (item !== undefined) output[key] = freezeJson(item, seen);
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeSegment = (value: string): boolean =>
  value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');

const assertInside = (root: string, target: string): void => {
  const path = relative(resolve(root), resolve(target));
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('Runtime generation path escaped its root.');
  }
};

const assertRelativeAssetPath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw new TypeError('Runtime asset path must be a contained slash-separated path.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new TypeError('Runtime asset path must not escape its root.');
  }
  return segments.join('/');
};

const fsync = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const copyFileExclusive = async (source: string, destination: string): Promise<void> => {
  const bytes = await readFile(source);
  const handle = await open(destination, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const copyTree = async (sourceRoot: string, destinationRoot: string): Promise<void> => {
  const sourceStatus = await lstat(sourceRoot);
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    throw new Error(`Compiler environment ${JSON.stringify(sourceRoot)} must be a regular directory.`);
  }
  await mkdir(destinationRoot, { recursive: false });

  const copyDirectory = async (source: string, destination: string): Promise<void> => {
    assertInside(sourceRoot, source);
    assertInside(destinationRoot, destination);
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!isSafeSegment(entry.name)) throw new Error('Compiler output contains an unsafe path segment.');
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      assertInside(sourceRoot, sourcePath);
      assertInside(destinationRoot, destinationPath);
      const status = await lstat(sourcePath);
      if (status.isSymbolicLink()) throw new Error('Compiler output cannot contain symbolic links.');
      if (status.isDirectory()) {
        await mkdir(destinationPath, { recursive: false });
        await copyDirectory(sourcePath, destinationPath);
      } else if (status.isFile()) {
        await copyFileExclusive(sourcePath, destinationPath);
      } else {
        throw new Error('Compiler output can contain only regular files and directories.');
      }
    }
    await fsync(destination);
  };

  await copyDirectory(sourceRoot, destinationRoot);
};

const copyCurrentRscAssets = async (
  sourceRoot: string,
  destinationRoot: string,
  runtimeAssets: RuntimeAssetsManifest,
  priorAssets: ReadonlyMap<string, string> | undefined,
): Promise<void> => {
  const sourceStatus = await lstat(sourceRoot);
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    throw new Error(`Compiler environment ${JSON.stringify(sourceRoot)} must be a regular directory.`);
  }
  const currentAssets = new Set<string>([
    ...runtimeAssets.allFiles,
    ...generatedRscAssetPaths,
  ]);
  const sourceFiles = new Map<string, string>();
  const inspectDirectory = async (source: string, prefix: string): Promise<void> => {
    assertInside(sourceRoot, source);
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!isSafeSegment(entry.name)) throw new Error('Compiler output contains an unsafe path segment.');
      const sourcePath = join(source, entry.name);
      assertInside(sourceRoot, sourcePath);
      const status = await lstat(sourcePath);
      if (status.isSymbolicLink()) throw new Error('Compiler output cannot contain symbolic links.');
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (status.isDirectory()) {
        await inspectDirectory(sourcePath, path);
      } else if (status.isFile()) {
        if (currentAssets.has(path)) {
          sourceFiles.set(path, sourcePath);
          continue;
        }
        const priorDigest = priorAssets?.get(path);
        if (priorDigest === undefined || digestBytes(await readFile(sourcePath)) !== priorDigest) {
          throw new Error(`Compiler output contains an undeclared file ${JSON.stringify(path)}.`);
        }
      } else {
        throw new Error('Compiler output can contain only regular files and directories.');
      }
    }
  };

  await inspectDirectory(sourceRoot, '');
  await mkdir(destinationRoot, { recursive: false });
  const destinationDirectories = new Set<string>([destinationRoot]);
  const rememberDirectories = (directory: string): void => {
    let current = directory;
    while (true) {
      assertInside(destinationRoot, current);
      destinationDirectories.add(current);
      if (current === destinationRoot) return;
      current = dirname(current);
    }
  };
  for (const path of [...currentAssets].sort((left, right) => left.localeCompare(right))) {
    const source = sourceFiles.get(path);
    if (source === undefined) throw new Error(`runtime-assets.json references missing asset ${JSON.stringify(path)}.`);
    const destination = join(destinationRoot, ...path.split('/'));
    const directory = dirname(destination);
    assertInside(destinationRoot, destination);
    await mkdir(directory, { recursive: true });
    rememberDirectories(directory);
    await copyFileExclusive(source, destination);
  }
  for (const directory of [...destinationDirectories].sort((left, right) => right.length - left.length)) {
    await fsync(directory);
  }
};

const walkRegularFiles = async (root: string): Promise<readonly RuntimeGenerationAsset[]> => {
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('Runtime generation root must be a regular directory.');
  }
  const files: RuntimeGenerationAsset[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!isSafeSegment(entry.name)) throw new Error('Runtime generation contains an unsafe path segment.');
      const path = join(current, entry.name);
      assertInside(root, path);
      const entryStatus = await lstat(path);
      if (entryStatus.isSymbolicLink()) throw new Error('Runtime generation cannot contain symbolic links.');
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entryStatus.isDirectory()) {
        await walk(path, relativePath);
      } else if (entryStatus.isFile()) {
        const bytes = await readFile(path);
        files.push(Object.freeze({ bytes: bytes.byteLength, path: relativePath, sha256: digestBytes(bytes) }));
      } else {
        throw new Error('Runtime generation can contain only regular files and directories.');
      }
    }
  };
  await walk(root, '');
  return Object.freeze(files);
};

const equalAssets = (left: readonly RuntimeGenerationAsset[], right: readonly RuntimeGenerationAsset[]): boolean =>
  left.length === right.length && left.every((asset, index) => {
    const candidate = right[index];
    return candidate !== undefined && asset.path === candidate.path && asset.bytes === candidate.bytes && asset.sha256 === candidate.sha256;
  });

const redact = (value: string): string => value
  .slice(0, 16 * 1024)
  .replace(/((?:authorization|password|secret|token)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, '$1[REDACTED]');

const runDefinitionExecutable = async (entry: string): Promise<SerializedRuntimeDefinition> =>
  new Promise<SerializedRuntimeDefinition>((resolveDefinition, rejectDefinition) => {
    const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let termination: Error | undefined;
    let terminationGrace: ReturnType<typeof setTimeout> | undefined;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationGrace !== undefined) clearTimeout(terminationGrace);
      callback();
    };
    const terminate = (error: Error): void => {
      if (termination !== undefined) return;
      termination = error;
      child.kill('SIGTERM');
      terminationGrace = setTimeout(() => {
        child.kill('SIGKILL');
      }, definitionTerminationGraceMs);
    };
    const timeout = setTimeout(() => terminate(new Error('Runtime definition executable exceeded 5 seconds.')), definitionTimeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (termination !== undefined) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumDefinitionStdout) {
        terminate(new Error('Runtime definition executable exceeded 1 MiB stdout.'));
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (termination !== undefined) return;
      const retained = Math.min(chunk.byteLength, maximumDefinitionStderr - stderrBytes);
      if (retained > 0) stderr.push(chunk.subarray(0, retained));
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maximumDefinitionStderr) {
        terminate(new Error('Runtime definition executable exceeded 64 KiB stderr.'));
      }
    });
    child.once('error', (error) => terminate(error));
    child.once('close', (code) => {
      if (settled) return;
      if (termination !== undefined) {
        settle(() => rejectDefinition(termination as Error));
        return;
      }
      const errorOutput = redact(Buffer.concat(stderr).toString('utf8'));
      if (code !== 0) {
        settle(() => rejectDefinition(new Error(`Runtime definition executable failed with exit code ${String(code)}${errorOutput.length === 0 ? '' : `: ${errorOutput}`}`)));
        return;
      }
      try {
        const raw = Buffer.concat(stdout).toString('utf8').trim();
        if (Buffer.byteLength(raw, 'utf8') > maximumDefinitionStdout) throw new Error('Runtime definition executable exceeded 1 MiB stdout.');
        const parsed: unknown = JSON.parse(raw);
        const definition = parseDefinition(parsed);
        if (canonicalJson(definition) !== raw) throw new Error('Runtime definition executable did not emit canonical JSON.');
        settle(() => resolveDefinition(definition));
      } catch (error) {
        settle(() => rejectDefinition(error instanceof Error ? error : new Error('Runtime definition executable emitted invalid JSON.')));
      }
    });
  });

const closedObject = (value: unknown, fields: readonly string[], name: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !fields.includes(key)) || fields.some((field) => !(field in object))) {
    throw new TypeError(`${name} has an invalid schema.`);
  }
  return object;
};

const parseDefinition = (value: unknown): SerializedRuntimeDefinition => {
  const definition = closedObject(value, ['nativeHooks', 'resources', 'tools'], 'Runtime definition');
  if (!Array.isArray(definition.nativeHooks) || !Array.isArray(definition.resources) || !Array.isArray(definition.tools)) {
    throw new TypeError('Runtime definition arrays are malformed.');
  }
  const nativeHooks = definition.nativeHooks.map((value) => {
    const hook = closedObject(value, ['event', 'handlerId', 'host', 'matcher'], 'Runtime native hook');
    if ((hook.event !== 'PostToolUse' && hook.event !== 'after_tool_use') ||
      (hook.host !== 'claude' && hook.host !== 'codex') ||
      typeof hook.handlerId !== 'string' || typeof hook.matcher !== 'string') {
      throw new TypeError('Runtime native hook is malformed.');
    }
    return Object.freeze({ event: hook.event, handlerId: hook.handlerId, host: hook.host, matcher: hook.matcher });
  });
  const resources = definition.resources.map((value) => {
    const resource = closedObject(value, ['_meta', 'mimeType', 'name', 'uri'], 'Runtime resource');
    if (typeof resource.mimeType !== 'string' || typeof resource.name !== 'string' || typeof resource.uri !== 'string') {
      throw new TypeError('Runtime resource is malformed.');
    }
    const meta = freezeJson(resource._meta);
    if (!isJsonObject(meta)) throw new TypeError('Runtime resource metadata is malformed.');
    return Object.freeze({ _meta: meta, mimeType: resource.mimeType, name: resource.name, uri: resource.uri });
  });
  const tools = definition.tools.map((value) => {
    const tool = closedObject(value, ['_meta', 'annotations', 'description', 'handlerId', 'inputSchema', 'name', 'outputSchema'], 'Runtime tool');
    const annotations = closedObject(tool.annotations, ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'], 'Runtime tool annotations');
    if (typeof tool.description !== 'string' || typeof tool.handlerId !== 'string' || typeof tool.name !== 'string' ||
      Object.values(annotations).some((annotation) => typeof annotation !== 'boolean')) {
      throw new TypeError('Runtime tool is malformed.');
    }
    const meta = freezeJson(tool._meta);
    const inputSchema = freezeJson(tool.inputSchema);
    const outputSchema = freezeJson(tool.outputSchema);
    if (!isJsonObject(meta) || !isJsonObject(inputSchema) || !isJsonObject(outputSchema)) {
      throw new TypeError('Runtime tool JSON fields are malformed.');
    }
    return Object.freeze({
      _meta: meta,
      annotations: Object.freeze({
        destructiveHint: annotations.destructiveHint as boolean,
        idempotentHint: annotations.idempotentHint as boolean,
        openWorldHint: annotations.openWorldHint as boolean,
        readOnlyHint: annotations.readOnlyHint as boolean,
      }),
      description: tool.description,
      handlerId: tool.handlerId,
      inputSchema,
      name: tool.name,
      outputSchema,
    });
  });
  return Object.freeze({ nativeHooks: Object.freeze(nativeHooks), resources: Object.freeze(resources), tools: Object.freeze(tools) }) as unknown as SerializedRuntimeDefinition;
};

const parseRuntimeAssets = async (root: string): Promise<RuntimeAssetsManifest> => {
  const parsed: unknown = JSON.parse(await readFile(join(root, 'runtime-assets.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('runtime-assets.json is malformed.');
  const manifest = parsed as Record<string, unknown>;
  if (!Array.isArray(manifest.allFiles) || typeof manifest.entries !== 'object' || manifest.entries === null || Array.isArray(manifest.entries)) {
    throw new TypeError('runtime-assets.json must contain allFiles and entries.');
  }
  const allFiles = manifest.allFiles.map((value) => assertRelativeAssetPath(typeof value === 'string' ? value.replace(/^[/\\]+/, '') : value));
  if (new Set(allFiles).size !== allFiles.length) throw new TypeError('runtime-assets.json contains duplicate paths.');
  const entries: Record<string, RuntimeAssetsEntry> = {};
  for (const [name, value] of Object.entries(manifest.entries)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('runtime-assets.json entry is malformed.');
    const entry = value as Record<string, unknown>;
    const parseGroup = (group: unknown): Readonly<{ readonly js?: readonly string[] }> | undefined => {
      if (group === undefined) return undefined;
      if (typeof group !== 'object' || group === null || Array.isArray(group)) throw new TypeError('runtime-assets.json entry group is malformed.');
      const js = (group as Record<string, unknown>).js;
      if (js === undefined) return Object.freeze({});
      if (!Array.isArray(js)) throw new TypeError('runtime-assets.json entry group is malformed.');
      return Object.freeze({ js: Object.freeze(js.map((asset) => assertRelativeAssetPath(typeof asset === 'string' ? asset.replace(/^[/\\]+/, '') : asset))) });
    };
    entries[name] = Object.freeze({ async: parseGroup(entry.async), initial: parseGroup(entry.initial) });
  }
  return Object.freeze({ allFiles: Object.freeze(allFiles), entries: Object.freeze(entries) });
};

const clientReferencePaths = (assets: readonly RuntimeGenerationAsset[]): readonly string[] =>
  assets.filter((asset) => asset.path.startsWith('widget/')).map((asset) => asset.path);

const validateRuntimeAssetCoverage = (
  runtimeAssets: RuntimeAssetsManifest,
  assets: readonly RuntimeGenerationAsset[],
): void => {
  const assetPaths = new Set(assets.map((asset) => asset.path));
  for (const asset of runtimeAssets.allFiles) {
    if (!assetPaths.has(`rsc/${asset}`)) throw new Error(`runtime-assets.json references missing asset ${JSON.stringify(asset)}.`);
  }
  for (const entry of requiredEntries) {
    const declared = runtimeAssets.entries[entry];
    if (declared === undefined) throw new Error(`runtime-assets.json is missing required entry ${JSON.stringify(entry)}.`);
    const files = [...(declared.initial?.js ?? []), ...(declared.async?.js ?? [])];
    if (files.length === 0 || files.some((asset) => !runtimeAssets.allFiles.includes(asset))) {
      throw new Error(`runtime-assets.json entry ${JSON.stringify(entry)} has incomplete asset coverage.`);
    }
  }
  for (const entry of executableAsyncEntries) {
    const asyncAssets = runtimeAssets.entries[entry]?.async?.js;
    if (asyncAssets === undefined || asyncAssets.length === 0 || asyncAssets.some((asset) => !runtimeAssets.allFiles.includes(asset))) {
      throw new Error(`runtime-assets.json executable ${JSON.stringify(entry)} is missing async asset coverage.`);
    }
  }
  if (!runtimeAssets.allFiles.some((path) => path.startsWith('chunks/'))) {
    throw new Error('runtime-assets.json must declare an async chunks/ asset.');
  }
  const expectedRscAssets = new Set([
    ...runtimeAssets.allFiles.map((path) => `rsc/${path}`),
    'rsc/runtime-assets.json',
    'rsc/runtime-definition.json',
    'rsc/agent-runtime.manifest.json',
  ]);
  const capturedRscAssets = assets.filter((asset) => asset.path.startsWith('rsc/')).map((asset) => asset.path);
  if (capturedRscAssets.length !== expectedRscAssets.size || capturedRscAssets.some((path) => !expectedRscAssets.has(path))) {
    throw new Error('Captured RSC runtime asset coverage is incomplete.');
  }
};

const validateClientReferenceRelationship = async (
  root: string,
  assets: readonly RuntimeGenerationAsset[],
): Promise<void> => {
  const clientReferences = clientReferencePaths(assets);
  const expectedClientAsset = 'widget/static/js/rsc/index.js';
  if (!clientReferences.includes('widget/rsc/index.html') || !clientReferences.includes(expectedClientAsset)) {
    throw new Error('Captured generation is missing paired client reference assets.');
  }
  const document = await readFile(join(root, 'widget', 'rsc', 'index.html'), 'utf8');
  const references = Array.from(document.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/giu), (match) => match[1]?.split(/[?#]/u, 1)[0]);
  if (!references.includes('/static/js/rsc/index.js') && !references.includes('static/js/rsc/index.js')) {
    throw new Error('Captured generation has an invalid client reference relationship.');
  }
};

const contentTypeFor = (path: string): RscRuntimeSurfaceAsset['contentType'] | undefined => {
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.html')) return 'text/html';
  return undefined;
};

const surfaceAssets = (
  preparedRuntime: DevRuntimePreparedProject,
  assets: readonly RuntimeGenerationAsset[],
): Readonly<Record<string, readonly RscRuntimeSurfaceAsset[]>> => {
  const widgetAssets = assets.flatMap((asset): RscRuntimeSurfaceAsset[] => {
    if (!asset.path.startsWith('widget/')) return [];
    const contentType = contentTypeFor(asset.path);
    if (contentType === undefined) return [];
    const requestPath = asset.path.slice('widget'.length);
    return [Object.freeze({
      bytes: asset.bytes,
      contentType,
      generationPath: asset.path,
      requestPath,
      sha256: asset.sha256,
    })];
  });
  return Object.freeze(Object.fromEntries(preparedRuntime.apps.map((app) => [
    `mcp.${app.name}`,
    Object.freeze(widgetAssets.map((asset) => Object.freeze({ ...asset }))),
  ])));
};

const transportProjection = (preparedRuntime: DevRuntimePreparedProject): JsonValue => freezeJson({
  provider: preparedRuntime.provider,
  servers: preparedRuntime.servers.map((server) => ({
    args: server.args === undefined ? undefined : [...server.args],
    command: server.command,
    cwd: server.cwd,
    env: server.env === undefined ? undefined : Object.fromEntries(Object.entries(server.env).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, digestValue(value)])),
    headers: server.headers === undefined ? undefined : Object.fromEntries(Object.entries(server.headers).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, digestValue(value)])),
    id: server.id,
    name: server.name,
    source: server.source,
    targets: [...server.targets],
    transport: server.transport,
    url: server.url,
  })),
});

const descriptors = (
  preparedRuntime: DevRuntimePreparedProject,
  definition: SerializedRuntimeDefinition,
  definitionDigest: string,
  serverDigest: string,
  transportDigest: string,
): readonly DevRuntimeMcpServerDescriptor[] => Object.freeze(preparedRuntime.servers.flatMap((server) => server.targets.map((target) => Object.freeze({
  definitionDigest,
  name: server.name,
  resources: Object.freeze(definition.resources.map((resource) => freezeJson(resource) as JsonObject)),
  serverDigest,
  target,
  tools: Object.freeze(definition.tools.map((tool) => freezeJson(tool) as JsonObject)),
  transportDigest,
}))));

const metadataFromSnapshot = async (
  snapshot: RscRuntimeCapturedGenerationSnapshot,
  assets: readonly RuntimeGenerationAsset[],
  stateStoreId: string,
): Promise<RscRuntimeGenerationMetadata> => {
  const root = snapshot.candidate.root;
  const runtimeAssets = await parseRuntimeAssets(join(root, 'rsc'));
  validateRuntimeAssetCoverage(runtimeAssets, assets);
  await validateClientReferenceRelationship(root, assets);
  const definitionBytes = await readFile(join(root, ...definitionFile.split('/')));
  const parsedDefinition = parseDefinition(JSON.parse(definitionBytes.toString('utf8')));
  if (canonicalJson(parsedDefinition) !== definitionBytes.toString('utf8')) {
    throw new Error('Captured runtime definition is not canonical.');
  }
  const definitionDigest = digestBytes(definitionBytes);
  const environmentHashes = Object.freeze({
    rsc: digestValue(assets.filter((asset) => asset.path.startsWith('rsc/'))),
    widget: digestValue(assets.filter((asset) => asset.path.startsWith('widget/'))),
  });
  const serverDigest = digestValue(environmentHashes);
  const transportDigest = digestValue(transportProjection(snapshot.preparedRuntime));
  const entries = Object.freeze(Object.fromEntries(requiredEntries.map((entry) => {
    const assetsForEntry = runtimeAssets.entries[entry];
    const path = assetsForEntry?.initial?.js?.[0];
    if (path === undefined) throw new Error(`runtime-assets.json entry ${JSON.stringify(entry)} has no initial JavaScript asset.`);
    return [entry, `rsc/${path}`];
  })));
  return Object.freeze({
    definitionDigest,
    entries,
    environmentHashes,
    preparedRevision: snapshot.preparedRuntime.sourceRevision,
    serverDigest,
    servers: descriptors(snapshot.preparedRuntime, parsedDefinition, definitionDigest, serverDigest, transportDigest),
    stateStoreId,
    surfaceAssets: surfaceAssets(snapshot.preparedRuntime, assets),
    transportDigest,
  });
};

const clonePreparedRuntime = (preparedRuntime: DevRuntimePreparedProject): DevRuntimePreparedProject => freezeJson(preparedRuntime) as unknown as DevRuntimePreparedProject;

export const captureRuntimeGenerationSnapshot = async (
  input: CaptureRuntimeGenerationSnapshotOptions,
): Promise<RscRuntimeCapturedGenerationSnapshot> => {
  const compilerRoot = resolve(input.compilerRoot);
  const rscRoot = join(compilerRoot, 'rsc');
  const definition = await runDefinitionExecutable(join(rscRoot, 'dev', 'definition.js'));
  const definitionBytes = Buffer.from(canonicalJson(definition));
  const definitionPath = join(rscRoot, 'runtime-definition.json');
  await unlink(definitionPath).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  await writeFile(definitionPath, definitionBytes, { encoding: 'utf8', flag: 'wx' });
  await fsync(join(rscRoot, 'runtime-definition.json'));
  await emitRuntimeArtifacts(rscRoot, definition);
  await fsync(rscRoot);
  const runtimeAssets = await parseRuntimeAssets(rscRoot);
  await copyCurrentRscAssets(
    rscRoot,
    join(input.candidate.root, 'rsc'),
    runtimeAssets,
    priorCompilerAssetDigests.get(compilerRoot),
  );
  await copyTree(join(compilerRoot, 'widget'), join(input.candidate.root, 'widget'));
  await fsync(input.candidate.root);
  const assets = await walkRegularFiles(input.candidate.root);
  const capturedAssets = new Map(assets.map((asset) => [asset.path, asset]));
  priorCompilerAssetDigests.set(compilerRoot, new Map(runtimeAssets.allFiles.map((path) => {
    const asset = capturedAssets.get(`rsc/${path}`);
    if (asset === undefined) throw new Error(`runtime-assets.json references missing asset ${JSON.stringify(path)}.`);
    return [path, asset.sha256] as const;
  })));
  return Object.freeze({
    assets,
    attemptId: input.attemptId,
    candidate: input.candidate,
    definition,
    preparedRuntime: clonePreparedRuntime(input.preparedRuntime),
    rscCohortRevision: input.rscCohortRevision,
    sourceRevision: input.sourceRevision,
  });
};

const decodeMetadata = (value: JsonValue): RscRuntimeGenerationMetadata => {
  if (!isJsonObject(value)) throw new TypeError('Runtime generation metadata is malformed.');
  const required = ['definitionDigest', 'entries', 'environmentHashes', 'preparedRevision', 'serverDigest', 'servers', 'stateStoreId', 'surfaceAssets', 'transportDigest'];
  if (Object.keys(value).some((key) => !required.includes(key)) || required.some((key) => !(key in value))) {
    throw new TypeError('Runtime generation metadata has an invalid schema.');
  }
  const { definitionDigest, entries, environmentHashes, preparedRevision, serverDigest, servers, stateStoreId, surfaceAssets, transportDigest } = value;
  if (typeof definitionDigest !== 'string' || typeof serverDigest !== 'string' || typeof transportDigest !== 'string' ||
    typeof preparedRevision !== 'string' || typeof stateStoreId !== 'string' ||
    !sha256Expression.test(definitionDigest) || !sha256Expression.test(serverDigest) || !sha256Expression.test(transportDigest) ||
    !isJsonObject(entries) || !isJsonObject(environmentHashes) || !Array.isArray(servers) || !isJsonObject(surfaceAssets)) {
    throw new TypeError('Runtime generation metadata is malformed.');
  }
  if (preparedRevision.length === 0 || stateStoreId.length === 0 ||
    Object.keys(entries).length !== requiredEntries.length || requiredEntries.some((entry) => typeof entries[entry] !== 'string') ||
    Object.keys(environmentHashes).length !== 2 || typeof environmentHashes.rsc !== 'string' || typeof environmentHashes.widget !== 'string' ||
    !sha256Expression.test(environmentHashes.rsc) || !sha256Expression.test(environmentHashes.widget)) {
    throw new TypeError('Runtime generation environment digests are malformed.');
  }

  const decodedServers = servers.map((value): DevRuntimeMcpServerDescriptor => {
    if (!isJsonObject(value)) throw new TypeError('Runtime generation server descriptor is malformed.');
    const fields = ['definitionDigest', 'name', 'resources', 'serverDigest', 'target', 'tools', 'transportDigest'];
    if (Object.keys(value).some((key) => !fields.includes(key)) || fields.some((field) => !(field in value)) ||
      typeof value.definitionDigest !== 'string' || typeof value.name !== 'string' || typeof value.serverDigest !== 'string' ||
      typeof value.target !== 'string' || typeof value.transportDigest !== 'string' ||
      !Array.isArray(value.resources) || !value.resources.every(isJsonObject) || !Array.isArray(value.tools) || !value.tools.every(isJsonObject)) {
      throw new TypeError('Runtime generation server descriptor is malformed.');
    }
    return Object.freeze({
      definitionDigest: value.definitionDigest,
      name: value.name,
      resources: Object.freeze(value.resources.map((resource) => freezeJson(resource) as JsonObject)),
      serverDigest: value.serverDigest,
      target: value.target,
      tools: Object.freeze(value.tools.map((tool) => freezeJson(tool) as JsonObject)),
      transportDigest: value.transportDigest,
    });
  });

  const decodedSurfaceAssets: Record<string, readonly RscRuntimeSurfaceAsset[]> = {};
  for (const [surfaceId, value] of Object.entries(surfaceAssets)) {
    if (surfaceId.length === 0 || !Array.isArray(value)) throw new TypeError('Runtime generation surface assets are malformed.');
    decodedSurfaceAssets[surfaceId] = Object.freeze(value.map((value): RscRuntimeSurfaceAsset => {
      if (!isJsonObject(value)) throw new TypeError('Runtime generation surface asset is malformed.');
      const fields = ['bytes', 'contentType', 'generationPath', 'requestPath', 'sha256'];
      if (Object.keys(value).some((key) => !fields.includes(key)) || fields.some((field) => !(field in value)) ||
        typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || typeof value.generationPath !== 'string' ||
        typeof value.requestPath !== 'string' || typeof value.sha256 !== 'string' || !sha256Expression.test(value.sha256) ||
        (value.contentType !== 'application/javascript' && value.contentType !== 'application/json' && value.contentType !== 'text/css' && value.contentType !== 'text/html')) {
        throw new TypeError('Runtime generation surface asset is malformed.');
      }
      return Object.freeze({
        bytes: value.bytes,
        contentType: value.contentType,
        generationPath: assertRelativeAssetPath(value.generationPath),
        requestPath: value.requestPath,
        sha256: value.sha256,
      });
    }));
  }
  return Object.freeze({
    definitionDigest,
    entries: Object.freeze(Object.fromEntries(requiredEntries.map((entry) => [entry, entries[entry] as string]))),
    environmentHashes: Object.freeze({ rsc: environmentHashes.rsc, widget: environmentHashes.widget }),
    preparedRevision,
    serverDigest,
    servers: Object.freeze(decodedServers),
    stateStoreId,
    surfaceAssets: Object.freeze(decodedSurfaceAssets),
    transportDigest,
  });
};

export const rscRuntimeGenerationMetadataCodec: RuntimeGenerationMetadataCodec<RscRuntimeGenerationMetadata> = Object.freeze({
  decode: decodeMetadata,
  encode: (value: RscRuntimeGenerationMetadata) => freezeJson(value),
});

export const validateRscRuntimeGenerationMetadata = async (
  input: RuntimeGenerationValidationInput<RscRuntimeGenerationMetadata>,
): Promise<RscRuntimeGenerationMetadata> => {
  const metadata = decodeMetadata(freezeJson(input.metadata));
  const assets = new Map(input.assets.map((asset) => [asset.path, asset]));
  for (const environment of ['rsc', 'widget'] as const) {
    if (!input.assets.some((asset) => asset.path.startsWith(`${environment}/`))) {
      throw new TypeError(`Runtime generation is missing the ${environment} environment.`);
    }
  }
  for (const entry of requiredEntries) {
    const path = metadata.entries[entry];
    if (typeof path !== 'string' || !assets.has(path)) throw new TypeError(`Runtime generation is missing required entry ${JSON.stringify(entry)}.`);
  }
  if (!assets.has(definitionFile) || !assets.has(runtimeAssetsFile)) {
    throw new TypeError('Runtime generation is missing captured definition assets.');
  }
  const runtimeAssets = await parseRuntimeAssets(join(input.root, 'rsc'));
  validateRuntimeAssetCoverage(runtimeAssets, input.assets);
  const definitionBytes = await readFile(join(input.root, ...definitionFile.split('/')));
  const definition = parseDefinition(JSON.parse(definitionBytes.toString('utf8')));
  if (canonicalJson(definition) !== definitionBytes.toString('utf8') || digestBytes(definitionBytes) !== metadata.definitionDigest) {
    throw new TypeError('Runtime generation definition digest is inconsistent.');
  }
  await validateClientReferenceRelationship(input.root, input.assets);
  const expectedEnvironmentHashes = Object.freeze({
    rsc: digestValue(input.assets.filter((asset) => asset.path.startsWith('rsc/'))),
    widget: digestValue(input.assets.filter((asset) => asset.path.startsWith('widget/'))),
  });
  if (metadata.environmentHashes.rsc !== expectedEnvironmentHashes.rsc || metadata.environmentHashes.widget !== expectedEnvironmentHashes.widget ||
    metadata.serverDigest !== digestValue(expectedEnvironmentHashes)) {
    throw new TypeError('Runtime generation implementation digest is inconsistent.');
  }
  const declaredSurfaceAssets = metadata.surfaceAssets as Readonly<Record<string, readonly RscRuntimeSurfaceAsset[]>>;
  for (const [surface, descriptors] of Object.entries(declaredSurfaceAssets)) {
    const requestPaths = new Set<string>();
    for (const asset of descriptors) {
      if (requestPaths.has(asset.requestPath) || assets.get(asset.generationPath)?.sha256 !== asset.sha256 || assets.get(asset.generationPath)?.bytes !== asset.bytes || contentTypeFor(asset.generationPath) !== asset.contentType) {
        throw new TypeError(`Runtime generation surface ${JSON.stringify(surface)} is invalid.`);
      }
      requestPaths.add(asset.requestPath);
    }
  }
  for (const descriptor of metadata.servers) {
    if (descriptor.definitionDigest !== metadata.definitionDigest || descriptor.serverDigest !== metadata.serverDigest || descriptor.transportDigest !== metadata.transportDigest) {
      throw new TypeError('Runtime generation server descriptor digest is inconsistent.');
    }
  }
  return metadata;
};

export const materializeRuntimeGeneration = async (
  input: MaterializeRuntimeGenerationOptions,
): Promise<RuntimeGenerationPreparedActivation<RscRuntimeGenerationMetadata>> => {
  try {
    const assets = await walkRegularFiles(input.snapshot.candidate.root);
    if (!equalAssets(input.snapshot.assets, assets)) {
      throw new Error('Runtime generation candidate no longer matches its captured cohort.');
    }
    const metadata = await metadataFromSnapshot(input.snapshot, assets, input.stateStoreId ?? 'playground');
    const manifest: RuntimeGenerationManifestInput<RscRuntimeGenerationMetadata> = Object.freeze({ assets, metadata });
    return await input.store.prepare(input.snapshot.candidate, manifest, input.guard === undefined ? {} : { guard: input.guard });
  } catch (error) {
    await input.store.fail(input.snapshot.candidate).catch(() => undefined);
    throw error;
  }
};
