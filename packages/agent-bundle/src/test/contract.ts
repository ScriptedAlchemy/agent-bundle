/**
 * The generated-plugin contract matrix — framework-owned wire-contract checks
 * at two proof boundaries today (`mcp-in-memory` and packed stdio).
 *
 * Both entry points share one implementation. Boundary differences are explicit
 * capability flags, not forked check logic. The project supplies only fixtures
 * — valid inputs, declared result-compat policy, version-skew payloads, and
 * optional cancellation cases — not the check logic itself.
 *
 * **`runContractMatrix` (`mcp-in-memory`)** opens one real MCP client against
 * the real generated server over the SDK's in-memory transport and runs the
 * full matrix including module-backed validation: JSON serialized round-trip
 * through each tool route's own `resultSchema`, declared additive/closed compat
 * behavior, and previous-server payload acceptance. In-memory transport may
 * pass structured values without serialization; the explicit
 * `JSON.parse(JSON.stringify(...))` round-trip closes that gap. MCP Apps are
 * not registered at this level.
 *
 * **`runPackedContractMatrix` (`packed-stdio` / `packed-deleted-source`)** runs
 * against an already-open packed session. It proves process stdio evidence for
 * surface completeness (including compiled MCP App resource URIs), fixture
 * coverage, successful-path sweeps, advertised input-schema rejection, and
 * client-side cancellation hygiene. It cannot load project route modules — source
 * may be deleted and verified absent — so serialized-round-trip, compat-probe,
 * and version-skew are reported `not-applicable`. The packed server validates
 * every tool result through its bundled `resultSchema` before returning; a
 * successful sweep invocation is that evidence.
 *
 * **Neither boundary proves:** host install, browser App HTML, or lifecycle
 * replay across artifact rebuilds (stage 2+).
 */
import type { Client } from '@modelcontextprotocol/client';

import { AgentTestError, captured } from './errors.ts';
import {
  MCP_IN_MEMORY_PROOF_LEVEL,
  proofLevelLabel,
  type AgentBundleTestManifest,
  type AgentTestProofLevel,
} from './manifest.ts';
import {
  openInMemoryMcpServer,
  type InMemoryMcpSessionOptions,
  type McpProjectionProvenance,
} from './mcp.ts';
import type { PackedMcpProvenance, PackedMcpSession } from './packed.ts';
import { registeredRouteLoader, testManifest } from './registry.ts';
import type { AgentRouteModule, TestableRouteDescriptor } from './types.ts';

/** Declared serialized-result compatibility policy for tool routes. */
export type ResultCompatPolicy = 'additive' | 'closed';

export interface ContractRouteFixture {
  /** Valid input for the sweep invocation (tools/prompts; resources need none). */
  readonly input?: unknown;
  /** Additional valid inputs — e.g. one per declared status/discriminant value. */
  readonly inputs?: readonly unknown[];
  /** Declared serialized-result compatibility policy. REQUIRED for tool routes. */
  readonly resultCompat?: ResultCompatPolicy;
  /**
   * Serialized payloads captured from previous server versions; each must parse
   * under the CURRENT `resultSchema` (previous-server + current-client skew).
   */
  readonly previousResults?: readonly unknown[];
  /**
   * Cancellation case: invocation aborted mid-flight must settle rejected and
   * leave the session usable.
   */
  readonly cancellation?: { readonly abortAfterMs?: number; readonly input?: unknown };
}

export interface ContractMatrixOptions extends InMemoryMcpSessionOptions {
  readonly manifest?: AgentBundleTestManifest;
  readonly server?: string;
  /** Route id -> fixture. Every compiled non-app route on the server must be covered. */
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
}

export type ContractCheckStatus = 'failed' | 'not-applicable' | 'passed';

export interface ContractCheckOutcome {
  readonly reason?: string;
  readonly status: ContractCheckStatus;
}

export interface ContractRouteReport {
  readonly checks: Readonly<Record<string, ContractCheckOutcome>>;
}

export type ContractMatrixProvenance = McpProjectionProvenance | PackedMcpProvenance;

export interface ContractMatrixReport {
  readonly provenance: ContractMatrixProvenance;
  readonly routes: Readonly<Record<string, ContractRouteReport>>;
}

