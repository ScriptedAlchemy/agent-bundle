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
import type { Client } from '@modelcontextprotocol/client';

import { AgentTestError } from './errors.ts';
import { PACKED_STDIO_PROOF_LEVEL } from './manifest.ts';

/** Where a packed session's evidence came from. */
export interface PackedMcpProvenance {
  /** Absolute path of the generated stdio entry that was spawned. */
  readonly entry: string;
  readonly pid: number | undefined;
  readonly proofLevel: typeof PACKED_STDIO_PROOF_LEVEL;
}

export interface PackedMcpSessionOptions {
  /** Extra argv appended after the entry path. */
  readonly args?: readonly string[];
  /** Working directory for the spawned process; defaults to the entry's directory. */
  readonly cwd?: string;
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
        `proof level:  ${PACKED_STDIO_PROOF_LEVEL}`,
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
    proofLevel: PACKED_STDIO_PROOF_LEVEL,
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
