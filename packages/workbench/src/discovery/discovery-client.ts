import { z } from 'zod';

import type {
  DiscoveryBundleFinding,
  DiscoveryDiagnostic,
  DiscoveryDurableState,
  DiscoveryDurableStateStore,
  DiscoveryEndpointReport,
  DiscoveryFinding,
  DiscoveryFindingState,
  DiscoveryHost,
  DiscoveryHostReport,
  DiscoveryInventoryStatus,
  DiscoveryProbe,
  DiscoveryProbeStatus,
  DiscoveryRuntimeStatus,
  HostDiscoveryReport,
} from '../../../agent-bundle/src/contracts/discovery.ts';
import type {
  McpProbeFailure,
  McpProbeFailureKind,
  McpProbeHost,
  McpProbeLaunch,
  McpProbeLaunchRemote,
  McpProbeLaunchStdio,
  McpProbeReport,
  McpProbeSnapshot,
  McpProbeStatus,
  McpProbeTool,
} from '../../../agent-bundle/src/contracts/mcp-probe.ts';
import { deeplyFrozenHookValue } from '../hooks/hook-client.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';

export type {
  DiscoveryBundleFinding,
  DiscoveryDiagnostic,
  DiscoveryDurableState,
  DiscoveryDurableStateStore,
  DiscoveryEndpointReport,
  DiscoveryFinding,
  DiscoveryFindingState,
  DiscoveryHost,
  DiscoveryHostReport,
  DiscoveryInventoryStatus,
  DiscoveryProbe,
  DiscoveryProbeStatus,
  DiscoveryRuntimeStatus,
  HostDiscoveryReport,
  McpProbeFailure,
  McpProbeFailureKind,
  McpProbeHost,
  McpProbeLaunch,
  McpProbeLaunchRemote,
  McpProbeLaunchStdio,
  McpProbeReport,
  McpProbeSnapshot,
  McpProbeStatus,
  McpProbeTool,
};

export interface DiscoveryClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

export class DiscoveryClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'DiscoveryClientError';
    this.code = code;
    this.status = status;
  }
}

const invalidResponse = (): DiscoveryClientError =>
  new DiscoveryClientError('AB8234', 'Host discovery route returned an invalid response.');

const invalidProbeResponse = (): DiscoveryClientError =>
  new DiscoveryClientError('AB8235', 'MCP probe route returned an invalid response.');

const textSchema = z.string();
const diagnosticSchema = z.strictObject({
  code: textSchema,
  message: textSchema,
  recovery: textSchema,
  severity: z.enum(['error', 'info', 'warning']),
  target: textSchema.optional(),
});
const durableStateStoreSchema = z.strictObject({
  bytes: z.number(),
  file: textSchema,
  mtime: textSchema,
  path: textSchema,
});
const durableStateSchema = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
  directory: textSchema,
  findings: z.array(durableStateStoreSchema),
  status: z.enum(['known', 'warnings']),
  summary: z.strictObject({
    bytes: z.number(),
    stores: z.number(),
  }),
});
const findingStateSchema = z.enum([
  'conflicted',
  'corrupt',
  'disabled',
  'drifted',
  'failed',
  'installed',
  'interrupted-install',
  'live',
  'missing',
  'registered',
  'skipped',
  'stale-lock',
  'stale-socket',
  'unknown',
  'unregistered',
]);
const runtimeStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({
    artifactEpoch: textSchema,
    availability: z.enum(['available', 'runtime-restarted', 'runtime-unavailable']),
    instanceId: textSchema,
    pid: z.number().int().positive(),
    startedAt: textSchema.optional(),
    status: z.literal('available'),
  }),
  z.strictObject({
    status: z.enum(['failed', 'unavailable', 'unsupported']),
  }),
]);
const findingShape = {
  durableState: durableStateSchema.optional(),
  entry: textSchema.optional(),
  manifest: textSchema.optional(),
  name: textSchema.optional(),
  path: textSchema.optional(),
  runtime: runtimeStatusSchema.optional(),
  state: findingStateSchema,
  version: textSchema.optional(),
} as const;
const findingSchema = z.strictObject(findingShape);
const bundleFindingSchema = z.strictObject({
  ...findingShape,
  bundleRoot: textSchema.optional(),
  marketplace: textSchema.optional(),
  mcpServers: z.array(z.strictObject({
    name: textSchema,
    transport: z.enum(['stdio', 'streamable-http']),
  })).optional(),
});
const probeSchema = z.strictObject({
  evidence: z.literal('directory').optional(),
  status: z.enum(['available', 'failed', 'unavailable']),
  version: textSchema.optional(),
});
const hostReportSchema = z.strictObject({
  bundle: bundleFindingSchema.optional(),
  diagnostics: z.array(diagnosticSchema),
  host: z.enum(['claude', 'codex', 'cursor']),
  inventory: z.strictObject({
    findings: z.array(findingSchema),
    status: z.enum(['known', 'skipped', 'unknown']),
  }),
  probe: probeSchema,
});
const endpointReportSchema = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
  directory: textSchema,
  findings: z.array(findingSchema),
  status: z.enum(['failed', 'healthy', 'skipped', 'warnings']),
  summary: z.strictObject({
    live: z.number(),
    staleLocks: z.number(),
    staleSockets: z.number(),
  }),
});
const discoveryReportSchema = z.strictObject({
  bundleSource: textSchema.optional(),
  diagnostics: z.array(diagnosticSchema),
  endpoints: endpointReportSchema,
  generatedAt: textSchema,
  hosts: z.array(hostReportSchema),
  manifestDigest: textSchema.optional(),
  summary: z.strictObject({
    errors: z.number(),
    infos: z.number(),
    warnings: z.number(),
  }),
});
const errorResponseSchema = z.strictObject({
  diagnostic: z.strictObject({
    code: textSchema,
    message: textSchema,
  }),
});