export interface PackedContractMatrixOptions {
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
  readonly manifest: AgentBundleTestManifest;
  readonly server?: string;
  /** An already-open packed session; this entry point never opens or closes it. */
  readonly session: PackedMcpSession;
}

interface MatrixBoundaryCapabilities {
  readonly canLoadRouteModules: boolean;
  readonly moduleSchemaNotApplicableReason: string;
  readonly proofLevel: AgentTestProofLevel;
  readonly registersAppResources: boolean;
}

const PACKED_MODULE_SCHEMA_NOT_APPLICABLE_REASON =
  'packed sessions cannot load project route modules (source may be deleted and verified absent); loading a module would silently break deleted-source proof. The packed server validates every tool result through its bundled resultSchema before returning — a successful sweep invocation is that evidence.';

const IN_MEMORY_BOUNDARY: MatrixBoundaryCapabilities = Object.freeze({
  canLoadRouteModules: true,
  moduleSchemaNotApplicableReason: '',
  proofLevel: MCP_IN_MEMORY_PROOF_LEVEL,
  registersAppResources: false,
});

const packedBoundaryFromSession = (session: PackedMcpSession): MatrixBoundaryCapabilities =>
  Object.freeze({
    canLoadRouteModules: false,
    moduleSchemaNotApplicableReason: PACKED_MODULE_SCHEMA_NOT_APPLICABLE_REASON,
    proofLevel: session.provenance.proofLevel,
    registersAppResources: true,
  });

const COMPAT_PROBE_KEY = '__agentBundleContractProbe';

const CHECK_SURFACE = 'surface-completeness';
const CHECK_COVERAGE = 'coverage';
const CHECK_SWEEP = 'sweep';
const CHECK_SERIALIZED_ROUND_TRIP = 'serialized-round-trip';
const CHECK_COMPAT_PROBE = 'compat-probe';
const CHECK_VERSION_SKEW = 'version-skew';
const CHECK_NEGATIVE_INPUTS = 'negative-inputs';
const CHECK_CANCELLATION = 'cancellation';

interface MatrixFailure {
  readonly check: string;
  readonly reason: string;
  readonly routeId: string;
}

interface ToolListingEntry {
  readonly inputSchema?: Record<string, unknown>;
  readonly name: string;
}

interface LiveSurface {
  readonly prompts: readonly string[];
  readonly resources: readonly string[];
  readonly tools: readonly ToolListingEntry[];
}

const routeProtocolName = (descriptor: TestableRouteDescriptor): string =>
  descriptor.id.slice(descriptor.id.lastIndexOf('/') + 1);

const routeResourceUri = (descriptor: TestableRouteDescriptor): string | undefined => {
  const uri = descriptor.config.uri;
  return typeof uri === 'string' ? uri : undefined;
};

const routeAppResourceUri = (
  descriptor: TestableRouteDescriptor,
  manifest: AgentBundleTestManifest,
): string | undefined => {
  const fromConfig = descriptor.config.resourceUri;
  if (typeof fromConfig === 'string') return fromConfig;
  const app = Object.values(manifest.apps).find((entry) => entry.id === descriptor.id);
  return app?.resourceUri;
};

const routeWireUri = (
  descriptor: TestableRouteDescriptor,
  manifest: AgentBundleTestManifest,
): string | undefined => (descriptor.kind === 'app'
  ? routeAppResourceUri(descriptor, manifest)
  : routeResourceUri(descriptor));

const serverRoutes = (
  manifest: AgentBundleTestManifest,
  serverName: string,
): readonly TestableRouteDescriptor[] => Object.values(manifest.routes)
  .filter((route) => route.serverId === `mcp:${serverName}` && route.kind !== 'app')
  .sort((left, right) => left.id.localeCompare(right.id));

const serverAppRoutes = (
  manifest: AgentBundleTestManifest,
  serverName: string,
): readonly TestableRouteDescriptor[] => Object.values(manifest.routes)
  .filter((route) => route.serverId === `mcp:${serverName}` && route.kind === 'app')
  .sort((left, right) => left.id.localeCompare(right.id));

const compiledServerNames = (manifest: AgentBundleTestManifest): readonly string[] => [
  ...new Set(Object.values(manifest.routes).flatMap((route) =>
    (route.serverId === undefined ? [] : [route.serverId.replace(/^mcp:/u, '')]))),
].sort((left, right) => left.localeCompare(right));

