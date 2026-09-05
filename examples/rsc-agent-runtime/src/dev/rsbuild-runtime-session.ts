import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createRsbuild, type StartDevServerResult } from '@rsbuild/core';

import {
  createRscRuntimeRsbuildConfig,
  RscRuntimeCompileError,
  type RscRuntimeCompileEnvironmentHashes,
  type RscRuntimeCompileFailureKind,
  type RscRuntimeCompileSnapshot,
} from '../../rsbuild.config.js';
import { projectName, projectVersion } from '../project-identity.js';
import { describeRspackCompileErrors } from './compile-diagnostics.js';
import {
  createRscEnvironmentCheckpointStore,
  type RscEnvironmentCheckpointStore,
  type RscRuntimeEnvironmentName,
} from './environment-checkpoint-store.js';
import { canonicalJson, digestValue } from './canonical-json.js';
import {
  captureRuntimeGenerationSnapshot,
  materializeRuntimeGeneration,
  rscRuntimeGenerationMetadataCodec,
  runtimeDefinitionDigest,
  validateRscRuntimeGenerationMetadata,
  validateStagedRscEnvironmentCheckpoint,
  type RscRuntimeCapturedGenerationSnapshot,
} from './generation-materializer.js';
import type {
  RscRuntimeGenerationMetadata,
  RuntimeSnapshot,
  SerializedRuntimeDefinition,
} from '../runtime/contracts.js';
import { createFileRuntimeKernel } from '../runtime/state-file.js';
import { normalizeClaudeHook, normalizeCodexHook } from '../hook/normalize.js';
import {
  hasInspectionCredential,
  isInspectionSensitiveKey,
  redactInspectionDiagnostics,
} from './inspection-security.js';
import type { JsonObject, JsonValue } from 'agent-bundle';
import {
  DevRuntimeGenerationConflictError,
  DevRuntimeUnavailableError,
  createRuntimeGenerationStore,
  createRuntimeMcpRegistry,
  type DevRuntimeAsset,
  type DevRuntimeAssetRequest,
  type DevRuntimeClientSurfaceEndpoint,
  type DevRuntimeDescriptor,
  type DevRuntimeDiagnostic,
  type DevRuntimeEventInput,
  type DevRuntimeFixture,
  type DevRuntimeGenerationStore,
  type DevRuntimeInspectionEnvelope,
  type DevRuntimeInvocationRequest,
  type DevRuntimeMcpConnectionState,
  type DevRuntimeMcpRegistryReconcileInput,
  type DevRuntimeMcpSession,
  type DevRuntimeMcpSessionBinding,
  type DevRuntimeMcpSessionCloseObservation,
  type DevRuntimePreparedProject,
  type DevRuntimeProviderMcpRegistry,
  type DevRuntimeReplayRequest,
  type DevRuntimeRun,
  type DevRuntimeSession,
  type DevRuntimeStartContext,
  type DevRuntimeStateIdentity,
  type DevRuntimeStateResetRequest,
  type DevRuntimeStatus,
  type DevRuntimeSurface,
  type RuntimeGeneration,
  type RuntimeGenerationActivationGuard,
  type RuntimeGenerationCandidate,
  type RuntimeGenerationPreparedActivation,
  type RuntimeMcpConnection,
  type RuntimeMcpConnector,
  type RuntimeMcpExecutionContext,
  type RuntimeMcpPreparedActivationReconcile,
  type RuntimeVector,
} from 'agent-bundle/api';

const descriptor: DevRuntimeDescriptor = Object.freeze({
  environmentVariables: Object.freeze([]),
  id: 'rsc-agent-runtime',
  label: 'RSC agent runtime',
  schemaVersion: 1,
});
const clientSurfaceId = 'mcp.edit-timeline';
const clientSurfaceEntry = '/edit-timeline-v1.html';
const maximumAssetBytes = 8 * 1024 * 1024;
const stateStoreId = 'playground';
const maximumInvocationWorkers = 4;
const maximumInvocationStdoutBytes = 4 * 1024 * 1024;
const maximumInvocationFlightBytes = 4 * 1024 * 1024;
const maximumInvocationStderrBytes = 256 * 1024;
/** Production terminal-run retention window; tests may shrink it through the start testing seam. */
export const defaultMaximumRunHistory = 50;
const invocationTimeoutMs = 10_000;
const invocationTerminationGraceMs = 100;
const flightPreviewBytes = 32 * 1024;
const windowsJobOwnerPhaseDeadlineMs = 2_000;
const noFixtures: readonly DevRuntimeFixture[] = Object.freeze([]);
const claudePostToolUseFixture: DevRuntimeFixture = Object.freeze({
  id: 'claude-post-tool-use-write',
  label: 'Claude PostToolUse Write',
  seed: Object.freeze({
    cwd: '/tmp',
    hook_event_name: 'PostToolUse',
    session_id: 'fixture-claude-post-tool-use',
    tool_input: Object.freeze({ file_path: 'fixture-claude-post-tool-use.txt' }),
    tool_name: 'Write',
    tool_use_id: 'fixture-claude-post-tool-use-write',
  }),
});
const claudeFixtures: readonly DevRuntimeFixture[] = Object.freeze([claudePostToolUseFixture]);
const fixturesForHook = (host: 'claude' | 'codex'): readonly DevRuntimeFixture[] => host === 'claude' ? claudeFixtures : noFixtures;

/**
 * Activation budgets mirror the repository's test time-scale rule: CI runners
 * share two cores between Chrome, dev servers, and compiles, so fixed budgets
 * tuned on many-core machines starve there. Scaling costs nothing on green
 * runs - the activation resolves long before the deadline - while a wedged
 * materialization or MCP reconcile becomes a loud `runtime.generation.failed`
 * (with the phase in its diagnostic) instead of a silent permanent hang that
 * also blocks `close()` behind the provider tail (#38).
 */
const localTimeScale = Number(process.env['AGENT_BUNDLE_TEST_TIME_SCALE'] ?? '');
const runtimeTimeScale = process.env['CI'] !== undefined
  ? 4
  : Number.isSafeInteger(localTimeScale) && localTimeScale >= 1 ? localTimeScale : 1;
const defaultActivationPhaseBudgetMs = 30_000 * runtimeTimeScale;

type ActivationPhase = 'activation-guard' | 'generation-store' | 'mcp-registry' | 'prepared-runtime-reconcile';

const withinDeadline = <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });

// The wrapper is a normal Node child, so its inherited fd 3 remains a libuv
// Flight pipe. It imports the generation entry only after the Job owner
// assigns it to a kill-on-close Job Object and the provider writes GO to fd 4.
const windowsInvocationWrapperSource = String.raw`
const { createReadStream } = require('node:fs');
const { pathToFileURL } = require('node:url');
const entry = process.argv[1];
const control = createReadStream(null, { autoClose: false, fd: 4, encoding: 'utf8' });
let token = '';
const fail = (message) => { process.stderr.write(message + '\n'); process.exitCode = 1; };
control.on('data', (chunk) => {
  token += chunk;
  if (token === 'GO\n') {
    control.destroy();
    void import(pathToFileURL(entry).href).catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
  } else if (token.length > 3 || !'GO\n'.startsWith(token)) {
    fail('RSC invocation Windows wrapper received an invalid control token.');
    control.destroy();
  }
});
control.once('end', () => { if (token !== 'GO\n') fail('RSC invocation Windows wrapper never received a control token.'); });
control.once('error', () => fail('RSC invocation Windows wrapper control stream failed.'));
`;

// The owner is intentionally not a child of the Job Object. It owns the only
// job handle, confirms assignment before READY, and tears down/polls the
// whole tree before returning after the wrapper exits.
const windowsJobOwnerSource = String.raw`
$typeDefinition = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class AgentBundleWindowsJobOwner {
 const uint A=1,J=9,K=0x2000,I=0xffffffff,Access=0x00100101;
 [StructLayout(LayoutKind.Sequential)] struct BL { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct EL { public BL b; public IO i; public UIntPtr p,j,pp,pj; }
 [StructLayout(LayoutKind.Sequential)] struct BA { public long a,b,c,d; public uint e,f,g,h; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool b,int c);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr a,uint b,IntPtr c,uint d);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr a,uint b,IntPtr c,uint d,IntPtr e);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr a,IntPtr b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr a,uint b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr a,uint b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr a);
 static void Ok(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static void Stop(IntPtr job) { IntPtr accounting=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BA))); try { Ok(TerminateJobObject(job,0)); for(int attempt=0;attempt<1000;attempt++) { Ok(QueryInformationJobObject(job,A,accounting,(uint)Marshal.SizeOf(typeof(BA)),IntPtr.Zero)); if(((BA)Marshal.PtrToStructure(accounting,typeof(BA))).g==0) return; Thread.Sleep(10); } throw new TimeoutException("Windows Job Object did not terminate every descendant."); } finally { Marshal.FreeHGlobal(accounting); } }
 static void Drained() { Console.Out.WriteLine("DRAINED"); Console.Out.Flush(); }
 public static int Own(int pid,string mode) { IntPtr job=IntPtr.Zero,process=IntPtr.Zero,info=IntPtr.Zero; bool assigned=false,drained=false; try {
  if(mode=="hang-ready") { Thread.Sleep(60000); return 1; }
  job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
  EL limits=new EL(); limits.b.flags=K; info=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EL))); Marshal.StructureToPtr(limits,info,false); Ok(SetInformationJobObject(job,J,info,(uint)Marshal.SizeOf(typeof(EL))));
  process=OpenProcess(Access,false,pid); if(process==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); Ok(AssignProcessToJobObject(job,process)); assigned=true;
  Console.Out.WriteLine("READY"); Console.Out.Flush(); if(mode=="close-control") { Console.In.Close(); while(true) Thread.Sleep(1000); } if(mode=="ignore-stop") { while(true) Thread.Sleep(1000); } ManualResetEvent stop=new ManualResetEvent(false); Thread control=new Thread(() => { try { Console.In.ReadLine(); } finally { stop.Set(); } }); control.IsBackground=true; control.Start(); while(true) { uint result=WaitForSingleObject(process,20); if(result==0) break; if(result==I) throw new Win32Exception(Marshal.GetLastWin32Error()); if(stop.WaitOne(0)) break; } Stop(job); Drained(); drained=true; if(mode=="nonzero-after-drain") throw new InvalidOperationException("Windows Job owner test failure after drain."); return 0;
 } catch(Exception error) { if(job!=IntPtr.Zero && assigned && !drained) { try { Stop(job); Drained(); drained=true; } catch(Exception drainError) { throw new AggregateException(error,drainError); } } else if(job!=IntPtr.Zero && !assigned) TerminateJobObject(job,1); throw; } finally { if(info!=IntPtr.Zero) Marshal.FreeHGlobal(info); if(process!=IntPtr.Zero) CloseHandle(process); if(job!=IntPtr.Zero) CloseHandle(job); } }
}
'@
Add-Type -TypeDefinition $typeDefinition -ErrorAction Stop
exit [AgentBundleWindowsJobOwner]::Own([int]$args[0], [string]$args[1])
`;


interface InvocationWorker {
  readonly done: Promise<void>;
  terminate(reason: Error): void;
}

interface RuntimeAppBroker {
  closedObservation: DevRuntimeMcpSessionCloseObservation | undefined;
  opening: Promise<DevRuntimeMcpSession> | undefined;
  session: DevRuntimeMcpSession | undefined;
}

interface RuntimeAppLink {
  readonly descriptor: DevRuntimeMcpRegistryReconcileInput['servers'][number];
  readonly key: string;
  readonly resourceUri: string;
  readonly surfaceId: string;
}

interface WindowsJobOwner {
  readonly closed: Promise<void>;
  readonly done: Promise<void>;
  readonly drained: Promise<void>;
  readonly ready: Promise<void>;
  isAssigned(): boolean;
  isClosed(): boolean;
  forceTerminate(): void;
  terminate(): void;
}

interface OwnedRunsRoot {
  readonly dev: number;
  readonly ino: number;
  readonly marker: string;
  readonly root: string;
  readonly token: string;
}

interface RunArtifact {
  readonly file: FileHandle;
  readonly runId: string;
  dev?: number;
  digest?: string;
  ino?: number;
  size?: number;
}

type LiveSessionCleanupResource =
  | 'environment-checkpoints'
  | 'generation-store'
  | 'owned-runs-root'
  | 'rsbuild-dev-server'
  | 'run-artifact'
  | 'runtime-mcp-registry';

interface LabeledCleanupFailure {
  readonly error: unknown;
  readonly label: string;
}

interface ValidatedInvocation {
  readonly fixtureId?: string;
  readonly input: JsonValue;
  readonly request: DevRuntimeInvocationRequest;
  readonly surface: DevRuntimeSurface;
}

export class ResourceLedger {
  readonly #closers: Array<Readonly<{ readonly close: () => Promise<void>; readonly label: string }>> = [];
  readonly #failures: Array<Readonly<{ readonly error: unknown; readonly label: string }>> = [];
  readonly #running = new Set<Promise<void>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  add(close: () => Promise<void>, label = 'resource'): Promise<void> | undefined {
    const resourceLabel = /^[a-z0-9-]{1,64}$/u.test(label) ? label : 'resource';
    if (!this.#closed) {
      this.#closers.push(Object.freeze({ close, label: resourceLabel }));
      return undefined;
    }
    return this.#run(close, resourceLabel);
  }

  failures(): readonly Readonly<{ readonly error: unknown; readonly label: string }>[] {
    return Object.freeze([...this.#failures]);
  }

  #run(close: () => Promise<void>, label = 'resource'): Promise<void> {
    const task = Promise.resolve().then(close);
    this.#running.add(task);
    void task.then(
      () => undefined,
      (error: unknown) => { this.#failures.push(Object.freeze({ error, label })); },
    ).finally(() => { this.#running.delete(task); });
    return task;
  }

  async #drain(): Promise<void> {
    while (this.#closers.length > 0) {
      const closer = this.#closers.shift()!;
      this.#run(closer.close, closer.label);
    }
    while (this.#running.size > 0) {
      await Promise.allSettled([...this.#running]);
      while (this.#closers.length > 0) {
        const closer = this.#closers.shift()!;
        this.#run(closer.close, closer.label);
      }
    }
    if (this.#failures.length > 0) {
      throw new AggregateError(this.#failures.map((failure) => failure.error), 'RSC runtime startup cleanup failed.');
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#drain();
    return this.#closePromise;
  }
}

const cleanupAggregate = (
  message: string,
  failures: readonly LabeledCleanupFailure[],
  cause?: unknown,
): AggregateError => {
  const labels = [...new Set(failures.map((failure) => failure.label))].sort();
  return new AggregateError(
    failures.map((failure) => failure.error),
    `${message}; cleanup failures: ${labels.join(', ')}.`,
    cause === undefined ? undefined : { cause },
  );
};

const isInside = (root: string, path: string): boolean => {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
};

const safeSegment = (value: string): boolean =>
  value.length > 0 && value !== '.' && value !== '..' &&
  !value.includes('/') && !value.includes('\\') && !value.includes('\0') && !value.includes('%');

const cloneJson = (value: unknown, ancestors = new WeakSet<object>()): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime invocation input must contain only finite JSON numbers.');
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('Runtime invocation input must be an acyclic JSON value.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneJson(item, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Runtime invocation input must contain only plain JSON objects.');
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('Runtime invocation input cannot contain symbol keys.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Runtime invocation input cannot contain accessors or non-enumerable fields.');
      }
      result[key] = cloneJson(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const cloneJsonObject = (value: unknown): JsonObject => {
  const cloned = cloneJson(value);
  if (!isJsonObject(cloned)) {
    throw new TypeError('Runtime surface input schema must be a JSON object.');
  }
  return cloned;
};

const invocationDiagnostic = (error: unknown): DevRuntimeDiagnostic => Object.freeze({
  code: 'AB8203',
  message: error instanceof Error ? redactInspectionDiagnostics(error.message) : 'RSC runtime invocation failed.',
  phase: 'rsc-render',
  severity: 'error',
});

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Runtime prepared configuration cannot contain cycles.');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property !== undefined && 'value' in property) deepFreeze(property.value, seen);
  }
  seen.delete(value);
  return Object.freeze(value);
};

const plainRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (value: Record<string, unknown>, keys: readonly string[], message: string): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(message);
};

const assertCredentialSafeJson = (value: unknown): void => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (hasInspectionCredential(value)) throw new Error('RSC invocation worker inspection contains credentials.');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertCredentialSafeJson);
    return;
  }
  const record = plainRecord(value, 'RSC invocation worker inspection contains a non-JSON value.');
  for (const [key, item] of Object.entries(record)) {
    if (isInspectionSensitiveKey(key)) throw new Error('RSC invocation worker inspection contains sensitive fields.');
    assertCredentialSafeJson(item);
  }
};

const optionalExactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[], message: string): void => {
  const keys = Object.keys(value);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key)) || required.some((key) => !(key in value))) {
    throw new Error(message);
  }
};

const validateTrace = (value: unknown): void => {
  if (!Array.isArray(value)) throw new Error('RSC invocation worker trace is invalid.');
  for (const item of value) {
    const span = plainRecord(item, 'RSC invocation worker trace is invalid.');
    optionalExactKeys(span, ['id', 'phase', 'startedAt', 'status'], ['details', 'durationMs', 'parentId'], 'RSC invocation worker trace is invalid.');
    if (typeof span.id !== 'string' || span.id.length === 0 || typeof span.phase !== 'string' || span.phase.length === 0 ||
      typeof span.startedAt !== 'string' || !['running', 'succeeded', 'failed'].includes(span.status as string) ||
      ('parentId' in span && (typeof span.parentId !== 'string' || span.parentId.length === 0)) ||
      ('durationMs' in span && (typeof span.durationMs !== 'number' || !Number.isFinite(span.durationMs) || span.durationMs < 0))) {
      throw new Error('RSC invocation worker trace is invalid.');
    }
    if ('details' in span) {
      assertCredentialSafeJson(plainRecord(span.details, 'RSC invocation worker trace is invalid.'));
    }
  }
};

const validateTree = (value: unknown): void => {
  if (!Array.isArray(value)) throw new Error('RSC invocation worker tree is invalid.');
  for (const item of value) {
    const node = plainRecord(item, 'RSC invocation worker tree is invalid.');
    optionalExactKeys(node, ['children', 'id', 'kind', 'label'], ['props'], 'RSC invocation worker tree is invalid.');
    if (typeof node.id !== 'string' || node.id.length === 0 || typeof node.label !== 'string' ||
      !['component', 'element', 'text', 'value'].includes(node.kind as string)) {
      throw new Error('RSC invocation worker tree is invalid.');
    }
    if ('props' in node) {
      assertCredentialSafeJson(plainRecord(node.props, 'RSC invocation worker tree is invalid.'));
    }
    validateTree(node.children);
  }
};

const validateAppBinding = (value: unknown): void => {
  const app = plainRecord(value, 'RSC invocation worker App binding is invalid.');
  assertExactKeys(app, ['mcpBinding', 'resourceUri', 'surfaceId'], 'RSC invocation worker App binding is invalid.');
  if (typeof app.resourceUri !== 'string' || app.resourceUri.length === 0 || typeof app.surfaceId !== 'string' || app.surfaceId.length === 0) {
    throw new Error('RSC invocation worker App binding is invalid.');
  }
  const binding = plainRecord(app.mcpBinding, 'RSC invocation worker App binding is invalid.');
  assertExactKeys(binding, ['definitionDigest', 'registryRevision', 'serverDigest', 'serverName', 'sessionId', 'sessionRevision', 'target', 'transportDigest'], 'RSC invocation worker App binding is invalid.');
  if (typeof binding.definitionDigest !== 'string' || typeof binding.serverDigest !== 'string' || typeof binding.serverName !== 'string' ||
    typeof binding.sessionId !== 'string' || typeof binding.target !== 'string' || typeof binding.transportDigest !== 'string' ||
    !Number.isSafeInteger(binding.registryRevision) || !Number.isSafeInteger(binding.sessionRevision)) {
    throw new Error('RSC invocation worker App binding is invalid.');
  }
};

const clonePrepared = (prepared: DevRuntimePreparedProject): DevRuntimePreparedProject =>
  deepFreeze(structuredClone(prepared));

const transportDigest = (prepared: DevRuntimePreparedProject): string => digestValue({
  provider: prepared.provider,
  servers: prepared.servers.map((server) => ({
    args: server.args === undefined ? undefined : [...server.args],
    command: server.command,
    cwd: server.cwd,
    env: server.env === undefined ? undefined : Object.fromEntries(Object.entries(server.env)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, digestValue(value)])),
    headers: server.headers === undefined ? undefined : Object.fromEntries(Object.entries(server.headers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, digestValue(value)])),
    id: server.id,
    name: server.name,
    source: server.source,
    targets: [...server.targets],
    transport: server.transport,
    url: server.url,
  })),
});

const preparedRuntimeAuthorityDigest = (prepared: DevRuntimePreparedProject): string => digestValue({
  apps: prepared.apps,
  provider: prepared.provider,
  servers: prepared.servers,
});

const asJsonObject = (value: unknown): JsonObject => value as JsonObject;

const descriptorsFor = (
  prepared: DevRuntimePreparedProject,
  metadata: RscRuntimeGenerationMetadata,
  definitionDigest: string,
  nextTransportDigest: string,
) => {
  const template = metadata.servers[0];
  if (template === undefined) throw new Error('The active runtime generation has no MCP server descriptor.');
  return Object.freeze(prepared.servers.flatMap((server) => server.targets.map((target) => Object.freeze({
    definitionDigest,
    name: server.name,
    resources: Object.freeze(template.resources.map(asJsonObject)),
    serverDigest: metadata.serverDigest,
    target,
    tools: Object.freeze(template.tools.map(asJsonObject)),
    transportDigest: nextTransportDigest,
  }))));
};

const lifecycleDiagnostic = (error: unknown): DevRuntimeDiagnostic => Object.freeze({
  code: 'AB8200',
  message: error instanceof Error ? error.message : 'RSC runtime provider failed.',
  phase: 'provider-lifecycle',
  severity: 'error',
});

/**
 * The compile observer's `RscRuntimeCompileError` carries the rejected
 * cohort's stats; they render here as `file:line:col: message` lines (see
 * `src/dev/compile-diagnostics.ts`). The protocol diagnostic has no location
 * field, so the lines ride in the message.
 */
const sourceBuildDiagnostic = (error: unknown, projectRoot: string): DevRuntimeDiagnostic => Object.freeze({
  code: 'AB8206',
  message: `RSC runtime source build failed: ${
    error instanceof RscRuntimeCompileError
      ? describeRspackCompileErrors(error.stats, projectRoot)
      : error instanceof Error ? error.message : 'RSC runtime compile reported errors.'
  }`,
  phase: 'source/build',
  severity: 'error',
});

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new Error('RSC runtime provider startup was aborted.');

export interface RsbuildRuntimeSessionStartTesting {
  readonly createRsbuild?: typeof createRsbuild;
  /** Test-only startup resource seams; never used by the public provider. */
  readonly afterOwnedRunsRootCreated?: () => Promise<void> | void;
  readonly beforeOwnedRunsRootCleanup?: () => Promise<void> | void;
  readonly onStartupCleanupClosed?: () => void;
  readonly beforeGenerationCapture?: () => Promise<void> | void;
  readonly afterActivationPrepare?: (input: Readonly<{
    readonly phase: 'store' | 'registry';
    readonly session: RsbuildRuntimeSession;
  }>) => Promise<void> | void;
  /**
   * Test-only barrier between the final activation-guard wait and the commit
   * check, so supersession races (a newer attempt registering or failing
   * while an activation is in flight) can be injected deterministically.
   */
  readonly beforeActivationCommit?: () => Promise<void> | void;
  readonly beforeAssetRead?: (input: Readonly<{
    readonly request: DevRuntimeAssetRequest;
    readonly runtimeGenerationId: string;
  }>) => Promise<void> | void;
  readonly beforeMcpRelist?: () => Promise<void> | void;
  readonly afterInvocationWorkerResponse?: (input: Readonly<{
    readonly runId: string;
    readonly surfaceId: string;
  }>) => Promise<void> | void;
  /** Test-only live-session cleanup seams; never used by the public provider. */
  readonly beforeRunArtifactRelease?: (input: Readonly<{ readonly runId: string }>) => Promise<void> | void;
  readonly afterRunArtifactEvictionReserved?: (input: Readonly<{ readonly runId: string }>) => Promise<void> | void;
  readonly beforeRunDirectoryRemoval?: (input: Readonly<{ readonly runId: string }>) => Promise<void> | void;
  readonly beforeRunFlightRead?: (input: Readonly<{ readonly runId: string }>) => Promise<void> | void;
  readonly afterLiveSessionCleanupResource?: (input: Readonly<{
    readonly resource: LiveSessionCleanupResource;
  }>) => Promise<void> | void;
  /** Windows-only Job owner fault injection; never used by the public provider. */
  readonly windowsJobOwnerMode?: 'close-control' | 'hang-ready' | 'ignore-stop' | 'nonzero-after-drain' | 'normal';
  /**
   * Test-only terminal-run retention override so eviction suites do not need
   * fifty real invocations; the public provider always keeps
   * `defaultMaximumRunHistory` runs.
   */
  readonly maximumRunHistory?: number;
  /**
   * Test-only activation phase budget override so bounded-wedge suites do not
   * need to wait out the scaled production budget; the public provider always
   * uses `defaultActivationPhaseBudgetMs`.
   */
  readonly activationPhaseBudgetMs?: number;
}

/**
 * One provider-owned compiler, generation store, and runtime MCP registry.
 * The private compiler URL is exposed only through `clientSurface`.
 */
export class RsbuildRuntimeSession implements DevRuntimeSession {
  readonly #checkpointStore: RscEnvironmentCheckpointStore;
  readonly #candidatesByAttempt = new Map<string, RuntimeGenerationCandidate>();
  readonly #captureTasks = new Set<Promise<void>>();
  readonly #context: DevRuntimeStartContext;
  readonly #generationStore: DevRuntimeGenerationStore<RscRuntimeGenerationMetadata>;
  readonly #mcpRegistry: DevRuntimeProviderMcpRegistry;
  readonly #preparedRevisions = new Set<string>();
  readonly #invocations = new Set<Promise<DevRuntimeRun>>();
  readonly #invocationAbort = new AbortController();
  readonly #runReadTasks = new Map<string, Set<Promise<unknown>>>();
  readonly #runArtifacts = new Map<string, RunArtifact>();
  readonly #evictingTerminalRuns = new Set<string>();
  readonly #pendingRunDirectoryRemovals = new Set<string>();
  readonly #runRoot: string;
  readonly #ownedRunsRoot: OwnedRunsRoot;
  readonly #stateFile: string;
  readonly #stateKernel: ReturnType<typeof createFileRuntimeKernel>;
  readonly #activeRuns = new Map<string, DevRuntimeRun>();
  readonly #appBrokers = new Map<string, RuntimeAppBroker>();
  readonly #terminalRuns = new Map<string, DevRuntimeRun>();
  readonly #surfaceAssetApps = new Map<string, DevRuntimePreparedProject['apps'][number]>();
  readonly #surfaces = new Map<string, DevRuntimeSurface>();
  readonly #testing: RsbuildRuntimeSessionStartTesting;
  readonly #maximumRunHistory: number;
  readonly #pendingCohortIds = new Set<string>();
  readonly #workers = new Map<string, InvocationWorker>();
  readonly #failedAttempts = new Set<string>();
  #active: RuntimeGeneration<RscRuntimeGenerationMetadata> | undefined;
  /**
   * Wrapper objects, not raw listeners, so one relay subscribing the same
   * function twice still owns two independently detachable subscriptions.
   */
  readonly #appReloadSubscriptions = new Set<Readonly<{ readonly listener: () => void }>>();
  #clientSurface: DevRuntimeClientSurfaceEndpoint | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #completedCohortSequence = 0;
  /**
   * Advisory count of `onBeforeDevCompile` observations that no settled
   * completion has absorbed yet. It is a collapse hint for the activation
   * guard, never an identity or a barrier: every settled completion resets it
   * to zero (Rsbuild coalesces invalidations into the next completion), so a
   * dangling observation can only delay activation by the bounded grace in
   * `#activationGuard.wait()` and self-heals at the next settled completion.
   */
  #observedCompileStarts = 0;
  #compileSettleWaiters: Array<() => void> = [];
  #evictionTail: Promise<void> = Promise.resolve();
  #generationSequence = 0;
  #failureTail: Promise<void> = Promise.resolve();
  #hmrReady = false;
  #latestPreparedRuntime: DevRuntimePreparedProject;
  #latestRscCohortRevision = 0;
  #invocationReservations = 0;
  readonly #activationPhaseBudgetMs: number;
  #providerTail: Promise<void> = Promise.resolve();
  #server: StartDevServerResult['server'] | undefined;
  #status: DevRuntimeStatus;

