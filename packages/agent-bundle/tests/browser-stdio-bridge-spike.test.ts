import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from '@rstest/core';
import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { hostMcpRuntime, hostRootDirectory, readArtifactRootContracts } from '../src/build/artifact-root.ts';
import { build } from './support/build.ts';
import { loadedProject } from './support/loaded-project.ts';

import { normalizeProject } from '../src/config/normalize.ts';

import { resolveMcpPathTokens } from '../src/services/mcp-path-tokens.ts';
import { readTargetMcpServer } from '../src/services/mcp-runtime.ts';

interface BridgeFixture {
  readonly binding: { readonly serverName: string; readonly sessionId: string; readonly target: string };
  readonly frames: readonly ProtocolFrame[];
  readonly stderr: string;
}

interface ProtocolFrame {
  readonly direction: 'browser-to-service' | 'service' | 'service-to-browser';
  readonly envelope?: Readonly<Record<string, unknown>>;
  readonly event?: 'close';
}

interface GeneratedStdioServer {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/contracts/mcp-bridge/protocol-frames.json', import.meta.url), 'utf8'),
) as BridgeFixture;

const frame = (
  direction: ProtocolFrame['direction'],
  message: JSONRPCMessage,
): ProtocolFrame => ({
  direction,
  envelope: JSON.parse(JSON.stringify(message)) as Record<string, unknown>,
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bridge protocol frame.');
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
};

class BoundStdioSession {
  readonly #frames: ProtocolFrame[];
  readonly #onStderr: (message: string) => void;
  readonly #transport: StdioClientTransport;
  #closed = false;

  constructor(
    server: GeneratedStdioServer,
    frames: ProtocolFrame[],
    onStderr: (message: string) => void,
  ) {
    this.#frames = frames;
    this.#onStderr = onStderr;
    this.#transport = new StdioClientTransport({
      args: [...server.args],
      command: server.command,
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.env === undefined ? {} : { env: server.env }),
      stderr: 'pipe',
    });
  }

  async start(onMessage: (message: JSONRPCMessage) => void): Promise<void> {
    this.#transport.onmessage = (message) => {
      this.#frames.push(frame('service-to-browser', message));
      onMessage(message);
    };
    this.#transport.stderr?.on('data', (chunk: Buffer | string) => this.#onStderr(String(chunk)));
    await this.#transport.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.#frames.push(frame('browser-to-service', message));
    await this.#transport.send(message);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#frames.push({ direction: 'service', event: 'close' });
    await this.#transport.close();
  }
}

class BoundSessionRegistry {
  readonly #sessions = new Map<string, BoundStdioSession>();

  bind(sessionId: string, session: BoundStdioSession): void {
    this.#sessions.set(sessionId, session);
  }