const resolveServerName = (
  manifest: AgentBundleTestManifest,
  requested: string | undefined,
): string => {
  const names = compiledServerNames(manifest);
  if (requested !== undefined) {
    if (!names.includes(requested)) {
      throw new AgentTestError('server-not-found', `No compiled MCP server is named ${JSON.stringify(requested)}.`, {
        details: [
          `project root: ${manifest.projectRoot}`,
          `compiled:     ${names.length === 0 ? 'this project compiled no MCP servers' : names.join(', ')}`,
        ],
        recovery: 'Name one of the compiled servers, or add route modules under src/mcp/<server>/.',
      });
    }
    return requested;
  }
  if (names.length === 1) return names[0]!;
  throw new AgentTestError(
    'server-not-found',
    names.length === 0
      ? 'This project compiled no MCP servers.'
      : 'This project compiled more than one MCP server, so the contract matrix cannot pick one.',
    {
      details: [
        `project root: ${manifest.projectRoot}`,
        `compiled:     ${names.length === 0 ? 'none' : names.join(', ')}`,
      ],
      recovery: 'Pass { server: "<name>" }.',
    },
  );
};

const passed = (): ContractCheckOutcome => ({ status: 'passed' });
const passedWithReason = (reason: string): ContractCheckOutcome => ({ reason, status: 'passed' });
const failed = (reason: string): ContractCheckOutcome => ({ reason, status: 'failed' });
const notApplicable = (reason: string): ContractCheckOutcome => ({ reason, status: 'not-applicable' });

const recordFailure = (
  failures: MatrixFailure[],
  routeId: string,
  check: string,
  reason: string,
): void => {
  failures.push({ check, reason, routeId });
};

const outcomeFromCheck = (
  failures: MatrixFailure[],
  routeId: string,
  check: string,
  outcome: ContractCheckOutcome,
): ContractCheckOutcome => {
  if (outcome.status === 'failed') {
    recordFailure(failures, routeId, check, outcome.reason ?? 'check failed');
  }
  return outcome;
};

const fixtureInputs = (fixture: ContractRouteFixture): readonly unknown[] => {
  const inputs = [
    ...(fixture.input === undefined ? [{}] : [fixture.input]),
    ...(fixture.inputs ?? []),
  ];
  return inputs.length === 0 ? [{}] : inputs;
};

const loadRouteModule = async (
  manifest: AgentBundleTestManifest,
  descriptor: TestableRouteDescriptor,
): Promise<AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } }> => {
  const loader = registeredRouteLoader(manifest, descriptor.id);
  if (loader === undefined) {
    throw new AgentTestError(
      'manifest-unavailable',
      `Route ${descriptor.id} is compiled but no test-time module loader is registered for it.`,
      { recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers route loaders.' },
    );
  }
  const module = await loader();
  if (module.resultSchema === undefined) {
    throw new AgentTestError(
      'invalid-route-module',
      `Route ${descriptor.id} exports no resultSchema, which the contract matrix requires for validation checks.`,
    );
  }
  return { ...module, resultSchema: module.resultSchema };
};

const listLiveSurface = async (client: Client): Promise<LiveSurface> => {
  const [tools, resources, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listPrompts(),
  ]);
  return {
    prompts: Object.freeze(prompts.prompts.map((entry) => entry.name).sort()),
    resources: Object.freeze(resources.resources.map((entry) => entry.uri).sort()),
    tools: Object.freeze(tools.tools.map((entry) => ({
      inputSchema: entry.inputSchema as Record<string, unknown> | undefined,
      name: entry.name,
    })).sort((left, right) => left.name.localeCompare(right.name))),
  };
};

type ToolInvocationResult =
  | { readonly isError: boolean; readonly structuredContent?: unknown; readonly threw: false }
  | { readonly threw: true; readonly error: unknown };

const invocationCacheKey = (name: string, input: unknown): string =>
  `${name}\0${JSON.stringify(input ?? {})}`;

