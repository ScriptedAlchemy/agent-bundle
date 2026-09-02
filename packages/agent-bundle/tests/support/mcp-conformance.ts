import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/server';
import { parse } from 'yaml';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { build } from '../../src/api.ts';
import { runBoundedChildProcess } from '../../src/host-contracts/process.ts';

const runnerVersion = '0.1.16';
const specVersion = '2025-11-25';
const healthTimeoutMs = 10_000;
const runnerTimeoutMs = 120_000;
const runnerOutputLimitBytes = 4 * 1024 * 1024;
const scenarioSummary = /^[✓✗] ([^:\n]+): (\d+) passed, (\d+) failed(?:, \d+ warnings)?$/gmu;
const suiteSummary = /Running active suite \((\d+) scenarios\)/u;

const workspaceRoot = resolve(import.meta.dirname, '../../../..');
const fixtureRoot = resolve(import.meta.dirname, '../../fixtures/route-harness');
const packageNodeModules = resolve(import.meta.dirname, '../../node_modules');
const defaultOutputRoot = resolve(workspaceRoot, 'artifacts/mcp-conformance');
const expectedFailuresPath = resolve(
  import.meta.dirname,
  '../fixtures/mcp-conformance-expected-failures.yml',
);
const conformanceEntry = createRequire(import.meta.url)
  .resolve('@modelcontextprotocol/conformance/dist/index.js');

export interface McpConformanceReport {
  readonly expectedFailures: readonly string[];
  readonly failed: number;
  readonly passed: number;
  readonly runnerVersion: string;
  readonly skipped: number;
  readonly specVersion: string;
}

interface GeneratedMcpBridge {
  readonly close: () => Promise<void>;
  readonly diagnostics: () => string;
  readonly url: string;
}

const requestId = (message: JSONRPCMessage): RequestId | undefined =>
  'id' in message ? message.id : undefined;

const isRequest = (message: JSONRPCMessage): boolean =>
  'method' in message && 'id' in message;

const isResponse = (message: JSONRPCMessage): boolean =>
  'id' in message && !('method' in message);

const sessionHeader = (request: IncomingMessage): string | undefined => {
  const value = request.headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : value;
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text) as unknown;
};

const isInitialize = (body: unknown): boolean =>
  typeof body === 'object' &&
  body !== null &&
  'method' in body &&
  body.method === 'initialize';

const closeHttpServer = (server: Server): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    });
  });