  private constructor(input: Readonly<{
    readonly checkpointStore: RscEnvironmentCheckpointStore;
    readonly context: DevRuntimeStartContext;
    readonly generationStore: DevRuntimeGenerationStore<RscRuntimeGenerationMetadata>;
    readonly mcpRegistry: DevRuntimeProviderMcpRegistry;
    readonly ownedRunsRoot: OwnedRunsRoot;
    readonly preparedRuntime: DevRuntimePreparedProject;
    readonly testing: RsbuildRuntimeSessionStartTesting;
  }>) {
    this.#context = input.context;
    this.#checkpointStore = input.checkpointStore;
    this.#generationStore = input.generationStore;
    this.#mcpRegistry = input.mcpRegistry;
    this.#latestPreparedRuntime = input.preparedRuntime;
    this.#testing = input.testing;
    this.#maximumRunHistory = input.testing.maximumRunHistory ?? defaultMaximumRunHistory;
    this.#activationPhaseBudgetMs = input.testing.activationPhaseBudgetMs ?? defaultActivationPhaseBudgetMs;
    this.#ownedRunsRoot = input.ownedRunsRoot;
    this.#runRoot = input.ownedRunsRoot.root;
    this.#stateFile = join(resolve(input.context.storageRoot), 'state', `${stateStoreId}.sqlite`);
    this.#stateKernel = createFileRuntimeKernel({ stateFile: this.#stateFile });
    this.#preparedRevisions.add(input.preparedRuntime.sourceRevision);
    this.#status = Object.freeze({
      descriptor,
      diagnostics: Object.freeze([]),
      hmrReady: false,
      state: 'starting',
    });
  }

  static async start(
    context: DevRuntimeStartContext,
    testing: RsbuildRuntimeSessionStartTesting = {},
  ): Promise<RsbuildRuntimeSession> {
    context.signal.throwIfAborted();
    const preparedRuntime = clonePrepared(context.preparedRuntime);
    RsbuildRuntimeSession.#validateStartContext(context, preparedRuntime);
    const ledger = new ResourceLedger();
    let startupCleanup: Promise<void> | undefined;
    const closeStartupLedger = (): Promise<void> => {
      if (startupCleanup !== undefined) return startupCleanup;
      startupCleanup = ledger.close();
      const notifyClosed = (): void => {
        try {
          testing.onStartupCleanupClosed?.();
        } catch {
          // Test observation cannot affect startup cleanup ownership.
        }
      };
      void startupCleanup.then(notifyClosed, notifyClosed);
      return startupCleanup;
    };
    let aborting = false;
    const abort = (): void => {
      aborting = true;
      void closeStartupLedger().catch(() => undefined);
    };
    context.signal.addEventListener('abort', abort, { once: true });

    try {
      context.signal.throwIfAborted();
      const storageRoot = resolve(context.storageRoot);
      const generationStore = createRuntimeGenerationStore<RscRuntimeGenerationMetadata>({
        metadataCodec: rscRuntimeGenerationMetadataCodec,
        retainInactive: 5,
        storageRoot: join(storageRoot, 'generation-store'),
        validateMetadata: validateRscRuntimeGenerationMetadata,
      });
      ledger.add(() => generationStore.close(), 'generation-store');
      // Staged checkpoints are only meaningful within one session's validated
      // staging chain, so a reused storage root must not leak a crashed
      // session's stale staging directories into this one.
      const checkpointsRoot = join(storageRoot, 'environment-checkpoints');
      await rm(checkpointsRoot, { force: true, recursive: true });
      const checkpointStore = createRscEnvironmentCheckpointStore({
        root: checkpointsRoot,
        validators: { rsc: validateStagedRscEnvironmentCheckpoint },
      });
      ledger.add(() => checkpointStore.close(), 'environment-checkpoints');
      await Promise.all([
        mkdir(join(storageRoot, 'compiler'), { recursive: true }),
        mkdir(join(storageRoot, 'state'), { recursive: true }),
      ]);
      const ownedRunsRoot = await RsbuildRuntimeSession.#createOwnedRunsRoot(storageRoot, context.providerSessionId);
      const closeOwnedRunsRoot = async (): Promise<void> => {
        await testing.beforeOwnedRunsRootCleanup?.();
        await RsbuildRuntimeSession.#removeOwnedRunsRoot(ownedRunsRoot);
      };
      const afterOwnedRunsRootCreated = testing.afterOwnedRunsRootCreated;
      if (afterOwnedRunsRootCreated === undefined) {
        await ledger.add(closeOwnedRunsRoot, 'owned-runs-root');
      } else {
        try {
          await afterOwnedRunsRootCreated();
        } finally {
          await ledger.add(closeOwnedRunsRoot, 'owned-runs-root');
        }
      }
      context.signal.throwIfAborted();

      const connectionState: DevRuntimeMcpConnectionState = Object.freeze({
        capabilities: Object.freeze({
          resources: Object.freeze({}),
          tools: Object.freeze({}),
        }),
        protocolEra: 'modern',
        protocolVersion: '2025-06-18',
        server: Object.freeze({ name: projectName, version: projectVersion }),
      });
      const sessionReference: { current: RsbuildRuntimeSession | undefined } = { current: undefined };
      const connector: RuntimeMcpConnector = Object.freeze({
        connect: async ({ signal }: Parameters<RuntimeMcpConnector['connect']>[0]) => {
          signal.throwIfAborted();
          const connection: RuntimeMcpConnection = Object.freeze({
            close: async () => undefined,
            relist: async () => {
              signal.throwIfAborted();
              await testing.beforeMcpRelist?.();
              signal.throwIfAborted();
              return connectionState;
            },
            state: connectionState,
          });
          return connection;
        },
      });
      const mcpRegistry = createRuntimeMcpRegistry({
        artifactEpochId: () => undefined,
        connector,
        emit: (event) => {
          const session = sessionReference.current;
          if (session !== undefined) session.#emit(event);
        },
        executor: async (execution) => {
          const session = sessionReference.current;
          if (session === undefined) throw new Error('RSC runtime session is unavailable.');
          return session.#executeMcp(execution);
        },
        generationStore: generationStore as DevRuntimeGenerationStore,
        providerSessionId: context.providerSessionId,
        stateStoreId,
      });
      ledger.add(() => mcpRegistry.close(), 'runtime-mcp-registry');
      const session = new RsbuildRuntimeSession({
        checkpointStore,
        context,
        generationStore,
        mcpRegistry,
        ownedRunsRoot,
        preparedRuntime,
        testing,
      });
      sessionReference.current = session;
      context.signal.throwIfAborted();

      const rsbuild = await (testing.createRsbuild ?? createRsbuild)({
        callerName: 'agent-bundle-rsc-runtime',
        config: createRscRuntimeRsbuildConfig({
          compilerRoot: join(storageRoot, 'compiler'),
          mode: 'development',
          onAppReload: () => { session.#emitAppReload(); },
          onCompile: session.#compileObserver(),
        }),
        cwd: context.projectRoot,
      });
      context.signal.throwIfAborted();
      const started = await rsbuild.startDevServer({ getPortSilently: true });
      await ledger.add(() => started.server.close(), 'rsbuild-dev-server');
      context.signal.throwIfAborted();
      session.#attachServer(started, rsbuild.context.devServer);
      // startDevServer does not guarantee that the initial compile or async
      // onAfterDevCompile work has finished. In 2.2.1 that work often starts
      // before this return, but providerTail is not a documented readiness
      // barrier; callers intentionally receive a compiling session.
      context.signal.throwIfAborted();
      context.signal.removeEventListener('abort', abort);
      return session;
    } catch (error) {
      context.signal.removeEventListener('abort', abort);
      await closeStartupLedger().catch(() => undefined);
      const primary = aborting || context.signal.aborted ? abortReason(context.signal) : error;
      const failures = ledger.failures();
      if (failures.length === 0) throw primary;
      const labels = [...new Set(failures.map((failure) => failure.label))].sort();
      throw new AggregateError(
        [primary, ...failures.map((failure) => failure.error)],
        `RSC runtime startup failed; cleanup failures: ${labels.join(', ')}.`,
        { cause: error },
      );
    }
  }

  get mcpRegistry(): DevRuntimeProviderMcpRegistry {
    return this.#mcpRegistry;
  }

  get providerSessionId(): string {
    return this.#context.providerSessionId;
  }

  clientSurface(surfaceId: string): DevRuntimeClientSurfaceEndpoint | undefined {
    return !this.#closed && surfaceId === clientSurfaceId ? this.#clientSurface : undefined;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  invoke(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun> {
    if (this.#closed) return Promise.reject(new DevRuntimeUnavailableError('RSC runtime session is closed.'));
    const task = this.#invoke(request);
    this.#invocations.add(task);
    void task.finally(() => { this.#invocations.delete(task); }).catch(() => undefined);
    return task;
  }

  async readAsset(request: DevRuntimeAssetRequest): Promise<DevRuntimeAsset | undefined> {
    if (this.#closed || !this.#surfaces.has(request.surfaceId) || request.runtimeGenerationId.length === 0) return undefined;
    const segments = request.path.map((segment) => {
      if (!safeSegment(segment)) return undefined;
      try {
        return decodeURIComponent(segment) === segment ? segment : undefined;
      } catch {
        return undefined;
      }
    });
    if (segments.some((segment) => segment === undefined)) return undefined;
    const requestPath = `/${segments.join('/')}`;
    let lease;
    try {
      lease = await this.#generationStore.lease(request.runtimeGenerationId);
      await this.#testing.beforeAssetRead?.(Object.freeze({
        request,
        runtimeGenerationId: lease.generation.id,
      }));
      const app = this.#surfaceAssetApps.get(request.surfaceId);
      if (app === undefined) return undefined;
      const boundSurfaceId = this.#surfaceAssetBinding(lease.generation, app);
      if (boundSurfaceId === undefined) return undefined;
      const descriptor = lease.generation.manifest.metadata.surfaceAssets[boundSurfaceId]
        ?.find((asset) => asset.requestPath === requestPath);
      if (descriptor === undefined || descriptor.bytes > maximumAssetBytes) return undefined;
      const assetSegments = descriptor.generationPath.split('/');
      if (assetSegments.some((segment) => !safeSegment(segment))) return undefined;
      const path = join(lease.generation.root, ...assetSegments);
      if (!isInside(lease.generation.root, path)) return undefined;
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink() || details.size !== descriptor.bytes) return undefined;
      const body = await readFile(path);
      if (body.byteLength !== descriptor.bytes || createHash('sha256').update(body).digest('hex') !== descriptor.sha256) return undefined;
      return Object.freeze({ body, contentType: descriptor.contentType });
    } catch {
      return undefined;
    } finally {
      await lease?.release();
    }
  }

  async readRunFlight(runId: string): Promise<DevRuntimeAsset | undefined> {
    if (this.#closed || !safeSegment(runId)) return undefined;
    if (this.#evictingTerminalRuns.has(runId)) return undefined;
    const run = this.#terminalRuns.get(runId);
    if (run?.status !== 'succeeded' || run.vector.providerSessionId !== this.providerSessionId) return undefined;
    const artifact = this.#runArtifacts.get(runId);
    if (artifact?.digest === undefined || artifact.size === undefined || artifact.dev === undefined || artifact.ino === undefined) return undefined;
    const task = (async (): Promise<DevRuntimeAsset | undefined> => {
      try {
        await this.#testing.beforeRunFlightRead?.(Object.freeze({ runId }));
        await this.#assertCurrentOwnedRunsRoot();
        const details = await artifact.file.stat();
        if (!details.isFile() || details.size !== artifact.size || details.dev !== artifact.dev || details.ino !== artifact.ino) return undefined;
        const body = Buffer.alloc(artifact.size);
        let offset = 0;
        while (offset < body.byteLength) {
          const read = await artifact.file.read(body, offset, body.byteLength - offset, offset);
          if (read.bytesRead === 0) return undefined;
          offset += read.bytesRead;
        }
        if (createHash('sha256').update(body).digest('hex') !== artifact.digest) return undefined;
        await this.#assertCurrentOwnedRunsRoot();
        return Object.freeze({ body, contentType: 'application/octet-stream' });
      } catch {
        return undefined;
      }
    })();
    const reads = this.#runReadTasks.get(runId) ?? new Set<Promise<unknown>>();
    this.#runReadTasks.set(runId, reads);
    reads.add(task);
    try {
      return await task;
    } finally {
      reads.delete(task);
      if (reads.size === 0) this.#runReadTasks.delete(runId);
    }
  }

  reconcilePreparedRuntime(prepared: DevRuntimePreparedProject): Promise<void> {
    const next = clonePrepared(prepared);
    this.#validatePreparedRuntime(next);
    if (this.#closed) return Promise.reject(new Error('RSC runtime session is closed.'));
    if (this.#preparedRevisions.has(next.sourceRevision)) {
      return Promise.reject(new Error('Runtime prepared configuration source revision is stale or unchanged.'));
    }
    this.#preparedRevisions.add(next.sourceRevision);
    this.#latestPreparedRuntime = next;
    return this.#append(async () => this.#reconcilePreparedRuntime(next));
  }

  async replay(request: DevRuntimeReplayRequest): Promise<DevRuntimeRun> {
    if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
    if (request === null || typeof request !== 'object' || !safeSegment(request.runId)) {
      throw new TypeError('Runtime replay requires a retained run id.');
    }
    if (request.mode !== 'exact' && request.mode !== 'latest') throw new TypeError('Runtime replay mode is invalid.');
    const historical = this.#terminalRuns.get(request.runId);
    if (historical === undefined) throw new Error(`Runtime run ${JSON.stringify(request.runId)} does not exist.`);
    const historicalGenerationId = historical.vector.runtimeGenerationId;
    const activeGenerationId = this.#active?.id;
    if (request.mode === 'exact' && request.expectedGenerationId !== undefined && request.expectedGenerationId !== historicalGenerationId) {
      throw new DevRuntimeGenerationConflictError(request.expectedGenerationId, historicalGenerationId);
    }
    if (request.mode === 'latest' && request.expectedGenerationId !== undefined && request.expectedGenerationId !== activeGenerationId) {
      throw new DevRuntimeGenerationConflictError(request.expectedGenerationId, activeGenerationId);
    }
    const expectedGenerationId = request.mode === 'exact' ? historicalGenerationId : activeGenerationId;
    if (expectedGenerationId === undefined) throw new DevRuntimeUnavailableError('RSC runtime has no active generation.');
    if (request.mode === 'exact') {
      let retained: Awaited<ReturnType<DevRuntimeGenerationStore<RscRuntimeGenerationMetadata>['lease']>> | undefined;
      try {
        try {
          retained = await this.#generationStore.lease(historicalGenerationId);
        } catch {
          throw new DevRuntimeGenerationConflictError(historicalGenerationId, this.#active?.id);
        }
        let surface: DevRuntimeSurface;
        try {
          surface = await this.#historicalSurface(retained.generation, historical.surfaceId);
        } catch {
          throw new DevRuntimeGenerationConflictError(historicalGenerationId, this.#active?.id);
        }
        const replay = this.#invoke({
          expectedGenerationId,
          ...(historical.fixtureId === undefined ? {} : { fixtureId: historical.fixtureId }),
          input: historical.input,
          surfaceId: historical.surfaceId,
          target: historical.target,
        }, retained, surface);
        retained = undefined;
        return await replay;
      } finally {
        await retained?.release();
      }
    }
    return this.invoke({
      expectedGenerationId,
      ...(historical.fixtureId === undefined ? {} : { fixtureId: historical.fixtureId }),
      input: historical.input,
      surfaceId: historical.surfaceId,
      target: historical.target,
    });
  }

  async resetState(request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity> {
    if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
    if (request.stateStoreId !== stateStoreId) throw new Error(`Unknown runtime state store ${JSON.stringify(request.stateStoreId)}.`);
    const generationId = request.expectedGenerationId ?? this.#active?.id;
    if (generationId === undefined) throw new DevRuntimeUnavailableError('RSC runtime has no active generation.');
    let lease;
    try {
      lease = await this.#generationStore.lease(generationId);
    } catch {
      throw new DevRuntimeGenerationConflictError(generationId, this.#active?.id);
    }
    try {
      if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
      const seed = request.seed === undefined ? undefined : cloneJson(request.seed);
      if (seed !== undefined) assertCredentialSafeJson(seed);
      const snapshot = await this.#stateKernel.resetState({
        idempotencyKey: `runtime:reset:${randomUUID()}`,
        ...(seed === undefined ? {} : { seed }),
      });
      return Object.freeze({ stateStoreId, stateVersion: snapshot.stateVersion });
    } finally {
      await lease.release();
    }
  }

  run(runId: string): DevRuntimeRun | undefined {
    return this.#closed ? undefined : this.#activeRuns.get(runId) ?? this.#terminalRuns.get(runId);
  }

  runs(limit: number): readonly DevRuntimeRun[] {
    if (this.#closed) return Object.freeze([]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maximumRunHistory) {
      throw new RangeError(`Runtime run history limit must be an integer from 1 through ${String(this.#maximumRunHistory)}.`);
    }
    return Object.freeze([...this.#terminalRuns.values()].reverse().slice(0, limit));
  }

  status(): DevRuntimeStatus {
    return this.#status;
  }

  surfaces(): readonly DevRuntimeSurface[] {
    return Object.freeze([...this.#surfaces.values()]);
  }

  async #invoke(
    request: DevRuntimeInvocationRequest,
    suppliedLease?: Awaited<ReturnType<DevRuntimeGenerationStore<RscRuntimeGenerationMetadata>['lease']>>,
    historicalSurface?: DevRuntimeSurface,
  ): Promise<DevRuntimeRun> {
    let lease = suppliedLease;
    let releaseReservation: (() => void) | undefined;
    try {
      const invocation = this.#validateInvocation(request, historicalSurface);
      const generationId = invocation.request.expectedGenerationId ?? lease?.generation.id ?? this.#active?.id;
      if (generationId === undefined) throw new DevRuntimeUnavailableError('RSC runtime has no active generation.');
      if (lease !== undefined && lease.generation.id !== generationId) {
        throw new DevRuntimeGenerationConflictError(generationId, lease.generation.id);
      }
      releaseReservation = this.#reserveInvocation();
      if (lease === undefined) {
        try {
          lease = await this.#generationStore.lease(generationId);
        } catch {
          throw new DevRuntimeGenerationConflictError(generationId, this.#active?.id);
        }
      }
      const generationLease = lease;
      if (generationLease === undefined) throw new Error('RSC runtime generation lease is unavailable.');

      let runDirectory: string | undefined;
      let running: DevRuntimeRun | undefined;
      let artifact: RunArtifact | undefined;
      try {
        this.#assertInvocationOpen();
        const stateBefore = await this.#stateKernel.readSnapshot();
        this.#assertInvocationOpen();
        const runId = randomUUID();
        const startedAt = new Date().toISOString();
        running = Object.freeze({
          ...(invocation.fixtureId === undefined ? {} : { fixtureId: invocation.fixtureId }),
          id: runId,
          input: invocation.input,
          startedAt,
          status: 'running' as const,
          surfaceId: invocation.surface.id,
          target: invocation.request.target,
          vector: this.#vector(generationLease.generation, stateBefore.stateVersion),
        });
        this.#activeRuns.set(runId, running);
        runDirectory = join(this.#runRoot, runId);
        if (!isInside(this.#runRoot, runDirectory) || !safeSegment(runId)) {
          throw new Error('RSC runtime run directory escaped its provider storage root.');
        }
        await this.#assertCurrentOwnedRunsRoot();
        await mkdir(runDirectory, { recursive: false });
        artifact = await this.#openRunArtifact(runId);
        this.#assertInvocationOpen();
        this.#emit(Object.freeze({ runId, runtimeGenerationId: generationLease.generation.id, type: 'runtime.run.started' }));
        const workerInput = await this.#workerRequest(invocation);
        this.#assertInvocationOpen();
        const response = await this.#runInvocationWorker({
          generation: generationLease.generation,
          input: workerInput,
          runId,
          surfaceId: invocation.surface.id,
        });
        this.#assertInvocationOpen();
        await this.#testing.afterInvocationWorkerResponse?.(Object.freeze({ runId, surfaceId: invocation.surface.id }));
        this.#assertInvocationOpen();
        const flight = response.flight;
        const inspectedStateVersion = response.inspection.state.identity.stateVersion;
        const stateAfter = await this.#stateKernel.readSnapshot({ stateVersion: inspectedStateVersion });
        if (stateAfter.stateVersion !== inspectedStateVersion) throw new Error('RSC invocation inspection state version is not durable.');
        this.#assertInvocationOpen();
        const app = await this.#runtimeAppResult(generationLease.generation, invocation);
        this.#assertInvocationOpen();
        const result = this.#inspectionResult(response.inspection, flight, stateAfter, runId, app);
        if (artifact === undefined) throw new Error('RSC runtime Flight artifact is unavailable.');
        await this.#writeRunFlight(artifact, flight);
        const completed = Object.freeze({
          ...(invocation.fixtureId === undefined ? {} : { fixtureId: invocation.fixtureId }),
          completedAt: new Date().toISOString(),
          id: runId,
          input: invocation.input,
          result,
          startedAt,
          status: 'succeeded' as const,
          surfaceId: invocation.surface.id,
          target: invocation.request.target,
          vector: this.#vector(generationLease.generation, inspectedStateVersion),
        });
        this.#activeRuns.delete(runId);
        await this.#recordTerminal(completed);
        this.#publishActiveStateVersion(generationLease.generation, inspectedStateVersion);
        this.#emit(Object.freeze({ runId, runtimeGenerationId: generationLease.generation.id, type: 'runtime.run.completed' }));
        return completed;
      } catch (error) {
        const cleanupFailures: LabeledCleanupFailure[] = [];
        if (artifact !== undefined) {
          try {
            await this.#releaseRunArtifact(artifact.runId);
          } catch (cleanupError) {
            cleanupFailures.push(Object.freeze({ error: cleanupError, label: 'run-artifact' }));
          }
        }
        if (cleanupFailures.length === 0 && runDirectory !== undefined) {
          try {
            await this.#removeRunDirectory(running?.id);
          } catch (cleanupError) {
            cleanupFailures.push(Object.freeze({ error: cleanupError, label: 'run-artifact' }));
          }
        }
        if (running === undefined) throw error;
        this.#activeRuns.delete(running.id);
        const stateAfter = await this.#readTerminalStateVersion(running.vector.stateVersion);
        const invocationError = cleanupFailures.length === 0
          ? error
          : cleanupAggregate('RSC runtime invocation cleanup failed', cleanupFailures, error);
        const failed = Object.freeze({
          ...(running.fixtureId === undefined ? {} : { fixtureId: running.fixtureId }),
          completedAt: new Date().toISOString(),
          diagnostics: Object.freeze([invocationDiagnostic(invocationError)]),
          id: running.id,
          input: running.input,
          startedAt: running.startedAt,
          status: 'failed' as const,
          surfaceId: running.surfaceId,
          target: running.target,
          vector: this.#vector(generationLease.generation, stateAfter),
        });
        await this.#recordTerminal(failed);
        this.#publishActiveStateVersion(generationLease.generation, stateAfter);
        this.#emit(Object.freeze({ runId: running.id, runtimeGenerationId: generationLease.generation.id, type: 'runtime.run.failed' }));
        return failed;
      }
    } finally {
      await lease?.release();
      releaseReservation?.();
    }
  }

  #assertInvocationOpen(): void {
    if (this.#closed || this.#invocationAbort.signal.aborted) {
      throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
    }
  }

  #reserveInvocation(): () => void {
    this.#assertInvocationOpen();
    if (this.#invocationReservations >= maximumInvocationWorkers) {
      throw new Error(`RSC runtime invocation limit of ${maximumInvocationWorkers} concurrent workers has been reached.`);
    }
    this.#invocationReservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#invocationReservations -= 1;
    };
  }

  #validateInvocation(request: DevRuntimeInvocationRequest, historicalSurface?: DevRuntimeSurface): ValidatedInvocation {
    if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
    if (request === null || typeof request !== 'object') throw new TypeError('Runtime invocation request must be an object.');
    if (typeof request.surfaceId !== 'string' || request.surfaceId.length === 0) {
      throw new TypeError('Runtime invocation requires a nonempty surfaceId.');
    }
    if (typeof request.target !== 'string' || request.target.length === 0) {
      throw new TypeError('Runtime invocation requires a nonempty target.');
    }
    if (request.expectedGenerationId !== undefined && (typeof request.expectedGenerationId !== 'string' || request.expectedGenerationId.length === 0)) {
      throw new TypeError('Runtime invocation expectedGenerationId must be nonempty when provided.');
    }
    const surface = historicalSurface ?? this.#surfaces.get(request.surfaceId);
    if (surface === undefined) throw new Error(`Runtime surface ${JSON.stringify(request.surfaceId)} does not exist.`);
    if (!surface.targets.includes(request.target)) {
      throw new Error(`Runtime surface ${JSON.stringify(request.surfaceId)} does not support target ${JSON.stringify(request.target)}.`);
    }
    if (!['hook.claude', 'hook.codex', 'mcp.render_edit_timeline', 'mcp.recent_edits', 'mcp.runtime_status'].includes(surface.id)) {
      throw new Error(`Runtime surface ${JSON.stringify(surface.id)} is not invocable.`);
    }
    if (request.fixtureId !== undefined) {
      if (typeof request.fixtureId !== 'string' || request.fixtureId.length === 0) {
        throw new TypeError('Runtime invocation fixtureId must be nonempty when provided.');
      }
      if (!surface.fixtures.some((fixture) => fixture.id === request.fixtureId)) {
        throw new Error(`Runtime surface ${JSON.stringify(surface.id)} has no fixture ${JSON.stringify(request.fixtureId)}.`);
      }
    }
    const input = cloneJson(request.input);
    if (surface.id === 'hook.claude' || surface.id === 'hook.codex') {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Native hook runtime invocation input must be an object.');
      }
      const hookInput = input as Record<string, unknown>;
      if (surface.id === 'hook.claude') normalizeClaudeHook(hookInput);
      else normalizeCodexHook(hookInput);
    } else if (
      surface.id === 'mcp.render_edit_timeline' ||
      surface.id === 'mcp.recent_edits' ||
      surface.id === 'mcp.runtime_status'
    ) {
      if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw new TypeError(`Runtime surface ${JSON.stringify(surface.id)} requires an empty object input.`);
      }
    }
    return Object.freeze({
      ...(request.fixtureId === undefined ? {} : { fixtureId: request.fixtureId }),
      input,
      request: Object.freeze({ ...request }),
      surface,
    });
  }

  async #workerRequest(invocation: ValidatedInvocation): Promise<JsonObject> {
    if (invocation.surface.id === 'hook.claude' || invocation.surface.id === 'hook.codex') {
      if (invocation.input === null || typeof invocation.input !== 'object' || Array.isArray(invocation.input)) {
        throw new TypeError('Native hook runtime invocation input must be an object.');
      }
      return Object.freeze({
        host: invocation.surface.id === 'hook.claude' ? 'claude' : 'codex',
        input: invocation.input,
        stateFile: this.#stateFile,
        stateStoreId,
        type: 'hook/after-file-edit',
      });
    }
    if (invocation.surface.id === 'mcp.render_edit_timeline' || invocation.surface.id === 'mcp.recent_edits') {
      return Object.freeze({
        snapshot: cloneJson(await this.#stateKernel.readSnapshot()),
        stateFile: this.#stateFile,
        stateStoreId,
        type: 'mcp/render-timeline',
      });
    }
    return Object.freeze({ stateFile: this.#stateFile, stateStoreId, type: 'mcp/runtime-status' });
  }

  async #historicalSurface(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    surfaceId: string,
  ): Promise<DevRuntimeSurface> {
    const definitionPath = join(generation.root, 'rsc', 'runtime-definition.json');
    const asset = generation.manifest.assets.find((candidate) => candidate.path === 'rsc/runtime-definition.json');
    if (asset === undefined || !isInside(generation.root, definitionPath)) throw new Error('Historical runtime generation has no definition asset.');
    const details = await lstat(definitionPath);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== asset.bytes) throw new Error('Historical runtime definition is unsafe.');
    const bytes = await readFile(definitionPath);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Historical runtime definition changed.');
    const definition = JSON.parse(bytes.toString('utf8')) as Partial<SerializedRuntimeDefinition>;
    const targets = Object.freeze([...new Set(generation.manifest.metadata.servers.map((server) => server.target))]);
    if (surfaceId.startsWith('hook.')) {
      const host = surfaceId.slice('hook.'.length);
      if ((host !== 'claude' && host !== 'codex') || !definition.nativeHooks?.some((hook) => hook.host === host)) {
        throw new Error(`Historical runtime surface ${JSON.stringify(surfaceId)} does not exist.`);
      }
      return Object.freeze({ fixtures: fixturesForHook(host), id: surfaceId, kind: 'hook', label: `After tool hook (${host})`, readOnly: false, targets: Object.freeze([host]) });
    }
    const name = surfaceId.startsWith('mcp.') ? surfaceId.slice('mcp.'.length) : '';
    if (definition.tools?.some((tool) => tool.name === name)) {
      return Object.freeze({ fixtures: Object.freeze([]), id: surfaceId, kind: 'mcp-tool', label: name, readOnly: true, targets });
    }
    if (definition.resources?.some((resource) => resource.name === name)) {
      return Object.freeze({ fixtures: Object.freeze([]), id: surfaceId, kind: 'mcp-resource', label: name, readOnly: true, targets });
    }
    const app = generation.manifest.metadata.appDefinitions.find((candidate) => candidate.name === name);
    if (app !== undefined) {
      return Object.freeze({ fixtures: Object.freeze([]), id: surfaceId, kind: 'mcp-app', label: name, readOnly: true, targets: app.targets });
    }
    throw new Error(`Historical runtime surface ${JSON.stringify(surfaceId)} does not exist.`);
  }

  async #readTerminalStateVersion(fallback: number): Promise<number> {
    try {
      return (await this.#stateKernel.readSnapshot()).stateVersion;
    } catch {
      return fallback;
    }
  }

  async #recordTerminal(run: DevRuntimeRun): Promise<void> {
    this.#terminalRuns.set(run.id, run);
    const eviction = this.#evictionTail.then(() => this.#evictTerminalRuns());
    this.#evictionTail = eviction.catch(() => undefined);
    await eviction;
  }

  async #evictTerminalRuns(): Promise<void> {
    while (this.#terminalRuns.size > this.#maximumRunHistory) {
      const oldestId = this.#terminalRuns.keys().next().value as string | undefined;
      if (oldestId === undefined) return;
      this.#evictingTerminalRuns.add(oldestId);
      try {
        await this.#testing.afterRunArtifactEvictionReserved?.(Object.freeze({ runId: oldestId }));
        const reads = this.#runReadTasks.get(oldestId);
        if (reads !== undefined) await Promise.allSettled([...reads]);
        await this.#releaseRunArtifact(oldestId);
        this.#terminalRuns.delete(oldestId);
        this.#pendingRunDirectoryRemovals.add(oldestId);
        await this.#removeRunDirectory(oldestId);
        this.#pendingRunDirectoryRemovals.delete(oldestId);
      } catch (error) {
        throw cleanupAggregate('RSC runtime run artifact cleanup failed', [Object.freeze({ error, label: 'run-artifact' })]);
      } finally {
        this.#evictingTerminalRuns.delete(oldestId);
      }
    }
  }

  async #removeRunDirectory(runId: string | undefined): Promise<void> {
    if (runId === undefined || !safeSegment(runId)) return;
    await this.#testing.beforeRunDirectoryRemoval?.(Object.freeze({ runId }));
    await this.#assertCurrentOwnedRunsRoot();
    const directory = join(this.#runRoot, runId);
    if (!isInside(this.#runRoot, directory)) throw new Error('RSC runtime run directory escaped its provider storage root.');
    const details = await lstat(directory).catch((error: unknown) => {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') return undefined;
      throw error;
    });
    if (details === undefined) return;
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('RSC runtime run directory is not a contained non-symbolic directory.');
    }
    await rm(directory, { force: true, recursive: true });
  }

  async #openRunArtifact(runId: string): Promise<RunArtifact> {
    await this.#assertCurrentOwnedRunsRoot();
    const directory = join(this.#runRoot, runId);
    if (!safeSegment(runId) || !isInside(this.#runRoot, directory)) throw new Error('RSC runtime run directory escaped its provider storage root.');
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('RSC runtime run directory is unsafe.');
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const openedDirectory = await directoryHandle.stat();
      if (!openedDirectory.isDirectory() || openedDirectory.dev !== details.dev || openedDirectory.ino !== details.ino) {
        throw new Error('RSC runtime run directory changed while opening its Flight artifact.');
      }
      const flightPath = process.platform === 'linux'
        ? `/proc/self/fd/${String(directoryHandle.fd)}/flight.bin`
        : join(directory, 'flight.bin');
      const file = await open(flightPath, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
      const artifact: RunArtifact = { file, runId };
      this.#runArtifacts.set(runId, artifact);
      return artifact;
    } finally {
      await directoryHandle.close();
    }
  }

  async #writeRunFlight(artifact: RunArtifact, flight: Buffer): Promise<void> {
    if (flight.byteLength > maximumInvocationFlightBytes) throw new Error(`RSC invocation Flight exceeded ${maximumInvocationFlightBytes} bytes.`);
    let offset = 0;
    while (offset < flight.byteLength) {
      const written = await artifact.file.write(flight, offset, flight.byteLength - offset, offset);
      if (written.bytesWritten === 0) throw new Error('RSC runtime Flight artifact could not be written.');
      offset += written.bytesWritten;
    }
    await artifact.file.sync();
    const details = await artifact.file.stat();
    if (!details.isFile() || details.size !== flight.byteLength || details.size > maximumInvocationFlightBytes) {
      throw new Error('RSC runtime Flight artifact has an invalid identity.');
    }
    artifact.dev = details.dev;
    artifact.digest = createHash('sha256').update(flight).digest('hex');
    artifact.ino = details.ino;
    artifact.size = details.size;
  }

  async #releaseRunArtifact(runId: string): Promise<void> {
    const artifact = this.#runArtifacts.get(runId);
    if (artifact === undefined) return;
    await this.#testing.beforeRunArtifactRelease?.(Object.freeze({ runId }));
    await artifact.file.close();
    this.#runArtifacts.delete(runId);
  }

  #inspectionResult(
    inspection: DevRuntimeInspectionEnvelope,
    flight: Buffer,
    snapshot: RuntimeSnapshot,
    runId: string,
    app: DevRuntimeInspectionEnvelope['app'],
  ): DevRuntimeInspectionEnvelope {
    const { app: _workerApp, ...workerInspection } = inspection;
    return Object.freeze({
      ...workerInspection,
      ...(app === undefined ? {} : { app }),
      flight: Object.freeze({
        bytes: flight.byteLength,
        downloadPath: `/api/runtime/runs/${encodeURIComponent(runId)}/flight`,
        preview: flight.subarray(0, flightPreviewBytes).toString('base64'),
        truncated: flight.byteLength > flightPreviewBytes,
      }),
      state: Object.freeze({
        ...inspection.state,
        identity: Object.freeze({ stateStoreId, stateVersion: snapshot.stateVersion }),
        snapshot: cloneJson(snapshot),
      }),
    });
  }

  #runtimeAppLink(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    invocation: ValidatedInvocation,
  ): RuntimeAppLink | undefined {
    if (invocation.surface.id !== 'mcp.render_edit_timeline') return undefined;
    const registry = this.#mcpRegistry.snapshot();
    const metadata = generation.manifest.metadata;
    if (
      this.#active?.id !== generation.id || registry?.runtimeGenerationId !== generation.id
    ) {
      throw new DevRuntimeGenerationConflictError(generation.id, this.#active?.id);
    }
    const toolName = invocation.surface.id.slice('mcp.'.length);
    const matches = registry.servers.flatMap((descriptor) => {
      if (
        descriptor.target !== invocation.request.target || descriptor.definitionDigest !== registry.definitionDigest ||
        descriptor.transportDigest !== registry.transportDigest || descriptor.serverDigest !== metadata.serverDigest
      ) return [];
      const tool = descriptor.tools.find((candidate) => candidate.name === toolName);
      const toolMeta = tool?._meta;
      const outputTemplate = toolMeta === null || typeof toolMeta !== 'object' || Array.isArray(toolMeta)
        ? undefined
        : Object.getOwnPropertyDescriptor(toolMeta, 'openai/outputTemplate')?.value;
      const resourceUri = typeof outputTemplate === 'string' ? outputTemplate : undefined;
      if (resourceUri === undefined) return [];
      return metadata.appDefinitions
        .filter((app) => app.serverName === descriptor.name && app.resourceUri === resourceUri && app.targets.includes(invocation.request.target) && metadata.surfaceAssets[`mcp.${app.name}`] !== undefined)
        .map((app) => Object.freeze({ app, descriptor, resourceUri }));
    });
    if (matches.length !== 1) throw new Error('Runtime App invocation has no unambiguous current-generation App definition.');
    const match = matches[0]!;
    return Object.freeze({
      descriptor: match.descriptor,
      key: `${match.descriptor.name}\u0000${invocation.request.target}`,
      resourceUri: match.resourceUri,
      surfaceId: clientSurfaceId,
    });
  }

  #assertRuntimeAppAuthority(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    link: RuntimeAppLink,
  ): NonNullable<ReturnType<DevRuntimeProviderMcpRegistry['snapshot']>> {
    this.#assertInvocationOpen();
    const registry = this.#mcpRegistry.snapshot();
    if (
      registry === undefined || this.#active?.id !== generation.id || registry.runtimeGenerationId !== generation.id ||
      link.descriptor.definitionDigest !== registry.definitionDigest || link.descriptor.transportDigest !== registry.transportDigest ||
      !registry.servers.some((descriptor) => descriptor.name === link.descriptor.name && descriptor.target === link.descriptor.target &&
        descriptor.definitionDigest === link.descriptor.definitionDigest && descriptor.serverDigest === link.descriptor.serverDigest &&
        descriptor.transportDigest === link.descriptor.transportDigest && descriptor.serverDigest === generation.manifest.metadata.serverDigest)
    ) {
      throw new DevRuntimeGenerationConflictError(generation.id, this.#active?.id);
    }
    return registry;
  }

  #matchesRuntimeAppBinding(
    binding: DevRuntimeMcpSessionBinding,
    link: RuntimeAppLink,
    registry: NonNullable<ReturnType<DevRuntimeProviderMcpRegistry['snapshot']>>,
  ): boolean {
    return binding.definitionDigest === registry.definitionDigest && binding.registryRevision === registry.registryRevision &&
      binding.serverDigest === link.descriptor.serverDigest && binding.serverName === link.descriptor.name &&
      binding.target === link.descriptor.target && binding.transportDigest === registry.transportDigest;
  }

  async #runtimeAppSession(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    link: RuntimeAppLink,
  ): Promise<DevRuntimeMcpSession> {
    const registry = this.#assertRuntimeAppAuthority(generation, link);
    const existing = this.#appBrokers.get(link.key);
    const broker = existing ?? { closedObservation: undefined, opening: undefined, session: undefined };
    if (existing === undefined) this.#appBrokers.set(link.key, broker);
    const current = broker.session;
    if (current !== undefined) {
      const snapshot = current.snapshot();
      if (snapshot.state === 'ready' && this.#matchesRuntimeAppBinding(snapshot.binding, link, registry)) return current;
      broker.closedObservation?.unsubscribe();
      broker.closedObservation = undefined;
      broker.session = undefined;
      if (this.#appBrokers.get(link.key) === broker) this.#appBrokers.delete(link.key);
      return this.#runtimeAppSession(generation, link);
    }
    if (broker.opening !== undefined) return broker.opening;
    const opening = (async (): Promise<DevRuntimeMcpSession> => {
      let session: DevRuntimeMcpSession | undefined;
      try {
        session = await this.#mcpRegistry.open(Object.freeze({
          expectedRegistryRevision: registry.registryRevision,
          serverName: link.descriptor.name,
          target: link.descriptor.target,
        }));
        const currentRegistry = this.#assertRuntimeAppAuthority(generation, link);
        const snapshot = session.snapshot();
        if (snapshot.state !== 'ready' || !this.#matchesRuntimeAppBinding(snapshot.binding, link, currentRegistry)) {
          throw new Error('Runtime App broker session did not negotiate the current generation authority.');
        }
        broker.session = session;
        broker.closedObservation = session.watchClosed(() => {
          if (this.#appBrokers.get(link.key) !== broker) return;
          broker.closedObservation?.unsubscribe();
          broker.closedObservation = undefined;
          broker.session = undefined;
          this.#appBrokers.delete(link.key);
        });
        return session;
      } catch (error) {
        if (session !== undefined) await session.close().catch(() => undefined);
        if (this.#appBrokers.get(link.key) === broker && broker.session === undefined) this.#appBrokers.delete(link.key);
        throw error;
      }
    })();
    broker.opening = opening;
    void opening.finally(() => {
      if (broker.opening === opening) broker.opening = undefined;
    }).catch(() => undefined);
    return opening;
  }

  async #runtimeAppResult(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    invocation: ValidatedInvocation,
  ): Promise<DevRuntimeInspectionEnvelope['app']> {
    const link = this.#runtimeAppLink(generation, invocation);
    if (link === undefined) return undefined;
    const session = await this.#runtimeAppSession(generation, link);
    const registry = this.#assertRuntimeAppAuthority(generation, link);
    const snapshot = session.snapshot();
    if (snapshot.state !== 'ready' || !this.#matchesRuntimeAppBinding(snapshot.binding, link, registry)) {
      throw new Error('Runtime App broker session became stale before invocation completion.');
    }
    const binding = snapshot.binding;
    return Object.freeze({
      mcpBinding: Object.freeze({
        definitionDigest: binding.definitionDigest,
        registryRevision: binding.registryRevision,
        serverDigest: binding.serverDigest,
        serverName: binding.serverName,
        sessionId: binding.sessionId,
        sessionRevision: binding.sessionRevision,
        target: binding.target,
        transportDigest: binding.transportDigest,
      }),
      resourceUri: link.resourceUri,
      surfaceId: link.surfaceId,
    });
  }

  #validateWorkerResponse(value: unknown, flightBytes: number, surfaceId: string): DevRuntimeInspectionEnvelope {
    const response = plainRecord(value, 'RSC invocation worker emitted an invalid response.');
    assertExactKeys(response, ['flightBytes', 'inspection'], 'RSC invocation worker response has unsupported fields.');
    if (
      typeof response.flightBytes !== 'number' || !Number.isSafeInteger(response.flightBytes) ||
      response.flightBytes < 0 || response.flightBytes > maximumInvocationFlightBytes || response.flightBytes !== flightBytes
    ) {
      throw new Error('RSC invocation worker Flight framing is invalid.');
    }
    const inspection = plainRecord(response.inspection, 'RSC invocation worker inspection is invalid.');
    const hook = surfaceId === 'hook.claude' || surfaceId === 'hook.codex';
    if ('app' in inspection) validateAppBinding(inspection.app);
    optionalExactKeys(
      inspection,
      hook ? ['agentVisible', 'flight', 'native', 'state', 'trace', 'tree'] : ['flight', 'modelVisible', 'protocol', 'state', 'trace', 'tree'],
      hook ? [] : [],
      'RSC invocation worker inspection has unsupported fields.',
    );
    const flight = plainRecord(inspection.flight, 'RSC invocation worker inspection is missing Flight metadata.');
    assertExactKeys(flight, ['bytes', 'preview', 'truncated'], 'RSC invocation worker Flight metadata is invalid.');
    if (flight.bytes !== flightBytes || typeof flight.preview !== 'string' || typeof flight.truncated !== 'boolean') {
      throw new Error('RSC invocation worker Flight metadata does not match its raw Flight stream.');
    }
    const state = plainRecord(inspection.state, 'RSC invocation worker inspection is missing state metadata.');
    optionalExactKeys(state, ['identity'], ['snapshot'], 'RSC invocation worker state metadata is invalid.');
    const identity = plainRecord(state.identity, 'RSC invocation worker state identity is invalid.');
    assertExactKeys(identity, ['stateStoreId', 'stateVersion'], 'RSC invocation worker state identity is invalid.');
    if (identity.stateStoreId !== stateStoreId || !Number.isSafeInteger(identity.stateVersion) || (identity.stateVersion as number) < 0) {
      throw new Error('RSC invocation worker state identity is invalid.');
    }
    validateTrace(inspection.trace);
    validateTree(inspection.tree);
    assertCredentialSafeJson(inspection);
    return deepFreeze(inspection as unknown as DevRuntimeInspectionEnvelope);
  }

  #runInvocationWorker(input: Readonly<{
    readonly generation: RuntimeGeneration<RscRuntimeGenerationMetadata>;
    readonly input: JsonObject;
    readonly runId: string;
    readonly surfaceId: string;
  }>): Promise<Readonly<{ readonly flight: Buffer; readonly inspection: DevRuntimeInspectionEnvelope }>> {
    this.#assertInvocationOpen();
    const entry = join(input.generation.root, 'rsc', 'dev', 'invoke.js');
    if (!isInside(input.generation.root, entry)) return Promise.reject(new Error('RSC invocation entry escaped its generation root.'));
    const windowsSupervised = process.platform === 'win32';
    const child = spawn(process.execPath, windowsSupervised ? ['-e', windowsInvocationWrapperSource, entry] : [entry], {
      cwd: resolve(this.#context.projectRoot),
      detached: process.platform !== 'win32',
      env: {
        ...this.#context.environment,
        AGENT_RUNTIME_STATE_FILE: this.#stateFile,
        NODE_ENV: 'development',
      },
      stdio: windowsSupervised ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    const flightOutput = child.stdio[3] as NodeJS.ReadableStream | undefined;
    const invocationControl = windowsSupervised ? child.stdio[4] as NodeJS.WritableStream | undefined : undefined;
    const processGroupId = child.pid;
    if (
      stdout === null || stderr === null || flightOutput === undefined || flightOutput === null || processGroupId === undefined ||
      (windowsSupervised && (invocationControl === undefined || invocationControl === null))
    ) {
      child.kill('SIGKILL');
      return Promise.reject(new Error('RSC invocation worker streams are unavailable.'));
    }

    const jobOwner = windowsSupervised ? (() => {
      const owner = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        windowsJobOwnerSource,
        String(processGroupId),
        this.#testing.windowsJobOwnerMode ?? 'normal',
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const ownerControl = owner.stdin;
      const ownerStdout = owner.stdout;
      const ownerStderr = owner.stderr;
      if (ownerControl === null || ownerStdout === null || ownerStderr === null) {
        owner.kill('SIGKILL');
        return Object.freeze({
          closed: Promise.resolve(),
          done: Promise.reject(new Error('RSC invocation Windows Job Object owner streams are unavailable.')),
          drained: Promise.reject(new Error('RSC invocation Windows Job Object owner streams are unavailable.')),
          ready: Promise.reject(new Error('RSC invocation Windows Job Object owner streams are unavailable.')),
          isAssigned: () => false,
          isClosed: () => true,
          forceTerminate: () => undefined,
          terminate: () => undefined,
        } satisfies WindowsJobOwner);
      }
      const ownerStderrChunks: Buffer[] = [];
      let ownerStderrBytes = 0;
      let assigned = false;
      let readySettled = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      let drainedSettled = false;
      let resolveDrained!: () => void;
      let rejectDrained!: (error: Error) => void;
      const drained = new Promise<void>((resolve, reject) => {
        resolveDrained = resolve;
        rejectDrained = reject;
      });
      let doneSettled = false;
      let resolveDone!: () => void;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const ownerFailure = (message: string): Error => {
        const diagnostics = redactInspectionDiagnostics(Buffer.concat(ownerStderrChunks).toString('utf8'));
        return new Error(message + (diagnostics.length === 0 ? '' : ': ' + diagnostics));
      };
      const failReady = (failure: Error): void => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(failure);
        }
      };
      const failDrained = (failure: Error): void => {
        if (!drainedSettled) {
          drainedSettled = true;
          rejectDrained(failure);
        }
      };
      const failDone = (failure: Error): void => {
        if (!doneSettled) {
          doneSettled = true;
          rejectDone(failure);
        }
      };
      const protocolFailure = (message: string): void => {
        const failure = ownerFailure(message);
        failReady(failure);
        failDrained(failure);
        failDone(failure);
      };
      let protocolBytes = 0;
      let protocolOffset = 0;
      const protocolChunks: Buffer[] = [];
      const consumeOwnerProtocol = (): void => {
        const protocol = Buffer.concat(protocolChunks).toString('utf8');
        let remainder = protocol.slice(protocolOffset);
        if (!readySettled) {
          const readyLine = ['READY\n', 'READY\r\n'].find((line) => remainder.startsWith(line));
          if (readyLine !== undefined) {
            readySettled = true;
            assigned = true;
            resolveReady();
            protocolOffset += readyLine.length;
            remainder = protocol.slice(protocolOffset);
          } else if (!['READY\n', 'READY\r\n'].some((line) => line.startsWith(remainder))) {
            protocolFailure('RSC invocation Windows Job Object owner emitted an invalid readiness response.');
            return;
          } else {
            return;
          }
        }
        if (!drainedSettled) {
          const drainedLine = ['DRAINED\n', 'DRAINED\r\n'].find((line) => remainder.startsWith(line));
          if (drainedLine !== undefined) {
            drainedSettled = true;
            resolveDrained();
            protocolOffset += drainedLine.length;
            remainder = protocol.slice(protocolOffset);
          } else if (!['DRAINED\n', 'DRAINED\r\n'].some((line) => line.startsWith(remainder))) {
            protocolFailure('RSC invocation Windows Job Object owner did not confirm descendant drain.');
            return;
          } else {
            return;
          }
        }
        if (remainder.length > 0) protocolFailure('RSC invocation Windows Job Object owner emitted extra protocol output.');
      };
      ownerStdout.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        protocolBytes += bytes.byteLength;
        if (protocolBytes > 32 || doneSettled) {
          protocolFailure('RSC invocation Windows Job Object owner emitted oversized or late protocol output.');
          return;
        }
        protocolChunks.push(bytes);
        consumeOwnerProtocol();
      });
      ownerControl.once('error', () => {
        const failure = ownerFailure('RSC invocation Windows Job Object owner control stream failed.');
        failReady(failure);
        failDrained(failure);
        failDone(failure);
      });
      ownerStdout.once('error', () => {
        protocolFailure('RSC invocation Windows Job Object owner protocol stream failed.');
      });
      ownerStderr.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const retained = Math.min(bytes.byteLength, Math.max(0, maximumInvocationStderrBytes - ownerStderrBytes));
        if (retained > 0) ownerStderrChunks.push(bytes.subarray(0, retained));
        ownerStderrBytes += bytes.byteLength;
      });
      ownerStderr.once('error', () => {
        protocolFailure('RSC invocation Windows Job Object owner diagnostics stream failed.');
      });
      owner.once('error', (error) => {
        const failure = ownerFailure('RSC invocation Windows Job Object owner could not be started: ' + error.message);
        failReady(failure);
        failDrained(failure);
        failDone(failure);
      });
      owner.once('close', (code) => {
        resolveClosed();
        const failure = ownerFailure('RSC invocation Windows Job Object owner exited with code ' + String(code) + '.');
        if (!readySettled) failReady(failure);
        if (!drainedSettled) failDrained(failure);
        if (code === 0 && readySettled && drainedSettled) {
          if (!doneSettled) {
            doneSettled = true;
            resolveDone();
          }
        } else {
          failDone(failure);
        }
      });
      return Object.freeze({
        closed,
        done,
        drained,
        ready,
        isAssigned: () => assigned,
        isClosed: () => owner.exitCode !== null || owner.signalCode !== null,
        forceTerminate: () => {
          try { owner.kill('SIGKILL'); } catch { /* Owner already exited. */ }
        },
        terminate: () => {
          if (!ownerControl.destroyed) ownerControl.end('STOP\n');
        },
      } satisfies WindowsJobOwner);
    })() : undefined;
    let termination: Error | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let flightBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const flightChunks: Buffer[] = [];
    const childClosed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('close', () => resolve());
    });
    const cleanupFailure = (error: unknown): void => {
      const failure = error instanceof Error ? error : new Error('RSC invocation worker teardown failed.');
      termination = termination === undefined
        ? failure
        : new AggregateError([termination, failure], 'RSC invocation worker teardown failed.');
    };
    const signalGroup = async (signal: NodeJS.Signals): Promise<void> => {
      if (windowsSupervised) return;
      try {
        process.kill(-processGroupId, signal);
      } catch {
        try { child.kill(signal); } catch { /* Child already exited. */ }
      }
    };
    let treeCleanup: Promise<void> | undefined;
    const teardownTree = (): Promise<void> => {
      treeCleanup ??= (async () => {
        if (jobOwner !== undefined) {
          let forcedOwnerTermination = false;
          const forceOwnerTermination = (): void => {
            if (forcedOwnerTermination) return;
            forcedOwnerTermination = true;
            jobOwner.forceTerminate();
          };
          if (!jobOwner.isAssigned()) {
            // READY was never observed, so wrapper code is still blocked on GO.
            // The retained ChildProcess handle is safe only in this pre-assignment
            // phase; all assigned trees are owned exclusively through the Job.
            forceOwnerTermination();
            try { child.kill('SIGKILL'); } catch { /* Wrapper already exited. */ }
          } else {
            jobOwner.terminate();
            try {
              await withinDeadline(
                jobOwner.drained,
                windowsJobOwnerPhaseDeadlineMs,
                'RSC invocation Windows Job Object owner did not confirm descendant drain.',
              );
            } catch (error) {
              cleanupFailure(error);
              forceOwnerTermination();
            }
          }
          try {
            await withinDeadline(
              childClosed,
              windowsJobOwnerPhaseDeadlineMs,
              'RSC invocation Windows Job Object did not terminate its wrapper.',
            );
          } catch (error) {
            cleanupFailure(error);
            forceOwnerTermination();
            try {
              await withinDeadline(
                childClosed,
                windowsJobOwnerPhaseDeadlineMs,
                'RSC invocation Windows Job Object did not terminate its wrapper after forced owner shutdown.',
              );
            } catch (forcedError) {
              cleanupFailure(forcedError);
            }
          }
          try {
            await withinDeadline(
              jobOwner.closed,
              windowsJobOwnerPhaseDeadlineMs,
              'RSC invocation Windows Job Object owner did not exit after cleanup.',
            );
          } catch (error) {
            cleanupFailure(error);
            forceOwnerTermination();
            try {
              await withinDeadline(
                jobOwner.closed,
                windowsJobOwnerPhaseDeadlineMs,
                'RSC invocation Windows Job Object owner did not exit after forced shutdown.',
              );
            } catch (forcedError) {
              cleanupFailure(forcedError);
            }
          }
          try {
            await withinDeadline(
              jobOwner.done,
              windowsJobOwnerPhaseDeadlineMs,
              'RSC invocation Windows Job Object owner did not complete its verified drain protocol.',
            );
          } catch (error) {
            cleanupFailure(error);
          }
          return;
        }
        await signalGroup('SIGTERM');
        await new Promise<void>((resolve) => setTimeout(resolve, invocationTerminationGraceMs));
        await signalGroup('SIGKILL');
      })();
      return treeCleanup;
    };
    const terminate = (reason: Error): void => {
      if (termination !== undefined) return;
      termination = reason;
      child.stdin.destroy();
      void teardownTree();
    };
    void jobOwner?.done.catch((error: unknown) => {
      if (termination === undefined) terminate(error instanceof Error ? error : new Error('RSC invocation Windows Job Object owner failed.'));
    });
    const abort = (): void => terminate(new DevRuntimeUnavailableError('RSC runtime session is closed.'));
    this.#invocationAbort.signal.addEventListener('abort', abort, { once: true });

    const response = new Promise<Readonly<{ readonly flight: Buffer; readonly inspection: DevRuntimeInspectionEnvelope }>>((resolveResponse, rejectResponse) => {
      const finish = async (callback: () => void): Promise<void> => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        await treeCleanup;
        callback();
      };
      const parseWorkerResponse = (): Readonly<{ readonly flight: Buffer; readonly inspection: DevRuntimeInspectionEnvelope }> => {
        const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdoutChunks));
        if (!output.endsWith('\n') || output.indexOf('\n') !== output.length - 1) {
          throw new Error('RSC invocation worker did not emit exactly one JSON response line.');
        }
        return Object.freeze({
          flight: Buffer.concat(flightChunks),
          inspection: this.#validateWorkerResponse(JSON.parse(output), flightBytes, input.surfaceId),
        });
      };
      stdout.on('data', (chunk: Buffer | string) => {
        if (termination !== undefined) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > maximumInvocationStdoutBytes) {
          terminate(new Error(`RSC invocation stdout exceeded ${maximumInvocationStdoutBytes} bytes.`));
          return;
        }
        stdoutChunks.push(bytes);
      });
      stdout.once('error', () => terminate(new Error('RSC invocation stdout stream failed.')));
      flightOutput.on('data', (chunk: Buffer | string) => {
        if (termination !== undefined) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        flightBytes += bytes.byteLength;
        if (flightBytes > maximumInvocationFlightBytes) {
          terminate(new Error(`RSC invocation Flight exceeded ${maximumInvocationFlightBytes} bytes.`));
          return;
        }
        flightChunks.push(bytes);
      });
      flightOutput.once('error', () => terminate(new Error('RSC invocation Flight stream failed.')));
      stderr.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const retained = Math.min(bytes.byteLength, Math.max(0, maximumInvocationStderrBytes - stderrBytes));
        if (retained > 0) stderrChunks.push(bytes.subarray(0, retained));
        stderrBytes += bytes.byteLength;
        if (stderrBytes > maximumInvocationStderrBytes) {
          terminate(new Error(`RSC invocation stderr exceeded ${maximumInvocationStderrBytes} bytes.`));
        }
      });
      stderr.once('error', () => terminate(new Error('RSC invocation stderr stream failed.')));
      if (invocationControl !== undefined && invocationControl !== null) {
        invocationControl.once('error', () => terminate(new Error('RSC invocation Windows wrapper control stream failed.')));
      }
      child.stdin.once('error', () => terminate(new Error('RSC invocation request stream failed.')));
      child.once('error', (error) => terminate(new Error(`RSC invocation worker could not be started: ${error.message}`)));
      child.once('close', (code) => {
        void (async () => {
          const diagnostics = redactInspectionDiagnostics(Buffer.concat(stderrChunks).toString('utf8'));
          if (termination !== undefined) {
            const message = termination.message;
            void finish(() => rejectResponse(new Error(`${message}${diagnostics.length === 0 ? '' : `: ${diagnostics}`}`)));
            return;
          }
          if (code !== 0) {
            const failure = new Error(`RSC invocation worker exited with code ${String(code)}${diagnostics.length === 0 ? '' : `: ${diagnostics}`}`);
            terminate(failure);
            void finish(() => rejectResponse(failure));
            return;
          }
          try {
            const parsed = parseWorkerResponse();
            void (async () => {
              await teardownTree();
              const terminationAfterCleanup = termination as Error | undefined;
              if (terminationAfterCleanup !== undefined) {
                const message = terminationAfterCleanup.message;
                await finish(() => rejectResponse(new Error(`${message}${diagnostics.length === 0 ? '' : `: ${diagnostics}`}`)));
                return;
              }
              await finish(() => resolveResponse(parsed));
            })();
          } catch (error) {
            const failure = error instanceof Error ? error : new Error('RSC invocation worker emitted invalid JSON.');
            terminate(failure);
            void finish(() => rejectResponse(failure));
          }
        })();
      });
      timeout = setTimeout(() => terminate(new Error(`RSC invocation worker exceeded ${invocationTimeoutMs} ms.`)), invocationTimeoutMs);
      void (async () => {
        try {
          if (jobOwner !== undefined) {
            await withinDeadline(
              jobOwner.ready,
              windowsJobOwnerPhaseDeadlineMs,
              'RSC invocation Windows Job Object owner did not confirm assignment readiness.',
            );
            this.#assertInvocationOpen();
            if (jobOwner.isClosed()) throw new Error('RSC invocation Windows Job Object owner closed before the worker was armed.');
            invocationControl!.end('GO\\n');
          }
          this.#assertInvocationOpen();
          child.stdin.end(JSON.stringify(input.input));
        } catch (error) {
          terminate(error instanceof Error ? error : new Error('RSC invocation request could not be encoded.'));
        }
      })();
    });
    const worker: InvocationWorker = Object.freeze({
      done: response.then(() => undefined, () => undefined),
      terminate,
    });
    this.#workers.set(input.runId, worker);
    void worker.done.finally(() => {
      if (this.#workers.get(input.runId) === worker) this.#workers.delete(input.runId);
      this.#invocationAbort.signal.removeEventListener('abort', abort);
    });
    return response;
  }

  #attachServer(
    started: StartDevServerResult,
    devServer: Readonly<{ readonly hostname: string; readonly https: boolean; readonly port: number }> | undefined,
  ): void {
    if (this.#closed) return;
    if (
      devServer === undefined || devServer.hostname !== '127.0.0.1' || devServer.https ||
      !Number.isSafeInteger(devServer.port) || devServer.port < 1 || devServer.port > 65_535
    ) throw new Error('RSC runtime dev server did not expose a valid loopback HTTP origin.');
    const origin = new URL(`http://${devServer.hostname}:${String(devServer.port)}`).origin;
    this.#server = started.server;
    this.#clientSurface = Object.freeze({
      entryPath: clientSurfaceEntry,
      httpOrigin: origin,
      httpPathPrefixes: Object.freeze(['/']),
      subscribeReload: (listener: () => void) => this.#subscribeAppReload(listener),
      surfaceId: clientSurfaceId,
    });
    this.#hmrReady = true;
    this.#setStatus(this.#active === undefined ? 'compiling' : 'active');
  }

  #subscribeAppReload(listener: () => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('RSC runtime App reload subscription requires a listener function.');
    }
    if (this.#closed) return () => undefined;
    const subscription = Object.freeze({ listener });
    this.#appReloadSubscriptions.add(subscription);
    return () => { this.#appReloadSubscriptions.delete(subscription); };
  }

  #emitAppReload(): void {
    if (this.#closed) return;
    for (const subscription of [...this.#appReloadSubscriptions]) {
      try {
        subscription.listener();
      } catch {
        // One relay's failure must not starve the remaining subscribers.
      }
    }
  }

  #compileObserver(): NonNullable<Parameters<typeof createRscRuntimeRsbuildConfig>[0]['onCompile']> {
    return Object.freeze({
      beginCompletedCohort: () => this.#beginCompletedCohort(),
      capture: async (input) => this.#trackCapture(input),
      enqueue: (snapshot) => this.#enqueue(snapshot),
      failAttempt: (attemptId, error, kind) => { void this.#failAttempt(attemptId, error, kind); },
      // Advisory only: pre-compile observation carries no identity and owns
      // no activation barrier. It is a collapse hint: an in-flight activation
      // briefly waits (bounded, never failing) for the observed compile's
      // completion so the newest completed cohort supersedes it before an
      // older generation becomes visible. A before callback with no matching
      // completion (a coalesced or superseded invalidation) can therefore
      // only delay one activation by the grace budget, never wedge it.
      observeCompileStart: () => { this.#observeCompileStart(); },
      stageEnvironmentCheckpoint: (input) => this.#stageEnvironmentCheckpoint(input),
    });
  }

  #observeCompileStart(): void {
    if (this.#closed) return;
    this.#observedCompileStarts += 1;
  }

  /**
   * Marks one completed-cohort observation as settled: the completion either
   * captured (bumping the cohort ordinal), settled as a no-op, or failed.
   * Rsbuild coalesces pending invalidations into the next completion, so a
   * settled completion absorbs every outstanding pre-compile observation;
   * the count resets to zero rather than decrementing.
   */
  #settleCompileObservation(): void {
    this.#observedCompileStarts = 0;
    const waiters = this.#compileSettleWaiters;
    this.#compileSettleWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Never rejects into the compiler's `done` hook: a rejected environment
   * hook would skip Rsbuild's global after-compile dispatch, so no completed
   * cohort would surface the problem. Failures are recorded against this
   * (environment, hash) instead and fail the attempt loudly at cohort
   * acquisition.
   */
  async #stageEnvironmentCheckpoint(input: Readonly<{
    readonly distPath: string;
    readonly environmentName: RscRuntimeEnvironmentName;
    readonly statsHash: string;
  }>): Promise<void> {
    try {
      if (this.#closed) throw new Error('RSC runtime session is closed.');
      // The staged copy must read the same root this session configured for
      // the environment; a diverging Rsbuild distPath would silently
      // checkpoint the wrong tree.
      const expectedRoot = join(resolve(this.#context.storageRoot), 'compiler', input.environmentName);
      if (resolve(input.distPath) !== expectedRoot) {
        throw new Error(`RSC runtime ${input.environmentName} compiler emitted outside its session root.`);
      }
      await this.#checkpointStore.stage({
        environment: input.environmentName,
        hash: input.statsHash,
        sourceRoot: expectedRoot,
      });
    } catch (error) {
      this.#checkpointStore.recordStagingFailure({
        environment: input.environmentName,
        error: error instanceof Error ? error : new Error(String(error)),
        hash: input.statsHash,
      });
    }
  }

  #trackCapture(input: Readonly<{
    readonly attemptId: string;
    readonly cohortChanged: boolean;
    readonly environmentHashes: RscRuntimeCompileEnvironmentHashes;
    readonly hasErrors: boolean;
    readonly sourceRevision: string;
  }>): Promise<RscRuntimeCompileSnapshot | undefined> {
    const capture = this.#capture(input);
    const tracked = capture.then(() => undefined, () => undefined);
    this.#captureTasks.add(tracked);
    void tracked.then(() => { this.#captureTasks.delete(tracked); });
    return capture;
  }

  /**
   * Allocates the identity of one completed MultiStats cohort, in global
   * completion-callback order. This is the only source of compile identity:
   * nothing pairs it with `onBeforeDevCompile`, so callback cardinality and
   * ordering between the global hooks cannot misassociate Stats or leave an
   * unsettled identity behind.
   */
  #beginCompletedCohort(): string {
    if (this.#closed) throw new Error('RSC runtime session is closed.');
    const id = `cohort-${String(++this.#completedCohortSequence)}`;
    this.#pendingCohortIds.add(id);
    return id;
  }

  async #capture(input: Readonly<{
    readonly attemptId: string;
    readonly cohortChanged: boolean;
    readonly environmentHashes: RscRuntimeCompileEnvironmentHashes;
    readonly hasErrors: boolean;
    readonly sourceRevision: string;
  }>): Promise<RscRuntimeCompileSnapshot | undefined> {
    if (!this.#pendingCohortIds.delete(input.attemptId)) {
      throw new Error('RSC runtime compile capture has no live completed cohort identity.');
    }
    if (input.hasErrors) {
      this.#settleCompileObservation();
      // The observer plugin fails erroring cohorts before capture with the
      // Rspack error detail; a caller that still reports `hasErrors` here has
      // no stats to quote.
      await this.#failAttempt(
        input.attemptId,
        new Error('RSC runtime compile reported errors, but Rspack stats carried no error details.'),
        'source-build',
      );
      return undefined;
    }
    if (input.sourceRevision.length === 0) {
      this.#settleCompileObservation();
      await this.#failAttempt(input.attemptId, new Error('RSC runtime compilation has no source revision.'));
      return undefined;
    }
    if (!input.cohortChanged) {
      this.#settleCompileObservation();
      return undefined;
    }
    // The completed-cohort ordinal bumps synchronously with the completion
    // callback, so every older activation observes its supersession at the
    // guard check; the settle below wakes any activation waiting on this
    // observed compile AFTER the ordinal is authoritative.
    const cohortRevision = ++this.#latestRscCohortRevision;
    this.#settleCompileObservation();
    const preparedRuntime = this.#latestPreparedRuntime;
    this.#emit(Object.freeze({ runtimeGenerationId: undefined, type: 'runtime.generation.compiling' }));
    try {
      const candidate = await this.#generationStore.begin({
        id: `generation-${String(++this.#generationSequence)}`,
        sourceRevision: input.sourceRevision,
      });
      this.#candidatesByAttempt.set(input.attemptId, candidate);
      await this.#testing.beforeGenerationCapture?.();
      if (this.#closed) throw new Error('RSC runtime session is closed.');
      // Rsbuild does not guarantee that global MultiStats completion is a
      // transactional snapshot of parallel writeToDisk roots, so capture
      // never reads the live compiler roots. It assembles the candidate from
      // the immutable per-environment checkpoints staged in each compiler's
      // own after-environment-compile hook, matched exactly against this
      // cohort's Stats hashes; acquisition waits for a late-staging child and
      // fails fast once a newer compilation supersedes a requested hash.
      const cohort = await this.#checkpointStore.acquireCohort(input.environmentHashes);
      let snapshot: RscRuntimeCapturedGenerationSnapshot;
      try {
        snapshot = await captureRuntimeGenerationSnapshot({
          attemptId: input.attemptId,
          candidate,
          cohort: cohort.checkpoints,
          preparedRuntime,
          rscCohortRevision: cohortRevision,
          sourceRevision: input.sourceRevision,
        });
      } finally {
        // The candidate now owns its own copied bytes, so superseded
        // checkpoints can be garbage-collected without touching it.
        cohort.release();
      }
      if (this.#closed) throw new Error('RSC runtime session is closed.');
      return Object.freeze({
        attemptId: snapshot.attemptId,
        candidateId: snapshot.candidate.id,
        preparedRevision: snapshot.preparedRuntime.sourceRevision,
        rscCohortRevision: snapshot.rscCohortRevision,
        sourceRevision: snapshot.sourceRevision,
        snapshot,
      } as RscRuntimeCompileSnapshot & Readonly<{ readonly snapshot: RscRuntimeCapturedGenerationSnapshot }>);
    } catch (error) {
      await this.#failAttempt(input.attemptId, error);
      throw error;
    }
  }

  #enqueue(snapshot: RscRuntimeCompileSnapshot): Promise<'activated' | 'failed'> {
    const captured = (snapshot as RscRuntimeCompileSnapshot & Readonly<{ readonly snapshot?: RscRuntimeCapturedGenerationSnapshot }>).snapshot;
    if (captured === undefined) throw new Error('RSC runtime compile snapshot was not captured by this session.');
    if (this.#closed) {
      return this.#failAttempt(snapshot.attemptId, new Error('RSC runtime session is closed.')).then(() => 'failed');
    }
    return this.#append(async () => this.#activate(captured));
  }

  async #failAttempt(
    attemptId: string,
    error: unknown,
    kind: RscRuntimeCompileFailureKind = 'provider-lifecycle',
  ): Promise<void> {
    if (this.#failedAttempts.has(attemptId)) return;
    this.#failedAttempts.add(attemptId);
    // A pending cohort dying before capture (malformed stats, plugin capture
    // throw) settles its observation here; failures of already-captured
    // attempts (activation errors) are not completions and settle nothing.
    if (this.#pendingCohortIds.delete(attemptId)) this.#settleCompileObservation();
    const candidate = this.#candidatesByAttempt.get(attemptId);
    this.#candidatesByAttempt.delete(attemptId);
    if (candidate !== undefined) {
      const cleanup = this.#failureTail.then(() => this.#generationStore.fail(candidate));
      this.#failureTail = cleanup.catch(() => undefined);
      await cleanup.catch(() => undefined);
    }
    if (!this.#closed) this.#setStatus(
      this.#active === undefined ? 'degraded' : 'active',
      [kind === 'source-build' ? sourceBuildDiagnostic(error, this.#context.projectRoot) : lifecycleDiagnostic(error)],
    );
    this.#emit(Object.freeze({ type: 'runtime.generation.failed' }));
  }

  #activationGuard(snapshot: RscRuntimeCapturedGenerationSnapshot): RuntimeGenerationActivationGuard<RscRuntimeGenerationMetadata> {
    const preparedAuthorityDigest = preparedRuntimeAuthorityDigest(snapshot.preparedRuntime);
    return Object.freeze({
      // Supersession tie-breaks on monotonic ordinals only: a newer captured
      // cohort (`#latestRscCohortRevision`) or a prepared-runtime authority
      // change may discard this activation. In-flight compiles have no
      // identity at all, and completed cohorts that failed or settled as
      // no-ops never bump the ordinal; judging either as superseding would
      // drop the newest successful compile with nothing to replace it - the
      // permanent-staleness wedge in #38.
      // Before the first generation commits, an updated prepared declaration
      // is reconciled by the queued step after this activation; rejecting the
      // only bootstrap generation would leave that step with no active base.
      check: () => !this.#closed &&
        snapshot.rscCohortRevision === this.#latestRscCohortRevision &&
        (this.#active === undefined ||
          preparedAuthorityDigest === preparedRuntimeAuthorityDigest(this.#latestPreparedRuntime)),
      // Supersession keys only on completed cohort ordinals (bumped
      // synchronously with each completed global callback) and
      // prepared-runtime authority. Pre-compile observation is advisory and
      // owns no barrier, but it is honored as a bounded collapse hint: an
      // observed compile that is still in flight is given a grace window to
      // complete so its cohort supersedes this activation at the check
      // instead of committing a doomed older generation first (one visible
      // activation per settled edit, as before #75). The wait can only
      // delay - it resolves at the grace deadline and never fails the
      // activation - so a compile that never completes (coalesced,
      // superseded, or dropped by the bundler) cannot wedge it, and the
      // dangling observation self-heals at the next settled completion.
      wait: async () => {
        const deadline = Date.now() + Math.max(1, Math.floor(this.#activationPhaseBudgetMs / 2));
        while (!this.#closed && this.#observedCompileStarts > 0) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(remaining, 100));
            this.#compileSettleWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        if (this.#closed) throw new Error('RSC runtime session is closed.');
      },
    });
  }

  /**
   * Bounds one activation step with the scaled budget. A step that outlives
   * its budget fails the attempt loudly (the page recovers through its
   * `runtime.generation.failed` bootstrap path) instead of silently wedging
   * the provider tail; if the abandoned step settles later, its resources are
   * released so a stray success cannot leak store or registry reservations.
   */
  async #boundedActivationPhase<T>(
    phase: ActivationPhase,
    work: Promise<T>,
    abandon?: (value: T) => Promise<void>,
  ): Promise<T> {
    const budget = this.#activationPhaseBudgetMs;
    try {
      return await withinDeadline(work, budget, `RSC runtime ${phase} activation step exceeded ${String(budget)}ms.`);
    } catch (error) {
      if (abandon !== undefined) void work.then(abandon, () => undefined).catch(() => undefined);
      throw error;
    }
  }

  async #activate(snapshot: RscRuntimeCapturedGenerationSnapshot): Promise<'activated' | 'failed'> {
    const guard = this.#activationGuard(snapshot);
    let preparedGeneration: RuntimeGenerationPreparedActivation<RscRuntimeGenerationMetadata> | undefined;
    let preparedRegistry: RuntimeMcpPreparedActivationReconcile | undefined;
    try {
      preparedGeneration = await this.#boundedActivationPhase(
        'generation-store',
        materializeRuntimeGeneration({
          guard,
          snapshot,
          stateStoreId,
          store: this.#generationStore,
        }),
        (prepared) => this.#generationStore.abort(prepared),
      );
      await this.#testing.afterActivationPrepare?.(Object.freeze({ phase: 'store', session: this }));
      const metadata = preparedGeneration.generation.manifest.metadata;
      preparedRegistry = await this.#boundedActivationPhase(
        'mcp-registry',
        this.#mcpRegistry.prepareActivationReconcile({
          definitionDigest: metadata.definitionDigest,
          runtimeGenerationId: preparedGeneration.generation.id,
          servers: metadata.servers,
          transportDigest: metadata.transportDigest,
        }),
        (prepared) => this.#mcpRegistry.abortActivationReconcile(prepared),
      );
      await this.#testing.afterActivationPrepare?.(Object.freeze({ phase: 'registry', session: this }));
      await this.#boundedActivationPhase('activation-guard', guard.wait(preparedGeneration.generation.manifest));
      await this.#testing.beforeActivationCommit?.();
      if (!guard.check(preparedGeneration.generation.manifest) || !this.#generationStore.canCommit(preparedGeneration)) {
        throw new Error('RSC runtime generation activation was superseded.');
      }
      const generation = this.#generationStore.commit(preparedGeneration);
      const committed = this.#mcpRegistry.commitActivationReconcile(preparedRegistry);
      preparedGeneration = undefined;
      preparedRegistry = undefined;
      this.#active = generation;
      this.#updateSurfaces(snapshot, snapshot.preparedRuntime);
      this.#updateSurfaceAssetApps(snapshot.preparedRuntime);
      this.#setStatus('active');
      this.#emit(Object.freeze({
        mcpRegistryRevision: this.#mcpRegistry.snapshot()?.registryRevision,
        runtimeGenerationId: generation.id,
        type: 'runtime.generation.activated',
      }));
      committed.publish();
      try {
        await committed.finalize();
      } catch (error) {
        if (!this.#closed) this.#setStatus('degraded', [lifecycleDiagnostic(error)]);
      }
      return 'activated';
    } catch (error) {
      if (preparedGeneration !== undefined || preparedRegistry !== undefined) {
        await Promise.allSettled([
          ...(preparedGeneration === undefined ? [] : [this.#generationStore.abort(preparedGeneration)]),
          ...(preparedRegistry === undefined ? [] : [this.#mcpRegistry.abortActivationReconcile(preparedRegistry)]),
        ]);
      }
      await this.#failAttempt(snapshot.attemptId, error);
      return 'failed';
    } finally {
      this.#candidatesByAttempt.delete(snapshot.attemptId);
    }
  }

  async #reconcilePreparedRuntime(prepared: DevRuntimePreparedProject): Promise<void> {
    const active = this.#active;
    if (active === undefined || this.#closed) return;
    const metadata = active.manifest.metadata;
    const definition = JSON.parse(await readFile(join(active.root, 'rsc', 'runtime-definition.json'), 'utf8')) as SerializedRuntimeDefinition;
    const nextDefinitionDigest = runtimeDefinitionDigest(definition, prepared);
    const nextTransportDigest = transportDigest(prepared);
    const current = this.#mcpRegistry.snapshot();
    if (
      current?.runtimeGenerationId === active.id &&
      current.definitionDigest === nextDefinitionDigest &&
      current.transportDigest === nextTransportDigest
    ) return;
    const input: DevRuntimeMcpRegistryReconcileInput = Object.freeze({
      definitionDigest: nextDefinitionDigest,
      runtimeGenerationId: active.id,
      servers: descriptorsFor(prepared, metadata, nextDefinitionDigest, nextTransportDigest),
      transportDigest: nextTransportDigest,
    });
    this.#setStatus('compiling');
    try {
      await this.#boundedActivationPhase('prepared-runtime-reconcile', this.#mcpRegistry.reconcile(input));
      this.#updateSurfaces({ definition }, prepared);
      this.#updateSurfaceAssetApps(prepared);
      this.#setStatus('active');
    } catch (error) {
      this.#setStatus('degraded', [lifecycleDiagnostic(error)]);
      throw error;
    }
  }

  async #executeMcp(execution: RuntimeMcpExecutionContext): Promise<Readonly<{ readonly stateVersion: number; readonly value: JsonValue }>> {
    execution.signal.throwIfAborted();
    const generation = execution.generation as RuntimeGeneration<RscRuntimeGenerationMetadata>;
    this.#assertMcpExecutionAuthority(execution, generation);
    if (execution.request.kind === 'read-resource') {
      const resource = this.#appResource(execution, generation, execution.request.uri);
      const asset = await this.#readGenerationSurfaceHtml(generation, resource.surfaceId);
      execution.signal.throwIfAborted();
      this.#assertMcpExecutionAuthority(execution, generation);
      return Object.freeze({
        stateVersion: 0,
        value: Object.freeze({
          contents: Object.freeze([Object.freeze({
            _meta: resource.metadata,
            mimeType: resource.mimeType,
            text: asset,
            uri: resource.uri,
          })]),
        }),
      });
    }
    if (execution.request.kind === 'call-tool') {
      this.#appTool(execution, generation, execution.request.name);
      return this.#executeTimelineTool(execution, generation, execution.request.arguments);
    }
    throw new Error(`Runtime MCP operation ${JSON.stringify(execution.request.kind)} is not available.`);
  }

  #assertMcpExecutionAuthority(
    execution: RuntimeMcpExecutionContext,
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
  ): NonNullable<ReturnType<DevRuntimeProviderMcpRegistry['snapshot']>> {
    this.#assertInvocationOpen();
    const registry = this.#mcpRegistry.snapshot();
    const binding = this.#mcpRegistry.session(execution.sessionId)?.snapshot().binding;
    if (
      registry === undefined || binding === undefined || this.#active?.id !== generation.id ||
      registry.runtimeGenerationId !== generation.id ||
      binding.sessionId !== execution.sessionId || binding.registryRevision !== registry.registryRevision ||
      !registry.servers.some((descriptor) => descriptor.name === execution.descriptor.name && descriptor.target === execution.descriptor.target &&
        descriptor.definitionDigest === execution.descriptor.definitionDigest && descriptor.serverDigest === execution.descriptor.serverDigest &&
        descriptor.transportDigest === execution.descriptor.transportDigest && descriptor.definitionDigest === registry.definitionDigest &&
        descriptor.transportDigest === registry.transportDigest && descriptor.serverDigest === generation.manifest.metadata.serverDigest) ||
      binding.definitionDigest !== execution.descriptor.definitionDigest || binding.serverDigest !== execution.descriptor.serverDigest ||
      binding.serverName !== execution.descriptor.name || binding.target !== execution.descriptor.target ||
      binding.transportDigest !== execution.descriptor.transportDigest
    ) {
      throw new DevRuntimeGenerationConflictError(generation.id, this.#active?.id);
    }
    return registry;
  }

  #appResource(
    execution: RuntimeMcpExecutionContext,
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    uri: string,
  ): Readonly<{ readonly metadata: JsonObject; readonly mimeType: string; readonly surfaceId: string; readonly uri: string }> {
    const resource = execution.descriptor.resources.filter((candidate) =>
      candidate.uri === uri && candidate.mimeType === 'text/html;profile=mcp-app' && isJsonObject(candidate._meta),
    );
    const app = generation.manifest.metadata.appDefinitions.filter((candidate) =>
      candidate.resourceUri === uri && candidate.serverName === execution.descriptor.name && candidate.targets.includes(execution.descriptor.target),
    );
    if (resource.length !== 1 || app.length !== 1) throw new Error('Runtime MCP App resource is not owned by the current generation.');
    const surfaceId = `mcp.${app[0]!.name}`;
    if (generation.manifest.metadata.surfaceAssets[surfaceId] === undefined) {
      throw new Error('Runtime MCP App resource has no current-generation asset.');
    }
    return Object.freeze({ metadata: resource[0]!._meta as JsonObject, mimeType: resource[0]!.mimeType as string, surfaceId, uri });
  }

  #appTool(
    execution: RuntimeMcpExecutionContext,
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    name: string,
  ): void {
    const tool = execution.descriptor.tools.filter((candidate) => candidate.name === name);
    if (tool.length !== 1 || tool[0]!.handlerId !== 'render_edit_timeline' || !isJsonObject(tool[0]!._meta)) {
      throw new Error('Runtime MCP App tool is not owned by the current generation.');
    }
    const uri = tool[0]!._meta['openai/outputTemplate'];
    if (typeof uri !== 'string') throw new Error('Runtime MCP App tool has no App resource binding.');
    this.#appResource(execution, generation, uri);
  }

  #timelineLimit(argumentsValue: JsonValue | undefined): Readonly<{ readonly limit?: number }> {
    if (argumentsValue === undefined) return Object.freeze({});
    if (!isJsonObject(argumentsValue) || Object.keys(argumentsValue).some((key) => key !== 'limit')) {
      throw new TypeError('Runtime MCP App tool arguments are invalid.');
    }
    const limit = argumentsValue.limit;
    if (limit === undefined) return Object.freeze({});
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError('Runtime MCP App tool arguments are invalid.');
    }
    return Object.freeze({ limit });
  }

  async #executeTimelineTool(
    execution: RuntimeMcpExecutionContext,
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    argumentsValue: JsonObject,
  ): Promise<Readonly<{ readonly stateVersion: number; readonly value: JsonValue }>> {
    const release = this.#reserveInvocation();
    const runId = `runtime-mcp-${randomUUID()}`;
    const abort = (): void => this.#workers.get(runId)?.terminate(new Error('Runtime MCP operation was aborted.'));
    execution.signal.addEventListener('abort', abort, { once: true });
    try {
      const snapshot = await this.#stateKernel.readSnapshot(this.#timelineLimit(argumentsValue));
      execution.signal.throwIfAborted();
      this.#assertMcpExecutionAuthority(execution, generation);
      const response = await this.#runInvocationWorker({
        generation,
        input: Object.freeze({
          snapshot: cloneJson(snapshot),
          stateFile: this.#stateFile,
          stateStoreId,
          type: 'mcp/render-timeline',
        }),
        runId,
        surfaceId: 'mcp.render_edit_timeline',
      });
      execution.signal.throwIfAborted();
      this.#assertMcpExecutionAuthority(execution, generation);
      const stateVersion = response.inspection.state.identity.stateVersion;
      const durable = await this.#stateKernel.readSnapshot({ stateVersion });
      const protocol = response.inspection.protocol;
      if (durable.stateVersion !== stateVersion || protocol === undefined || !isJsonObject(protocol)) {
        throw new Error('Runtime MCP App tool result is not a durable protocol response.');
      }
      execution.signal.throwIfAborted();
      this.#assertMcpExecutionAuthority(execution, generation);
      return Object.freeze({ stateVersion, value: cloneJson(protocol) });
    } finally {
      execution.signal.removeEventListener('abort', abort);
      release();
    }
  }

  async #readGenerationSurfaceHtml(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    surfaceId: string,
  ): Promise<string> {
    const matches = generation.manifest.metadata.surfaceAssets[surfaceId]?.filter((asset) =>
      asset.contentType === 'text/html' && asset.requestPath === clientSurfaceEntry,
    ) ?? [];
    if (matches.length !== 1) throw new Error('Runtime MCP App resource has no canonical HTML asset.');
    const asset = matches[0]!;
    if (asset.bytes > maximumAssetBytes) throw new Error('Runtime MCP App HTML exceeds the asset limit.');
    const segments = asset.generationPath.split('/');
    if (segments.some((segment) => !safeSegment(segment))) throw new Error('Runtime MCP App HTML asset path is unsafe.');
    const path = join(generation.root, ...segments);
    if (!isInside(generation.root, path)) throw new Error('Runtime MCP App HTML asset escaped its generation root.');
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== asset.bytes) {
      throw new Error('Runtime MCP App HTML asset changed.');
    }
    const body = await readFile(path);
    if (body.byteLength !== asset.bytes || createHash('sha256').update(body).digest('hex') !== asset.sha256) {
      throw new Error('Runtime MCP App HTML asset changed.');
    }
    const text = body.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') !== body.byteLength) throw new Error('Runtime MCP App HTML asset is not UTF-8.');
    return text;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#invocationAbort.abort(new Error('RSC runtime session is closing.'));
    this.#hmrReady = false;
    this.#appReloadSubscriptions.clear();
    this.#pendingCohortIds.clear();
    this.#settleCompileObservation();
    for (const worker of this.#workers.values()) {
      worker.terminate(new Error('RSC runtime session is closing.'));
    }
    // Closing the checkpoint store first fails in-flight cohort acquisitions
    // fast; its staged directories drain below once captures release them.
    const checkpointStoreClose = this.#checkpointStore.close();
    void checkpointStoreClose.catch(() => undefined);
    this.#setStatus('closed');
    for (const broker of this.#appBrokers.values()) broker.closedObservation?.unsubscribe();
    this.#appBrokers.clear();
    this.#surfaceAssetApps.clear();
    const mcpRegistryClose = this.#closeLiveSessionResource('runtime-mcp-registry', () => this.#mcpRegistry.close());
    void mcpRegistryClose.catch(() => undefined);
    while (this.#captureTasks.size > 0) await Promise.all([...this.#captureTasks]);
    while (this.#invocations.size > 0) await Promise.allSettled([...this.#invocations]);
    while (this.#runReadTasks.size > 0) {
      await Promise.allSettled([...this.#runReadTasks.values()].flatMap((reads) => [...reads]));
    }
    await this.#evictionTail;
    await Promise.all([this.#providerTail.catch(() => undefined), this.#failureTail]);
    const runArtifactCleanup = this.#closeRunArtifacts();
    void runArtifactCleanup.catch(() => undefined);
    const resources: readonly Readonly<{
      readonly close: () => Promise<void>;
      readonly label: LiveSessionCleanupResource;
    }>[] = Object.freeze([
      Object.freeze({ label: 'run-artifact' as const, close: () => runArtifactCleanup }),
      Object.freeze({ label: 'owned-runs-root' as const, close: async () => {
        await runArtifactCleanup.catch(() => undefined);
        await this.#closeLiveSessionResource(
          'owned-runs-root',
          () => RsbuildRuntimeSession.#removeOwnedRunsRoot(this.#ownedRunsRoot),
        );
      } }),
      Object.freeze({ label: 'rsbuild-dev-server' as const, close: () => this.#closeLiveSessionResource(
        'rsbuild-dev-server',
        () => this.#server?.close() ?? Promise.resolve(),
      ) }),
      Object.freeze({ label: 'runtime-mcp-registry' as const, close: () => mcpRegistryClose }),
      Object.freeze({ label: 'environment-checkpoints' as const, close: () => this.#closeLiveSessionResource(
        'environment-checkpoints',
        () => checkpointStoreClose,
      ) }),
      Object.freeze({ label: 'generation-store' as const, close: () => this.#closeLiveSessionResource(
        'generation-store',
        () => this.#generationStore.close(),
      ) }),
    ]);
    const results = await Promise.allSettled(resources.map((resource) => resource.close()));
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [Object.freeze({ error: result.reason, label: resources[index]!.label })]
      : []);
    if (failures.length > 0) throw cleanupAggregate('RSC runtime session close failed', failures);
  }

  async #closeRunArtifacts(): Promise<void> {
    const artifactResults = await Promise.allSettled([...this.#runArtifacts.keys()].map((runId) => this.#releaseRunArtifact(runId)));
    const directoryResults = await Promise.allSettled([...this.#pendingRunDirectoryRemovals].map(async (runId) => {
      await this.#removeRunDirectory(runId);
      this.#pendingRunDirectoryRemovals.delete(runId);
    }));
    const failures = [
      ...artifactResults.flatMap((result) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, label: 'run-artifact' })]
        : []),
      ...directoryResults.flatMap((result) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, label: 'run-artifact' })]
        : []),
    ];
    if (failures.length > 0) throw cleanupAggregate('RSC runtime run artifact cleanup failed', failures);
    await this.#testing.afterLiveSessionCleanupResource?.(Object.freeze({ resource: 'run-artifact' as const }));
  }

  async #closeLiveSessionResource(
    resource: LiveSessionCleanupResource,
    close: () => Promise<void>,
  ): Promise<void> {
    await close();
    await this.#testing.afterLiveSessionCleanupResource?.(Object.freeze({ resource }));
  }

  #append<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#providerTail.then(work, work);
    this.#providerTail = next.then(() => undefined, () => undefined);
    return next;
  }

  #emit(event: DevRuntimeEventInput): void {
    if (this.#closed) return;
    try {
      this.#context.emit(event);
    } catch {
      // Runtime listeners cannot affect lifecycle ordering.
    }
  }

  #publishActiveStateVersion(generation: RuntimeGeneration<RscRuntimeGenerationMetadata>, stateVersion: number): void {
    if (this.#active?.id !== generation.id) return;
    const current = this.#status.activeVector;
    if (current?.runtimeGenerationId === generation.id && current.stateVersion > stateVersion) return;
    this.#setStatus(this.#status.state, this.#status.diagnostics, stateVersion);
  }

  #setStatus(
    state: DevRuntimeStatus['state'],
    diagnostics: readonly DevRuntimeDiagnostic[] = [],
    stateVersion = 0,
  ): void {
    const active = this.#active;
    const vector = active === undefined ? undefined : this.#vector(active, stateVersion);
    this.#status = Object.freeze({
      ...(vector === undefined ? {} : { activeVector: vector, lastGoodVector: vector }),
      descriptor,
      diagnostics: Object.freeze([...diagnostics]),
      hmrReady: this.#hmrReady,
      state,
    });
  }

  #updateSurfaces(
    snapshot: Pick<RscRuntimeCapturedGenerationSnapshot, 'definition'>,
    prepared: Pick<DevRuntimePreparedProject, 'apps' | 'servers'>,
  ): void {
    this.#surfaces.clear();
    for (const hook of snapshot.definition.nativeHooks) {
      this.#surfaces.set(`hook.${hook.host}`, Object.freeze({
        id: `hook.${hook.host}`,
        kind: 'hook',
        label: `After tool hook (${hook.host})`,
        readOnly: false,
        targets: Object.freeze([hook.host]),
        fixtures: fixturesForHook(hook.host),
      }));
    }
    for (const tool of snapshot.definition.tools) {
      this.#surfaces.set(`mcp.${tool.name}`, Object.freeze({
        inputSchema: cloneJsonObject(tool.inputSchema),
        id: `mcp.${tool.name}`,
        kind: 'mcp-tool',
        label: tool.description,
        readOnly: tool.annotations.readOnlyHint,
        targets: Object.freeze([...prepared.servers.flatMap((server) => server.targets)]),
        fixtures: Object.freeze([]),
      }));
    }
    for (const resource of snapshot.definition.resources) {
      this.#surfaces.set(`mcp.${resource.name}`, Object.freeze({
        id: `mcp.${resource.name}`,
        kind: 'mcp-resource',
        label: resource.name,
        readOnly: true,
        targets: Object.freeze([...prepared.servers.flatMap((server) => server.targets)]),
        fixtures: Object.freeze([]),
      }));
    }
    for (const app of prepared.apps) {
      this.#surfaces.set(`mcp.${app.name}`, Object.freeze({
        id: `mcp.${app.name}`,
        kind: 'mcp-app',
        label: app.name,
        readOnly: true,
        targets: Object.freeze([...app.targets]),
        fixtures: Object.freeze([]),
      }));
    }
  }

  #updateSurfaceAssetApps(prepared: Pick<DevRuntimePreparedProject, 'apps'>): void {
    this.#surfaceAssetApps.clear();
    for (const app of prepared.apps) {
      this.#surfaceAssetApps.set(`mcp.${app.name}`, app);
    }
  }

  #surfaceAssetBinding(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    app: DevRuntimePreparedProject['apps'][number],
  ): string | undefined {
    const metadata = generation.manifest.metadata;
    const exact = metadata.appDefinitions.find((candidate) =>
      candidate.id === app.id && candidate.resourceUri === app.resourceUri,
    );
    if (exact !== undefined) {
      const surfaceId = `mcp.${exact.name}`;
      return metadata.surfaceAssets[surfaceId] === undefined ? undefined : surfaceId;
    }
    const matches = metadata.appDefinitions.filter((candidate) =>
      candidate.resourceUri === app.resourceUri && metadata.surfaceAssets[`mcp.${candidate.name}`] !== undefined,
    );
    return matches.length === 1 ? `mcp.${matches[0]!.name}` : undefined;
  }

  #vector(generation: RuntimeGeneration<RscRuntimeGenerationMetadata>, stateVersion = 0): RuntimeVector {
    return Object.freeze({
      providerSessionId: this.providerSessionId,
      runtimeGenerationId: generation.id,
      sourceRevision: generation.sourceRevision,
      stateStoreId,
      stateVersion,
    });
  }

  static async #createOwnedRunsRoot(storageRoot: string, providerSessionId: string): Promise<OwnedRunsRoot> {
    await mkdir(storageRoot, { recursive: true });
    const canonicalStorageRoot = await realpath(storageRoot);
    const candidate = join(canonicalStorageRoot, 'runs');
    try {
      await mkdir(candidate);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'EEXIST') {
        throw new Error('RSC runtime invocation root already exists and is not owned by this provider session.', { cause: error });
      }
      throw error;
    }
    try {
      const root = await realpath(candidate);
      const details = await lstat(root);
      if (!isInside(canonicalStorageRoot, root) || !details.isDirectory() || details.isSymbolicLink()) {
        throw new Error('RSC runtime invocation root is not a contained non-symbolic directory.');
      }
      const marker = join(root, '.agent-bundle-runtime-owner');
      const token = `${providerSessionId}:${randomUUID()}`;
      await writeFile(marker, token, { flag: 'wx' });
      const markerDetails = await lstat(marker);
      if (!markerDetails.isFile() || markerDetails.isSymbolicLink()) {
        throw new Error('RSC runtime invocation root ownership marker is unsafe.');
      }
      return Object.freeze({ dev: details.dev, ino: details.ino, marker, root, token });
    } catch (error) {
      await rm(candidate, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  static async #assertOwnedRunsRoot(owned: OwnedRunsRoot): Promise<void> {
    const details = await lstat(owned.root);
    if (
      !details.isDirectory() || details.isSymbolicLink() ||
      details.dev !== owned.dev || details.ino !== owned.ino ||
      await realpath(owned.root) !== owned.root
    ) {
      throw new Error('RSC runtime invocation root ownership changed during this provider session.');
    }
    const markerDetails = await lstat(owned.marker);
    if (!markerDetails.isFile() || markerDetails.isSymbolicLink() || await readFile(owned.marker, 'utf8') !== owned.token) {
      throw new Error('RSC runtime invocation root ownership marker changed during this provider session.');
    }
  }

  static async #removeOwnedRunsRoot(owned: OwnedRunsRoot): Promise<void> {
    await RsbuildRuntimeSession.#assertOwnedRunsRoot(owned);
    await rm(owned.root, { force: true, recursive: true });
  }

  #assertCurrentOwnedRunsRoot(): Promise<void> {
    return RsbuildRuntimeSession.#assertOwnedRunsRoot(this.#ownedRunsRoot);
  }

  #validatePreparedRuntime(prepared: DevRuntimePreparedProject): void {
    RsbuildRuntimeSession.#validateStartContext(this.#context, prepared);
  }

  static #validateStartContext(context: DevRuntimeStartContext, prepared: DevRuntimePreparedProject): void {
    if (prepared.provider !== './src/dev/provider.ts') throw new Error('RSC runtime provider declaration does not match this provider.');
    if (!isInside(context.projectRoot, resolve(context.projectRoot, prepared.provider))) {
      throw new Error('RSC runtime provider declaration escapes the project root.');
    }
    for (const source of [
      ...prepared.servers.flatMap((server) => [server.cwd, server.source]),
      ...prepared.apps.flatMap((app) => [app.source, app.template]),
    ]) {
      if (source !== undefined && !isInside(context.projectRoot, resolve(context.projectRoot, source))) {
        throw new Error('RSC runtime prepared declaration contains a path outside the project root.');
      }
    }
  }
}