const callToolResult = async (
  client: Client,
  name: string,
  input: unknown,
  options?: {
    readonly cache?: Map<string, ToolInvocationResult>;
    readonly signal?: AbortSignal;
    readonly timeout?: number;
  },
): Promise<ToolInvocationResult> => {
  if (options?.signal === undefined && options?.cache !== undefined) {
    const cached = options.cache.get(invocationCacheKey(name, input));
    if (cached !== undefined) return cached;
  }
  try {
    const result = await client.callTool(
      { arguments: (input ?? {}) as Record<string, unknown>, name },
      {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
      },
    ) as { isError?: boolean; structuredContent?: unknown };
    const settled: ToolInvocationResult = {
      isError: result.isError === true,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      threw: false,
    };
    if (options?.signal === undefined && options?.cache !== undefined) {
      options.cache.set(invocationCacheKey(name, input), settled);
    }
    return settled;
  } catch (error) {
    const settled: ToolInvocationResult = { error, threw: true };
    if (options?.signal === undefined && options?.cache !== undefined) {
      options.cache.set(invocationCacheKey(name, input), settled);
    }
    return settled;
  }
};

const serializedRoundTrip = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown;

const compatProbe = (
  payload: unknown,
  policy: ResultCompatPolicy,
  parse: (value: unknown) => unknown,
): { readonly accepted: boolean; readonly error?: unknown } => {
  const probed = {
    ...(typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {}),
    [COMPAT_PROBE_KEY]: true,
  };
  try {
    parse(probed);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, error };
  }
};

const wrongJsonType = (schemaType: unknown): unknown => {
  switch (schemaType) {
    case 'string':
      return 0;
    case 'number':
    case 'integer':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return {};
    case 'object':
      return 'not-an-object';
    default:
      return null;
  }
};

/**
 * Derives negative input cases from a tool's ADVERTISED input JSON Schema — the
 * wire contract from `listTools`, not the route module's zod source.
 *
 * Generates, when the schema has top-level object structure:
 * - one unknown-extra-key case
 * - one missing-required-property case per required field
 * - one wrong-JSON-type case per typed top-level property
 *
 * **Unknown-extra-key tolerance:** when the advertised schema declares
 * `additionalProperties: false`, plain `z.object` tool routes may still strip
 * unknown keys without a protocol failure. The negative-inputs check records
 * that acceptance when other generated negatives still prove rejection paths.
 *
 * Does NOT prove deep nested validation, format constraints, or enum exhaustiveness
 * beyond the top-level object shape the MCP SDK advertises.
 */
