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
  HostDiscoveryReport,
} from '../../../agent-bundle/src/contracts/discovery.ts';
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
  HostDiscoveryReport,
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
const findingShape = {
  durableState: durableStateSchema.optional(),
  entry: textSchema.optional(),
  manifest: textSchema.optional(),
  name: textSchema.optional(),
  path: textSchema.optional(),
  state: findingStateSchema,
  version: textSchema.optional(),
} as const;
const findingSchema = z.strictObject(findingShape);
const bundleFindingSchema = z.strictObject({
  ...findingShape,
  bundleRoot: textSchema.optional(),
  marketplace: textSchema.optional(),
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

const frozenInput = (value: unknown): unknown => {
  try {
    return deeplyFrozenHookValue(value);
  } catch {
    throw invalidResponse();
  }
};

const decode = (value: unknown): HostDiscoveryReport => {
  const parsed = discoveryReportSchema.safeParse(frozenInput(value));
  if (!parsed.success) throw invalidResponse();
  return frozenInput(parsed.data) as HostDiscoveryReport;
};

const failureFor = (value: unknown, status: number): DiscoveryClientError => {
  let parsed: z.infer<typeof errorResponseSchema> | undefined;
  try {
    const result = errorResponseSchema.safeParse(frozenInput(value));
    if (result.success) parsed = result.data;
  } catch {
    // Invalid failure bodies fall through to the status-only diagnostic.
  }
  if (parsed === undefined) {
    return new DiscoveryClientError(
      'AB8234',
      `Host discovery request failed with HTTP ${String(status)}.`,
      status,
    );
  }
  return new DiscoveryClientError(parsed.diagnostic.code, parsed.diagnostic.message, status);
};

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
}
