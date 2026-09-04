import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { JsonValue } from '@agent-bundle/runtime';

export const LOG_DIR_ENV = 'HOST_TEST_LOG_DIR';
export const LOG_FILE_NAME = 'captures.ndjson';

export type LogDirSource =
  | 'env:HOST_TEST_LOG_DIR'
  | 'env:AGENT_BUNDLE_PLUGIN_ROOT'
  | 'argv:artifact-root'
  | 'home';

export interface ResolvedLog {
  readonly dir: string;
  readonly path: string;
  readonly source: LogDirSource;
}

const artifactRootFromArgv = (argv: readonly string[]): string | undefined => {
  const entry = argv[1];
  if (entry === undefined || !isAbsolute(entry)) return undefined;
  // Generated hook wrappers live at <root>/hooks/<wrapper>.mjs and generated
  // MCP entries at <root>/mcp/<entry>.mjs, so the artifact root is two levels up.
  const parent = dirname(resolve(entry));
  const leaf = parent.slice(parent.lastIndexOf('/') + 1);
  return leaf === 'hooks' || leaf === 'mcp' ? dirname(parent) : undefined;
};

/**
 * Where the plain-file capture log lives. Every process of one installed
 * plugin (hook wrappers, the shared runtime, both MCP servers) must agree, so
 * the resolution prefers explicit configuration, then the installed plugin
 * root the host handed us, then the artifact root derived from the running
 * entry, and only then the home directory.
 */
export const resolveLog = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv,
): ResolvedLog => {
  const explicit = environment[LOG_DIR_ENV];
  if (explicit !== undefined && explicit.trim() !== '') {
    const dir = resolve(explicit);
    return { dir, path: join(dir, LOG_FILE_NAME), source: 'env:HOST_TEST_LOG_DIR' };
  }
  const pluginRoot = environment['AGENT_BUNDLE_PLUGIN_ROOT'];
  if (pluginRoot !== undefined && pluginRoot.trim() !== '') {
    const dir = join(resolve(pluginRoot), 'state', 'host-test');
    return { dir, path: join(dir, LOG_FILE_NAME), source: 'env:AGENT_BUNDLE_PLUGIN_ROOT' };
  }
  const artifactRoot = artifactRootFromArgv(argv);
  if (artifactRoot !== undefined) {
    const dir = join(artifactRoot, 'state', 'host-test');
    return { dir, path: join(dir, LOG_FILE_NAME), source: 'argv:artifact-root' };
  }
  const dir = join(homedir(), '.host-test');
  return { dir, path: join(dir, LOG_FILE_NAME), source: 'home' };
};

/** Appends one NDJSON line with a single write so concurrent hook processes interleave by line. */
export const appendLogLine = (log: ResolvedLog, record: JsonValue): void => {
  mkdirSync(log.dir, { recursive: true });
  appendFileSync(log.path, `${JSON.stringify(record)}\n`, 'utf8');
};

export interface ReadLogResult {
  readonly malformed: number;
  readonly records: readonly Record<string, JsonValue>[];
}

export const readLog = async (log: ResolvedLog): Promise<ReadLogResult> => {
  let text: string;
  try {
    text = await readFile(log.path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { malformed: 0, records: [] };
    throw error;
  }
  const records: Record<string, JsonValue>[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as JsonValue;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, JsonValue>);
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }
  return { malformed, records };
};

export const clearLog = async (log: ResolvedLog): Promise<void> => {
  await rm(log.path, { force: true });
};