export const negativeInputsFromJsonSchema = (
  schema: Record<string, unknown>,
): readonly { readonly label: string; readonly input: Record<string, unknown> }[] | undefined => {
  if (schema.type !== 'object') return undefined;
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  const propertyEntries = Object.entries(properties as Record<string, Record<string, unknown>>);
  if (propertyEntries.length === 0 && !Array.isArray(schema.required)) {
    return [{ input: { __agentBundleContractNegative: true }, label: 'unknown-extra-key' }];
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const negatives: { readonly label: string; readonly input: Record<string, unknown> }[] = [
    { input: { __agentBundleContractNegative: true }, label: 'unknown-extra-key' },
  ];
  for (const key of required) {
    const present = Object.fromEntries(
      required.filter((candidate) => candidate !== key).map((candidate) => {
        const propertySchema = (properties as Record<string, Record<string, unknown>>)[candidate];
        const type = propertySchema?.type;
        return [candidate, typeof type === 'string' ? defaultValueForType(type) : 'value'];
      }),
    );
    negatives.push({ input: present, label: `missing-required:${key}` });
  }
  for (const [key, propertySchema] of propertyEntries) {
    const type = propertySchema.type;
    if (typeof type !== 'string') continue;
    const base = Object.fromEntries(
      propertyEntries.map(([propertyKey, property]) => [
        propertyKey,
        propertyKey === key ? wrongJsonType(type) : defaultValueForType(typeof property.type === 'string' ? property.type : 'string'),
      ]),
    );
    negatives.push({ input: base, label: `wrong-type:${key}` });
  }
  return negatives;
};

const defaultValueForType = (type: string): unknown => {
  switch (type) {
    case 'string':
      return 'value';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'value';
  }
};

const checkSurfaceCompleteness = (
  descriptor: TestableRouteDescriptor,
  surface: LiveSurface,
  manifest: AgentBundleTestManifest,
  boundary: MatrixBoundaryCapabilities,
): ContractCheckOutcome => {
  switch (descriptor.kind) {
    case 'tool': {
      const name = routeProtocolName(descriptor);
      return surface.tools.some((entry) => entry.name === name)
        ? passed()
        : failed(`tool ${JSON.stringify(name)} is missing from listTools`);
    }
    case 'resource': {
      const uri = routeResourceUri(descriptor);
      if (uri === undefined) {
        return failed('resource route config exports no uri to compare against listResources');
      }
      return surface.resources.includes(uri)
        ? passed()
        : failed(`resource URI ${JSON.stringify(uri)} is missing from listResources`);
    }
    case 'prompt': {
      const name = routeProtocolName(descriptor);
      return surface.prompts.includes(name)
        ? passed()
        : failed(`prompt ${JSON.stringify(name)} is missing from listPrompts`);
    }
    case 'app': {
      if (!boundary.registersAppResources) {
        return notApplicable('MCP Apps are not registered by the in-memory projection level.');
      }
      const uri = routeAppResourceUri(descriptor, manifest);
      if (uri === undefined) {
        return failed('app route config exports no resourceUri to compare against listResources');
      }
      return surface.resources.includes(uri)
        ? passed()
        : failed(`MCP App resource URI ${JSON.stringify(uri)} is missing from listResources`);
    }
    case 'cli':
    case 'event-route':
    case 'script':
      return notApplicable(`route kind ${descriptor.kind} is not registered on the MCP server surface.`);
    default: {
      const exhaustive: never = descriptor.kind;
      return failed(`unsupported route kind ${String(exhaustive)} for surface completeness`);
    }
  }
};

const runSweep = async (
  client: Client,
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  manifest: AgentBundleTestManifest,
  cache: Map<string, ToolInvocationResult>,
): Promise<ContractCheckOutcome> => {
  switch (descriptor.kind) {
    case 'tool': {
      for (const input of fixtureInputs(fixture)) {
        const result = await callToolResult(client, routeProtocolName(descriptor), input, { cache });
        if (result.threw) {
          return failed(`callTool threw: ${result.error instanceof Error ? result.error.message : captured(result.error)}`);
        }
        if (result.isError) {
          return notApplicable(
            'Invocation returned isError; sweep proves successful invocation paths only.',
          );
        }
        if (result.structuredContent === undefined) {
          return failed(`callTool returned no structuredContent for input ${captured(input)}`);
        }
      }
      return passed();
    }
    case 'resource':
    case 'app': {
      const uri = routeWireUri(descriptor, manifest);
      if (uri === undefined) {
        return failed(`${descriptor.kind} route config exports no uri to read`);
      }
      const read = await client.readResource({ uri }) as { contents?: unknown };
      const contents = Array.isArray(read.contents) ? read.contents : [];
      return contents.length === 0
        ? failed(`readResource returned no contents for ${JSON.stringify(uri)}`)
        : passed();
    }
    case 'prompt': {
      const result = await client.getPrompt({
        arguments: (fixture.input ?? {}) as Record<string, string>,
        name: routeProtocolName(descriptor),
      }) as { messages?: unknown };
      const messages = Array.isArray(result.messages) ? result.messages : [];
      return messages.length === 0
        ? failed(`getPrompt returned no messages for input ${captured(fixture.input ?? {})}`)
        : passed();
    }
    default:
      return notApplicable(`route kind ${descriptor.kind} has no sweep invocation at the MCP level.`);
  }
};

const runSerializedRoundTrip = async (
  client: Client,
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  module: AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } },
  cache: Map<string, ToolInvocationResult>,
): Promise<ContractCheckOutcome> => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('serialized round-trip applies to tool structuredContent only.');
  }
  for (const input of fixtureInputs(fixture)) {
    const result = await callToolResult(client, routeProtocolName(descriptor), input, { cache });
    if (result.threw) {
      return failed(`callTool threw before round-trip: ${result.error instanceof Error ? result.error.message : captured(result.error)}`);
    }
    if (result.isError) {
      return notApplicable('serialized round-trip requires a successful tool result.');
    }
    if (result.structuredContent === undefined) {
      return failed(`callTool returned no structuredContent for input ${captured(input)}`);
    }
    try {
      module.resultSchema.parse(serializedRoundTrip(result.structuredContent));
    } catch (error) {
      return failed(
        `JSON round-tripped structuredContent failed resultSchema.parse: ${error instanceof Error ? error.message : captured(error)}`,
      );
    }
  }
  return passed();
};