const waitForHealth = async (url: string): Promise<void> => {
  const signal = AbortSignal.timeout(healthTimeoutMs);
  let lastFailure: unknown;
  while (!signal.aborted) {
    try {
      const response = await fetch(url, { signal });
      if (response.ok) return;
      lastFailure = new Error(`Health check returned HTTP ${String(response.status)}.`);
    } catch (error) {
      lastFailure = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(
    `Generated MCP bridge did not become healthy within ${String(healthTimeoutMs)}ms.`,
    { cause: lastFailure },
  );
};

/**
 * The generated artifact is a managed stdio executable and intentionally has
 * no HTTP entry. This bridge leaves that artifact untouched: it forwards raw
 * JSON-RPC between the generated stdio process and the official SDK's
 * Streamable HTTP transport, owning only transport adaptation and lifecycle.
 */
const startGeneratedMcpBridge = async (options: {
  readonly cwd: string;
  readonly entry: string;
  readonly pluginRoot: string;
}): Promise<GeneratedMcpBridge> => {
  const stdio = new StdioClientTransport({
    args: [options.entry],
    command: process.execPath,
    cwd: options.cwd,
    env: {
      ...process.env,
      AGENT_BUNDLE_PLUGIN_ROOT: options.pluginRoot,
    } as Record<string, string>,
    stderr: 'pipe',
  });

  let diagnostics = '';
  stdio.stderr?.on('data', (chunk) => {
    if (diagnostics.length < runnerOutputLimitBytes) diagnostics += String(chunk);
  });

  const activeRequests = new Map<RequestId, NodeStreamableHTTPServerTransport>();
  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
  const transports = new Set<NodeStreamableHTTPServerTransport>();
  let transportFailure: unknown;
  const recordFailure = (error: unknown): void => {
    transportFailure ??= error;
  };
  stdio.onerror = recordFailure;
  stdio.onmessage = (message) => {
    const id = requestId(message);
    const directTransport = id !== undefined && isResponse(message)
      ? activeRequests.get(id)
      : undefined;
    const onlyActive = activeRequests.size === 1
      ? activeRequests.entries().next().value
      : undefined;
    const transport = directTransport ?? onlyActive?.[1];
    const relatedRequestId = directTransport !== undefined
      ? id
      : onlyActive?.[0];
    if (transport === undefined) {
      recordFailure(new Error('Generated MCP server emitted a message with no active HTTP request.'));
      return;
    }
    void transport.send(
      message,
      relatedRequestId === undefined ? undefined : { relatedRequestId },
    ).then(() => {
      if (id !== undefined && isResponse(message)) activeRequests.delete(id);
    }, recordFailure);
  };

  const createHttpTransport = async (): Promise<NodeStreamableHTTPServerTransport> => {
    const transport = new NodeStreamableHTTPServerTransport({
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
      },
      sessionIdGenerator: randomUUID,
    });
    transport.setSupportedProtocolVersions([...SUPPORTED_PROTOCOL_VERSIONS]);
    transport.onerror = recordFailure;
    transport.onclose = () => {
      transports.delete(transport);
      const id = transport.sessionId;
      if (id !== undefined) sessions.delete(id);
      for (const [request, owner] of activeRequests) {
        if (owner === transport) activeRequests.delete(request);
      }
    };
    transport.onmessage = (message) => {
      const id = requestId(message);
      if (id !== undefined && isRequest(message)) activeRequests.set(id, transport);
      void stdio.send(message).catch(recordFailure);
    };
    transports.add(transport);
    await transport.start();
    return transport;
  };

  const handleMcpRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
    const sessionId = sessionHeader(request);
    const transport = sessionId === undefined
      ? (isInitialize(body) ? await createHttpTransport() : undefined)
      : sessions.get(sessionId);
    if (transport === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: { code: -32_000, message: 'Invalid or missing MCP session ID.' },
        id: null,
        jsonrpc: '2.0',
      }));
      return;
    }
    await transport.handleRequest(request, response, body);
  };

  await stdio.start();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let healthy = true;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      if (healthy && transportFailure === undefined) response.writeHead(200).end('ok');
      else response.writeHead(503).end('unhealthy');
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    void handleMcpRequest(request, response).catch((error: unknown) => {
      recordFailure(error);
      if (!response.headersSent) response.writeHead(500);
      if (!response.writableEnded) response.end();
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(address.port)}`;
  await waitForHealth(`${origin}/health`);

  let closed = false;
  return Object.freeze({
    close: async () => {
      if (closed) return;
      closed = true;
      healthy = false;
      await Promise.allSettled([
        closeHttpServer(server),
        ...[...transports].map((transport) => transport.close()),
        stdio.close(),
      ]);
    },
    diagnostics: () => diagnostics,
    url: `${origin}/mcp`,
  });
};

const readExpectedFailures = async (): Promise<readonly string[]> => {
  const document = parse(await readFile(expectedFailuresPath, 'utf8')) as {
    readonly server?: unknown;
  };
  if (
    !Array.isArray(document.server) ||
    !document.server.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new TypeError('MCP conformance expected failures must be a YAML server string list.');
  }
  return Object.freeze([...document.server]);
};

const parseReport = (
  output: string,
  expectedFailures: readonly string[],
): McpConformanceReport => {
  const normalized = output;
  let passed = 0;
  let failed = 0;
  for (const match of normalized.matchAll(scenarioSummary)) {
    if (Number(match[3]) === 0) passed += 1;
    else failed += 1;
  }
  if (passed + failed === 0) {
    throw new Error(`Official MCP conformance output contained no scenario summaries.\n${normalized}`);
  }
  const total = Number(suiteSummary.exec(normalized)?.[1] ?? passed + failed);
  return Object.freeze({
    expectedFailures,
    failed,
    passed,
    runnerVersion,
    skipped: Math.max(0, total - passed - failed),
    specVersion,
  });
};

export const runMcpConformance = async (): Promise<McpConformanceReport> => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-conformance-'));
  const project = join(fixture, 'route-harness');
  const artifact = join(project, 'artifact');
  const outputRoot = resolve(
    process.env['AGENT_BUNDLE_MCP_CONFORMANCE_OUTPUT'] ?? defaultOutputRoot,
  );
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(dirname(outputRoot), { recursive: true });
  const expectedFailures = await readExpectedFailures();

  let bridge: GeneratedMcpBridge | undefined;
  try {
    await cp(fixtureRoot, project, { recursive: true });
    // Persistent state injects the runtime's generated notice-inbox source,
    // which only the packed fixture's npm install places beneath this copied
    // root. Conformance needs one generated MCP surface, not another install
    // journey, so omit unrelated state, event, and CLI surfaces and narrow the
    // copied fixture config to its generated MCP routes.
    await Promise.all([
      rm(join(project, 'src/cli'), { force: true, recursive: true }),
      rm(join(project, 'src/events'), { force: true, recursive: true }),
      rm(join(project, 'src/state.ts'), { force: true }),
      writeFile(join(project, 'agent-bundle.config.ts'), [
        'export default {',
        "  plugin: { name: 'route-harness', version: '1.0.0' },",
        '  routes: { mcpCommands: true },',
        "  targets: ['claude'],",
        '};',
        '',
      ].join('\n')),
      writeFile(join(project, 'package.json'), JSON.stringify({
        dependencies: {
          '@agent-bundle/runtime': 'workspace:*',
          '@modelcontextprotocol/server': '2.0.0',
          react: '19.2.8',
          zod: '4.4.3',
        },
        name: 'route-harness-conformance',
        private: true,
        type: 'module',
        version: '1.0.0',
      })),
    ]);
    await symlink(packageNodeModules, join(project, 'node_modules'), 'dir');
    const compiled = await build({ output: artifact, root: project, targets: ['claude'] });
    const entry = compiled.build.compiledMcpEntries.find((candidate) => candidate.id === 'mcp:harness');
    if (entry === undefined) {
      throw new Error(
        `Route harness build produced no generated MCP server (model: ${compiled.model.mcpServers.map((candidate) => candidate.name).join(', ')}; compiled: ${compiled.build.compiledMcpEntries.map((candidate) => candidate.name).join(', ')}).`,
      );
    }

    bridge = await startGeneratedMcpBridge({
      cwd: project,
      entry: entry.output,
      pluginRoot: join(artifact, 'claude'),
    });
    const result = await runBoundedChildProcess({
      args: [
        conformanceEntry,
        'server',
        '--url',
        bridge.url,
        '--suite',
        'active',
        '--spec-version',
        specVersion,
        '--output-dir',
        outputRoot,
        '--expected-failures',
        expectedFailuresPath,
      ],
      cwd: workspaceRoot,
      executable: process.execPath,
    }, {
      forceFinishMs: 5_000,
      labels: {
        outputLimit: 'output-limit',
        timedOut: 'timed-out',
      },
      maxOutputBytes: runnerOutputLimitBytes,
      outputBudget: 'combined',
      timeoutMs: runnerTimeoutMs,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const report = parseReport(output, expectedFailures);
    if (result.exitCode !== 0 || result.termination !== undefined) {
      throw new Error(
        [
          `Official MCP conformance failed (exit ${String(result.exitCode)}, termination ${String(result.termination ?? 'none')}).`,
          output,
          bridge.diagnostics() === '' ? '' : `Generated server stderr:\n${bridge.diagnostics()}`,
        ].filter(Boolean).join('\n\n'),
      );
    }
    console.info(
      `MCP conformance ${runnerVersion} / spec ${specVersion}: ${String(report.passed)} passed, ${String(report.failed)} failed, ${String(report.skipped)} skipped.`,
    );
    return report;
  } finally {
    await bridge?.close();
    await rm(fixture, { force: true, recursive: true });
  }
};