  open(sessionId: string): BoundStdioSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown bound MCP session ${JSON.stringify(sessionId)}.`);
    }
    return session;
  }
}

class AgentBundleRemoteTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #session: BoundStdioSession;
  #closed = false;

  constructor(session: BoundStdioSession) {
    this.#session = session;
  }

  async start(): Promise<void> {
    try {
      await this.#session.start((message) => this.onmessage?.(message));
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(reported);
      throw reported;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await this.#session.send(message);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#session.close();
    this.onclose?.();
  }
}

const generatedServer = async (artifact: string, target: string, serverName: string, workspaceRoot: string): Promise<GeneratedStdioServer> => {
  // The built artifact is one plugin root (#555): the host's root and its MCP
  // document come from the root contracts the manifest's targets select.
  const registry = createDefaultRegistry();
  const contracts = await readArtifactRootContracts(artifact, registry);
  const targetRoot = hostRootDirectory(artifact, contracts, target);
  const runtime = hostMcpRuntime(contracts, registry, target);
  if (runtime === undefined) throw new Error(`Missing MCP runtime for ${JSON.stringify(target)}.`);
  const document: unknown = JSON.parse(await readFile(join(targetRoot, runtime.manifestPath), 'utf8'));
  const result = readTargetMcpServer(runtime, document, serverName);
  if (result.status === 'missing') throw new Error(`Missing generated MCP server ${JSON.stringify(serverName)}.`);
  if (result.status === 'invalid' || result.server.kind !== 'stdio') {
    throw new Error(`Generated MCP server ${JSON.stringify(serverName)} must be a valid stdio server.`);
  }
  const resolved = resolveMcpPathTokens({
    roots: {
      pluginData: join(artifact, 'session-data'),
      pluginRoot: targetRoot,
      workspaceRoot,
    },
    runtime,
    server: result.server,
    target,
  });
  if (resolved.kind !== 'stdio') throw new Error(`Generated MCP server ${JSON.stringify(serverName)} must be stdio.`);
  return {
    ...resolved,
    ...(resolved.cwd === undefined ? {} : { cwd: resolve(targetRoot, resolved.cwd) }),
  };
};

it('bridges a browser-bound session to a generated stdio artifact without exposing executable paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-browser-bridge-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    await writeFile(
      join(root, 'src', 'server.ts'),
      [
        'let buffer = "";',
        'const pending = new Map();',
        'const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);',
        'const reply = (id, result) => send({ id, jsonrpc: "2.0", result });',
        'const handle = (message) => {',
        '  if (message.method === "initialize") {',
        '    reply(message.id, { capabilities: { tools: {} }, protocolVersion: message.params.protocolVersion, serverInfo: { name: "bridge-fixture", version: "1.0.0" } });',
        '    return;',
        '  }',
        '  if (message.method === "tools/list") {',
        '    reply(message.id, { tools: [{ inputSchema: { type: "object" }, name: "progress" }, { inputSchema: { type: "object" }, name: "wait" }] });',
        '    return;',
        '  }',
        '  if (message.method === "tools/call" && message.params.name === "progress") {',
        '    process.stderr.write("bridge fixture stderr\\n");',
        '    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: "bridge-progress", total: 1 } });',
        '    reply(message.id, { content: [{ text: "progress complete", type: "text" }] });',
        '    return;',
        '  }',
        '  if (message.method === "tools/call" && message.params.name === "wait") {',
        '    pending.set(message.id, setTimeout(() => reply(message.id, { content: [{ text: "late", type: "text" }] }), 5_000));',
        '    return;',
        '  }',
        '  if (message.method === "notifications/cancelled") {',
        '    const timer = pending.get(message.params.requestId);',
        '    if (timer !== undefined) clearTimeout(timer);',
        '    pending.delete(message.params.requestId);',
        '    send({ error: { code: -32800, message: "Cancelled by bridge fixture" }, id: message.params.requestId, jsonrpc: "2.0" });',
        '  }',
        '};',
        'process.stdin.on("data", (chunk) => {',
        '  buffer += chunk;',
        '  for (;;) {',
        '    const newline = buffer.indexOf("\\n");',
        '    if (newline < 0) return;',
        '    const line = buffer.slice(0, newline);',
        '    buffer = buffer.slice(newline + 1);',
        '    if (line.length > 0) handle(JSON.parse(line));',
        '  }',
        '});',
        '',
      ].join('\n'),
    );
    const model = await normalizeProject(
      loadedProject(root, {
        mcp: { servers: { fixture: { entry: './src/server.ts' } } },
        plugin: { name: 'browser-bridge-fixture', version: '1.0.0' },
        targets: [fixture.binding.target],
      }),
      { skills: [] },
      createDefaultRegistry(),
    );
    const artifact = join(root, 'dist');
    await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

    const frames: ProtocolFrame[] = [];
    const stderr: string[] = [];
    const registry = new BoundSessionRegistry();
    registry.bind(
      fixture.binding.sessionId,
      new BoundStdioSession(
        await generatedServer(artifact, fixture.binding.target, fixture.binding.serverName, root),
        frames,
        (message) => stderr.push(message),
      ),
    );
    expect(() => registry.open('../another-artifact')).toThrow('Unknown bound MCP session');

    const transport = new AgentBundleRemoteTransport(registry.open(fixture.binding.sessionId));
    const client = new Client({ name: 'bridge-contract-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'progress' }, { name: 'wait' }] });
      await expect(client.callTool({ arguments: {}, name: 'progress' })).resolves.toMatchObject({
        content: [{ text: 'progress complete', type: 'text' }],
      });
      const controller = new AbortController();
      const pending = client.callTool({ arguments: {}, name: 'wait' }, { signal: controller.signal });
      setTimeout(() => controller.abort(new Error('bridge cancellation probe')), 25);
      await expect(pending).rejects.toBeDefined();
      await waitFor(() => frames.some((entry) =>
        entry.direction === 'service-to-browser' &&
        entry.envelope?.id === 3 &&
        Object.hasOwn(entry.envelope, 'error')));
    } finally {
      await client.close();
    }

    expect(stderr.join('')).toContain(fixture.stderr);
    expect(frames).toEqual(fixture.frames);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