const runCompatProbe = async (
  client: Client,
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  module: AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } },
  cache: Map<string, ToolInvocationResult>,
): Promise<ContractCheckOutcome> => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('result compat policy applies to tool routes only.');
  }
  if (fixture.resultCompat === undefined) {
    return failed('tool route fixture must declare resultCompat (additive or closed).');
  }
  const input = fixtureInputs(fixture)[0] ?? {};
  const result = await callToolResult(client, routeProtocolName(descriptor), input, { cache });
  if (result.threw || result.structuredContent === undefined || result.isError) {
    return notApplicable('compat probe requires a successful tool result with structuredContent.');
  }
  const roundTripped = serializedRoundTrip(result.structuredContent);
  const probe = compatProbe(roundTripped, fixture.resultCompat, module.resultSchema.parse.bind(module.resultSchema));
  if (fixture.resultCompat === 'additive') {
    return probe.accepted
      ? passed()
      : failed(`declared additive policy but resultSchema rejected unknown key ${JSON.stringify(COMPAT_PROBE_KEY)}`);
  }
  return probe.accepted
    ? failed(`declared closed policy but resultSchema accepted unknown key ${JSON.stringify(COMPAT_PROBE_KEY)}`)
    : passed();
};

const runVersionSkew = (
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  module: AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } },
): ContractCheckOutcome => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('version-skew fixtures apply to tool routes only.');
  }
  if (fixture.previousResults === undefined || fixture.previousResults.length === 0) {
    return notApplicable('no previousResults fixtures declared.');
  }
  for (const [index, payload] of fixture.previousResults.entries()) {
    try {
      module.resultSchema.parse(payload);
    } catch (error) {
      return failed(
        `previousResults[${String(index)}] failed current resultSchema.parse: ${error instanceof Error ? error.message : captured(error)}`,
      );
    }
  }
  return passed();
};

const runNegativeInputs = async (
  client: Client,
  descriptor: TestableRouteDescriptor,
  surface: LiveSurface,
): Promise<ContractCheckOutcome> => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('negative input generation applies to tool routes only.');
  }
  const listing = surface.tools.find((entry) => entry.name === routeProtocolName(descriptor));
  if (listing?.inputSchema === undefined) {
    return notApplicable('listTools did not advertise an inputSchema for this tool.');
  }
  const negatives = negativeInputsFromJsonSchema(listing.inputSchema);
  if (negatives === undefined) {
    return notApplicable('advertised inputSchema has no top-level object structure to derive negative cases from.');
  }
  let anyRejected = false;
  let unknownExtraKeyAccepted = false;
  for (const negative of negatives) {
    const result = await callToolResult(client, routeProtocolName(descriptor), negative.input);
    if (result.threw || result.isError || result.structuredContent === undefined) {
      anyRejected = true;
      continue;
    }
    if (negative.label === 'unknown-extra-key') {
      unknownExtraKeyAccepted = true;
      continue;
    }
    return failed(`negative input ${negative.label} produced a successful tool result: ${captured(negative.input)}`);
  }
  if (!anyRejected) {
    return failed('no generated negative input caused callTool to fail or return isError');
  }
  return unknownExtraKeyAccepted
    ? passedWithReason(
      'unknown-extra-key input was accepted (advertised additionalProperties: false, but plain z.object routes may strip unknown keys without protocol failure); other generated negatives still proved rejection paths.',
    )
    : passed();
};