const mcpProbeLaunchSchema = z.union([
  z.strictObject({
    args: z.array(textSchema),
    command: textSchema,
    cwd: textSchema.optional(),
    env: z.record(textSchema, textSchema),
    kind: z.literal('stdio'),
  }),
  z.strictObject({
    kind: z.literal('streamable-http'),
    url: textSchema,
  }),
]);
const mcpProbeToolSchema = z.strictObject({
  description: textSchema.optional(),
  name: textSchema,
  title: textSchema.optional(),
});
const mcpProbeSnapshotSchema = z.strictObject({
  capabilities: z.record(textSchema, z.boolean()),
  instructions: textSchema.optional(),
  protocolVersion: textSchema,
  serverInfo: z.strictObject({
    name: textSchema,
    title: textSchema.optional(),
    version: textSchema,
  }),
  tools: z.array(mcpProbeToolSchema),
  toolsTruncated: z.boolean(),
});
const mcpProbeFailureSchema = z.strictObject({
  detail: textSchema,
  kind: z.enum(['connect', 'handshake', 'protocol']),
});
const mcpProbeReportShape = {
  durationMs: z.number(),
  generatedAt: textSchema,
  host: z.enum(['claude', 'codex', 'cursor']),
  launch: mcpProbeLaunchSchema,
  serverName: textSchema,
} as const;
const mcpProbeReportSchema = z.union([
  z.strictObject({
    ...mcpProbeReportShape,
    snapshot: mcpProbeSnapshotSchema,
    status: z.literal('ok'),
  }),
  z.strictObject({
    ...mcpProbeReportShape,
    failure: mcpProbeFailureSchema,
    status: z.enum(['timed-out', 'unreachable']),
  }),
]);

const frozenInput = (
  value: unknown,
  invalid: () => DiscoveryClientError = invalidResponse,
): unknown => {
  try {
    return deeplyFrozenHookValue(value);
  } catch {
    throw invalid();
  }
};

const decode = (value: unknown): HostDiscoveryReport => {
  const parsed = discoveryReportSchema.safeParse(frozenInput(value));
  if (!parsed.success) throw invalidResponse();
  return frozenInput(parsed.data) as HostDiscoveryReport;
};

const decodeProbe = (value: unknown): McpProbeReport => {
  const parsed = mcpProbeReportSchema.safeParse(frozenInput(value, invalidProbeResponse));
  if (!parsed.success) throw invalidProbeResponse();
  return frozenInput(parsed.data, invalidProbeResponse) as McpProbeReport;
};

const diagnosticFailureFor = (
  value: unknown,
  status: number,
  fallbackCode: string,
  fallbackMessage: string,
  invalid: () => DiscoveryClientError,
): DiscoveryClientError => {
  let parsed: z.infer<typeof errorResponseSchema> | undefined;
  try {
    const result = errorResponseSchema.safeParse(frozenInput(value, invalid));
    if (result.success) parsed = result.data;
  } catch {
    // Invalid failure bodies fall through to the status-only diagnostic.
  }
  if (parsed === undefined) {
    return new DiscoveryClientError(fallbackCode, fallbackMessage, status);
  }
  return new DiscoveryClientError(parsed.diagnostic.code, parsed.diagnostic.message, status);
};

const failureFor = (value: unknown, status: number): DiscoveryClientError => diagnosticFailureFor(
  value,
  status,
  'AB8234',
  `Host discovery request failed with HTTP ${String(status)}.`,
  invalidResponse,
);

const probeFailureFor = (value: unknown, status: number): DiscoveryClientError => diagnosticFailureFor(
  value,
  status,
  'AB8235',
  `MCP probe request failed with HTTP ${String(status)}.`,
  invalidProbeResponse,
);

/** Strict browser client for read-only local host discovery. */
export class DiscoveryClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: DiscoveryClientOptions) {
    this.#foreground = options.foreground;
  }

  async discover(signal?: AbortSignal): Promise<HostDiscoveryReport> {
    const response = await this.#foreground.protectedRequest(
      '/api/discovery',
      signal === undefined ? {} : { signal },
    );
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw failureFor(body, response.status);
    return decode(body);
  }

  async probe(
    request: Readonly<{ readonly host: McpProbeHost; readonly serverName: string }>,
    signal?: AbortSignal,
  ): Promise<McpProbeReport> {
    const response = await this.#foreground.protectedRequest('/api/discovery/probes', {
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw probeFailureFor(body, response.status);
    return decodeProbe(body);
  }
}
