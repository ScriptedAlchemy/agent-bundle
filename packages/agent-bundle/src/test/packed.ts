/**
 * The packed stdio proof level.
 *
 * This is the only level in `agent-bundle/test` that is process evidence: a
 * real MCP client speaks JSON-RPC over stdio to the generated entry running
 * as a separate operating-system process, out of a built artifact. Framing,
 * the stdout protocol guard, the entry lifecycle, and the warm Flight worker
 * are all in the picture here and in none of the other levels.
 *
 * Packing and installing are deliberately **not** this helper's job. A packed
 * journey is the most expensive thing a test suite can do, so the harness
 * takes an already-built entry path and spends its cost on assertions
 * instead: one artifact, one spawned server, every route asserted inside that
 * single session (#103's cost rule).
 */
import { lstat, readdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { Client } from '@modelcontextprotocol/client';

import { AgentTestError } from './errors.ts';
import {
  PACKED_DELETED_SOURCE_PROOF_LEVEL,
  PACKED_STDIO_PROOF_LEVEL,
  proofLevelLabel,
} from './manifest.ts';

/**
 * Verified project-relative paths removed before a packed entry is spawned.
 * The receipt upgrades only a session whose entry and any explicit cwd belong
 * to this same project root.
 */
export interface DeletedSourceReceipt {
  /** Absolute root that must contain the launched entry and any explicit cwd. */
  readonly projectRoot: string;
  /** Sorted project-relative POSIX paths that existed, were removed, and were verified absent. */
  readonly removed: readonly string[];
}

/** Where a packed session's evidence came from. */
export interface PackedMcpProvenance {
  /** Absolute path of the generated stdio entry that was spawned. */
  readonly entry: string;
  readonly pid: number | undefined;
  readonly proofLevel: typeof PACKED_DELETED_SOURCE_PROOF_LEVEL | typeof PACKED_STDIO_PROOF_LEVEL;
  /** Project-relative paths verified absent immediately before the process spawn. */
  readonly sourceRemoved?: readonly string[];
}

export interface PackedMcpSessionOptions {
  /** Extra argv appended after the entry path. */
  readonly args?: readonly string[];
  /** Working directory for the spawned process; defaults to the entry's directory. */
  readonly cwd?: string;
  /**
   * Receipt whose paths must still be absent and whose project root must
   * contain the entry and any explicit cwd before this session may claim
   * deleted-source proof.
   */
  readonly deletedSource?: DeletedSourceReceipt;
  /** Absolute path of the generated stdio entry (`<artifact>/<target>/mcp/<server>.mjs`). */
  readonly entry: string;
  /** Environment for the spawned process; defaults to the current one. */
  readonly env?: Readonly<Record<string, string>>;
  /** Node binary to spawn; defaults to the running one. */
  readonly execPath?: string;
  /** Client identity sent in `initialize`. */
  readonly name?: string;
}

export interface PackedMcpSession extends AsyncDisposable {
  readonly client: Client;
  readonly close: () => Promise<void>;
  readonly provenance: PackedMcpProvenance;
  /** Everything the server wrote to stderr, bounded — stdout is the protocol channel. */
  readonly stderr: () => string;
}

/** Bytes of server stderr one session retains for diagnostics. */
const maxStderrCharacters = 16_000;

interface Sdk {
  readonly Client: typeof import('@modelcontextprotocol/client').Client;
  readonly StdioClientTransport: typeof import('@modelcontextprotocol/client/stdio').StdioClientTransport;
}

let sdkPromise: Promise<Sdk> | undefined;

const loadSdk = async (): Promise<Sdk> => {
  sdkPromise ??= (async () => {
    const [client, stdio] = await Promise.all([
      import('@modelcontextprotocol/client'),
      import('@modelcontextprotocol/client/stdio'),
    ]);
    return { Client: client.Client, StdioClientTransport: stdio.StdioClientTransport };
  })();
  return sdkPromise;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const deletedSourceError = (
  message: string,
  options: {
    readonly cause?: unknown;
    readonly details?: readonly string[];
    readonly recovery: string;
  },
): AgentTestError => new AgentTestError('deleted-source-unverified', message, {
  ...(options.cause === undefined ? {} : { cause: options.cause }),
  details: [
    `proof level:  ${proofLevelLabel(PACKED_DELETED_SOURCE_PROOF_LEVEL)}`,
    ...(options.details ?? []),
  ],
  recovery: options.recovery,
});

const projectPath = (
  projectRoot: string,
  candidate: string,
): { readonly absolute: string; readonly relative: string } => {
  const absolute = resolve(projectRoot, candidate);
  const relativePath = relative(projectRoot, absolute);
  if (
    relativePath === ''
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw deletedSourceError('A deleted-source path did not stay inside the project root.', {
      details: [`project root: ${projectRoot}`, `path:         ${candidate}`],
      recovery: 'Pass only non-empty project-relative paths beneath projectRoot.',
    });
  }
  return {
    absolute,
    relative: relativePath.split(sep).join('/'),
  };
};

const belongsToProject = (
  projectRoot: string,
  candidate: string,
  allowRoot: boolean,
): boolean => {
  const relativePath = relative(resolve(projectRoot), resolve(candidate));
  return (allowRoot || relativePath !== '')
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
};

const verifyDeletedSourceSessionBinding = (
  receipt: DeletedSourceReceipt,
  entry: string,
  cwd: string | undefined,
): void => {
  const resolvedEntry = resolve(entry);
  if (!belongsToProject(receipt.projectRoot, resolvedEntry, false)) {
    throw deletedSourceError('The launched entry does not belong to the deleted-source receipt project.', {
      details: [`project root: ${receipt.projectRoot}`, `entry:        ${resolvedEntry}`],
      recovery: 'Pass the receipt produced for the project that owns the launched entry.',
    });
  }
  if (cwd === undefined) return;
  const resolvedCwd = resolve(cwd);
  if (!belongsToProject(receipt.projectRoot, resolvedCwd, true)) {
    throw deletedSourceError('The launched cwd does not belong to the deleted-source receipt project.', {
      details: [`project root: ${receipt.projectRoot}`, `cwd:          ${resolvedCwd}`],
      recovery: 'Pass the receipt produced for the project that owns the launched entry, and keep its cwd inside that project.',
    });
  }
};

const verifyDeletedSourceReceipt = async (receipt: DeletedSourceReceipt): Promise<void> => {
  if (receipt.removed.length === 0) {
    throw deletedSourceError('The deleted-source receipt names no removed project paths.', {
      details: [`project root: ${receipt.projectRoot}`],
      recovery: 'Call removeProjectSource on a project that still contains source before opening the packed session.',
    });
  }
  const paths = receipt.removed.map((candidate) => projectPath(receipt.projectRoot, candidate));
  let survived: readonly string[];
  try {
    survived = (
      await Promise.all(paths.map(async (path) => ({ ...path, exists: await pathExists(path.absolute) })))
    ).filter((path) => path.exists).map((path) => path.relative);
  } catch (error) {
    throw deletedSourceError('The deleted-source receipt could not be verified before process spawn.', {
      cause: error,
      details: [`project root: ${receipt.projectRoot}`],
      recovery: 'Make the receipt paths readable, remove them, and open the packed session again.',
    });
  }
  if (survived.length > 0) {
    throw deletedSourceError('Project source named by the deleted-source receipt still exists.', {
      details: [`project root: ${receipt.projectRoot}`, `survived:     ${survived.join(', ')}`],
      recovery: 'Remove every receipt path before opening the packed session.',
    });
  }
};

/**
 * Removes a consumer project's conventional source inputs and verifies their
 * absence before minting deleted-source evidence.
 *
 * The default set is `src` plus every root `agent-bundle.config.*` entry;
 * callers may add project-relative paths for non-conventional inputs. A
 * project with nothing to remove is refused, because absence observed without
 * a deletion is not evidence that the artifact survived source removal.
 */
export const removeProjectSource = async (options: {
  readonly extraPaths?: readonly string[];
  readonly projectRoot: string;
}): Promise<DeletedSourceReceipt> => {
  const projectRoot = resolve(options.projectRoot);
  let entries: readonly string[];
  try {
    entries = await readdir(projectRoot);
  } catch (error) {
    throw deletedSourceError('The project root does not exist or cannot be read.', {
      cause: error,
      details: [`project root: ${projectRoot}`],
      recovery: 'Pass an existing readable consumer project root.',
    });
  }

  const candidates = new Map<string, string>();
  for (const candidate of [
    ...(entries.includes('src') ? ['src'] : []),
    ...entries.filter((entry) => entry.startsWith('agent-bundle.config.')),
    ...(options.extraPaths ?? []),
  ]) {
    const path = projectPath(projectRoot, candidate);
    candidates.set(path.relative, path.absolute);
  }

  const existing: readonly [string, string][] = (
    await Promise.all(
      [...candidates].map(async ([relativePath, absolute]) => (
        await pathExists(absolute) ? [relativePath, absolute] as const : undefined
      )),
    )
  ).filter((entry): entry is [string, string] => entry !== undefined);
  if (existing.length === 0) {
    throw deletedSourceError('No project source existed to remove.', {
      details: [`project root: ${projectRoot}`],
      recovery: 'Build the artifact while the project source still exists, then remove that source exactly once.',
    });
  }

  try {
    await Promise.all(existing.map(([, absolute]) => rm(absolute, { force: true, recursive: true })));
  } catch (error) {
    throw deletedSourceError('Project source could not be removed.', {
      cause: error,
      details: [`project root: ${projectRoot}`],
      recovery: 'Make every source path writable and retry the deletion.',
    });
  }

  const removed = Object.freeze(existing.map(([relativePath]) => relativePath).sort());
  await verifyDeletedSourceReceipt({ projectRoot, removed });
  return Object.freeze({ projectRoot, removed });
};

/**
 * Spawns a built stdio MCP entry and connects a real MCP client to it.
 *
 * The entry must already exist: build the artifact once per suite and reuse
 * the session for every assertion. A connect failure reports the captured
 * stderr, because a generated entry that dies on startup says why there and
 * nowhere else.
 */
export const openPackedMcpServer = async (
  options: PackedMcpSessionOptions,
): Promise<PackedMcpSession> => {
  if (options.deletedSource !== undefined) {
    verifyDeletedSourceSessionBinding(options.deletedSource, options.entry, options.cwd);
    await verifyDeletedSourceReceipt(options.deletedSource);
  }
  const proofLevel = options.deletedSource === undefined
    ? PACKED_STDIO_PROOF_LEVEL
    : PACKED_DELETED_SOURCE_PROOF_LEVEL;
  const sdk = await loadSdk();
  const client = new sdk.Client({ name: options.name ?? 'agent-bundle-packed-proof', version: '1.0.0' });
  const transport = new sdk.StdioClientTransport({
    args: [options.entry, ...(options.args ?? [])],
    command: options.execPath ?? process.execPath,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stderr: 'pipe',
  });
  let captured = '';
  transport.stderr?.on('data', (chunk: unknown) => {
    if (captured.length >= maxStderrCharacters) return;
    captured = `${captured}${String(chunk)}`.slice(0, maxStderrCharacters);
  });
  const stderr = (): string => captured;
  try {
    await client.connect(transport);
  } catch (error) {
    throw new AgentTestError('packed-unavailable', 'The packed stdio MCP server did not start.', {
      cause: error,
      details: [
        `proof level:  ${proofLevelLabel(proofLevel)}`,
        `entry:        ${options.entry}`,
        `cause:        ${error instanceof Error ? error.message : String(error)}`,
        `server stderr:${captured === '' ? ' (empty)' : `\n${captured}`}`,
      ],
      recovery: 'Build the artifact before opening the session, and run the entry manually with `node <entry>` to see its startup output.',
    });
  }
  const provenance: PackedMcpProvenance = Object.freeze({
    entry: options.entry,
    pid: transport.pid ?? undefined,
    proofLevel,
    ...(options.deletedSource === undefined
      ? {}
      : { sourceRemoved: Object.freeze([...options.deletedSource.removed]) }),
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  return Object.freeze({
    client,
    close,
    provenance,
    stderr,
    [Symbol.asyncDispose]: close,
  });
};