const runCancellation = async (
  client: Client,
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  cache: Map<string, ToolInvocationResult>,
): Promise<ContractCheckOutcome> => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('cancellation applies to tool routes only.');
  }
  if (fixture.cancellation === undefined) {
    return notApplicable('no cancellation fixture declared.');
  }
  const abortAfterMs = fixture.cancellation.abortAfterMs ?? 50;
  const settleWithinMs = abortAfterMs + 2_000;
  const controller = new AbortController();
  const input = fixture.cancellation.input ?? { holdMs: 5000 };
  const call = callToolResult(client, routeProtocolName(descriptor), input, {
    signal: controller.signal,
    timeout: settleWithinMs,
  });
  const timer = setTimeout(() => controller.abort(), abortAfterMs);
  const result = await Promise.race([
    call.then((settled) => ({ kind: 'settled' as const, settled })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), settleWithinMs);
    }),
  ]);
  clearTimeout(timer);
  if (result.kind === 'timeout') {
    return failed(`callTool did not settle within ${String(settleWithinMs)}ms after abort`);
  }
  if (!result.settled.threw) {
    return failed('aborted callTool settled without throwing or rejecting.');
  }
  const recoveryInput = fixtureInputs(fixture)[0] ?? {};
  const healthy = await callToolResult(client, routeProtocolName(descriptor), recoveryInput, { cache });
  if (healthy.threw) {
    return failed(`session did not recover: subsequent callTool threw: ${healthy.error instanceof Error ? healthy.error.message : captured(healthy.error)}`);
  }
  if (healthy.isError || healthy.structuredContent === undefined) {
    return failed('session did not recover: subsequent healthy invocation failed.');
  }
  return passed();
};

const matrixRouteDescriptors = (
  manifest: AgentBundleTestManifest,
  serverName: string,
): readonly TestableRouteDescriptor[] => [
  ...serverRoutes(manifest, serverName),
  ...serverAppRoutes(manifest, serverName),
].sort((left, right) => left.id.localeCompare(right.id));

const finalizeContractMatrixReport = (
  failures: MatrixFailure[],
  boundary: MatrixBoundaryCapabilities,
  provenance: ContractMatrixProvenance,
  routeReports: Record<string, ContractRouteReport>,
): ContractMatrixReport => {
  const report: ContractMatrixReport = Object.freeze({
    provenance,
    routes: Object.freeze(routeReports),
  });
  if (failures.length === 0) return report;

  const proofLabel = proofLevelLabel(boundary.proofLevel);
  const details = failures.map((entry) =>
    `- ${entry.routeId} / ${entry.check}: ${entry.reason} (${proofLabel})`);
  throw new AgentTestError(
    'contract-violation',
    `Contract matrix reported ${String(failures.length)} violation(s) at the ${boundary.proofLevel} proof level.`,
    {
      details,
      recovery: boundary.canLoadRouteModules
        ? 'Fix the failing route, fixture, or declared resultCompat policy; re-run runContractMatrix.'
        : 'Fix the failing route or fixture; re-run runPackedContractMatrix.',
    },
  );
};

const executeContractMatrix = async (options: {
  readonly boundary: MatrixBoundaryCapabilities;
  readonly client: Client;
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
  readonly manifest: AgentBundleTestManifest;
  readonly provenance: ContractMatrixProvenance;
  readonly serverName: string;
}): Promise<ContractMatrixReport> => {
  const { boundary, client, fixtures, manifest, provenance, serverName } = options;
  const failures: MatrixFailure[] = [];
  const routeReports: Record<string, ContractRouteReport> = {};
  const moduleSchemaNotApplicable = (): ContractCheckOutcome =>
    notApplicable(boundary.moduleSchemaNotApplicableReason);

  const unknownFixtureKeys = Object.keys(fixtures).filter(
    (routeId) => manifest.routes[routeId] === undefined,
  );
  if (unknownFixtureKeys.length > 0) {
    for (const routeId of unknownFixtureKeys.sort()) {
      recordFailure(
        failures,
        routeId,
        CHECK_COVERAGE,
        `fixture names unknown route ${JSON.stringify(routeId)}`,
      );
      routeReports[routeId] = {
        checks: {
          [CHECK_COVERAGE]: failed(`fixture names unknown route ${JSON.stringify(routeId)}`),
        },
      };
    }
  }

  const surface = await listLiveSurface(client);
  const invocationCache = new Map<string, ToolInvocationResult>();

  for (const descriptor of matrixRouteDescriptors(manifest, serverName)) {
    if (descriptor.kind === 'app' && !boundary.registersAppResources) {
      routeReports[descriptor.id] = {
        checks: {
          [CHECK_SURFACE]: notApplicable('MCP Apps are not registered by the in-memory projection level.'),
        },
      };
      continue;
    }

    const checks: Record<string, ContractCheckOutcome> = {};
    const fixture = fixtures[descriptor.id];

    checks[CHECK_COVERAGE] = outcomeFromCheck(
      failures,
      descriptor.id,
      CHECK_COVERAGE,
      fixture === undefined
        ? failed('compiled route has no fixture entry')
        : passed(),
    );

    checks[CHECK_SURFACE] = outcomeFromCheck(
      failures,
      descriptor.id,
      CHECK_SURFACE,
      checkSurfaceCompleteness(descriptor, surface, manifest, boundary),
    );

    if (fixture === undefined) {
      routeReports[descriptor.id] = { checks };
      continue;
    }

    checks[CHECK_SWEEP] = outcomeFromCheck(
      failures,
      descriptor.id,
      CHECK_SWEEP,
      await runSweep(client, descriptor, fixture, manifest, invocationCache),
    );

    if (descriptor.kind === 'tool') {
      if (boundary.canLoadRouteModules) {
        const module = await loadRouteModule(manifest, descriptor);
        checks[CHECK_SERIALIZED_ROUND_TRIP] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_SERIALIZED_ROUND_TRIP,
          await runSerializedRoundTrip(client, descriptor, fixture, module, invocationCache),
        );
        checks[CHECK_COMPAT_PROBE] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_COMPAT_PROBE,
          await runCompatProbe(client, descriptor, fixture, module, invocationCache),
        );
        checks[CHECK_VERSION_SKEW] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_VERSION_SKEW,
          runVersionSkew(descriptor, fixture, module),
        );
      } else {
        checks[CHECK_SERIALIZED_ROUND_TRIP] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_SERIALIZED_ROUND_TRIP,
          moduleSchemaNotApplicable(),
        );
        checks[CHECK_COMPAT_PROBE] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_COMPAT_PROBE,
          moduleSchemaNotApplicable(),
        );
        checks[CHECK_VERSION_SKEW] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_VERSION_SKEW,
          moduleSchemaNotApplicable(),
        );
      }
      checks[CHECK_NEGATIVE_INPUTS] = outcomeFromCheck(
        failures,
        descriptor.id,
        CHECK_NEGATIVE_INPUTS,
        await runNegativeInputs(client, descriptor, surface),
      );
      checks[CHECK_CANCELLATION] = outcomeFromCheck(
        failures,
        descriptor.id,
        CHECK_CANCELLATION,
        await runCancellation(client, descriptor, fixture, invocationCache),
      );
    } else {
      checks[CHECK_SERIALIZED_ROUND_TRIP] = notApplicable('applies to tool routes only.');
      checks[CHECK_COMPAT_PROBE] = notApplicable('applies to tool routes only.');
      checks[CHECK_VERSION_SKEW] = notApplicable('applies to tool routes only.');
      checks[CHECK_NEGATIVE_INPUTS] = notApplicable('applies to tool routes only.');
      checks[CHECK_CANCELLATION] = notApplicable('applies to tool routes only.');
    }

    routeReports[descriptor.id] = { checks };
  }

  return finalizeContractMatrixReport(failures, boundary, provenance, routeReports);
};

/**
 * Runs the contract matrix against one compiled MCP server at the
 * `mcp-in-memory` proof level. Returns a per-route report; throws one
 * aggregated `AgentTestError` with code `contract-violation` when any check
 * failed (never first-failure-only).
 */
export const runContractMatrix = async (
  options: ContractMatrixOptions,
): Promise<ContractMatrixReport> => {
  const manifest = options.manifest ?? testManifest();
  const serverName = resolveServerName(manifest, options.server);
  await using session = await openInMemoryMcpServer(options);
  return await executeContractMatrix({
    boundary: IN_MEMORY_BOUNDARY,
    client: session.client,
    fixtures: options.fixtures,
    manifest,
    provenance: session.provenance,
    serverName,
  });
};

/**
 * Runs the contract matrix against an already-open packed stdio session.
 * Never opens or closes the session; stamps the session's own proof level.
 */
export const runPackedContractMatrix = async (
  options: PackedContractMatrixOptions,
): Promise<ContractMatrixReport> => {
  const serverName = resolveServerName(options.manifest, options.server);
  return executeContractMatrix({
    boundary: packedBoundaryFromSession(options.session),
    client: options.session.client,
    fixtures: options.fixtures,
    manifest: options.manifest,
    provenance: options.session.provenance,
    serverName,
  });
};
