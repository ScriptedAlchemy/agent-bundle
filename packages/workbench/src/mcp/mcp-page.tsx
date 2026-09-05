import React, { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { McpSessionBinding, McpSessionInspectorConfig, McpSessionOperation } from '../../../agent-bundle/src/contracts/mcp-session.ts';
import type { DevRuntimeMcpAppRunBinding } from '../../../agent-bundle/src/contracts/runtime.ts';
import { isRecord } from '../client-helpers.ts';

import { McpJsonInput, type ImmutableJsonRecord } from './mcp-json-input.tsx';
import {
  createMcpAppPreviewController,
  McpAppPreview,
  McpAppPreviewFrame,
  type McpAppPreviewClient,
  type McpAppPreviewController,
  type McpAppRuntimePreviewProps,
  type McpAppPreviewState,
} from './mcp-app-preview.tsx';
import type {
  McpAppConsentChallenge,
  McpAppHostContext,
  McpAppJsonValue,
  McpAppPreviewProfile,
} from './mcp-app-client.ts';
import { createMcpAppFrameRelay } from '../../../agent-bundle/src/web-host/browser/frame-relay.ts';
import { mcpInspectorDeepLink, type McpInspectorLaunchModel } from './mcp-inspector-launch-model.ts';
import type {
  McpBrowserSessionInvocation,
  McpBrowserSessionModel,
  McpBrowserSessionTimelineEntry,
} from './mcp-session-model.ts';
import type { McpSessionControllerBinding, McpSessionControllerReplay, McpSessionControllerRequest } from './mcp-session-controller.ts';
import type { RuntimeAppPreviewProps } from '../runtime-stage.tsx';
import type { RuntimeAppPreviewLifecycle } from '../runtime-playground.tsx';
import type { McpToolPrefill } from '../routes/routes-model.ts';
import {
  mcpProtocolTraceDownload,
  type McpDownload,
  type McpProtocolTraceSource,
} from './mcp-protocol-trace.ts';

import './mcp-page.css';

export interface McpPageController {
  readonly history: readonly McpBrowserSessionInvocation[];
  readonly model: McpBrowserSessionModel;
  readonly session?: Readonly<{ readonly timeoutMs: number }>;
  cancel(id: string): boolean;
  close(): Promise<void>;
  invoke(input: McpSessionControllerRequest): Promise<unknown>;
  open(binding: McpSessionBinding | McpSessionControllerBinding, timeoutMs?: number): Promise<McpBrowserSessionModel>;
  replay(input: McpSessionControllerReplay): Promise<unknown>;
  restart(): Promise<McpBrowserSessionModel>;
  subscribe(listener: (model: McpBrowserSessionModel) => void): () => void;
}

/** Launches the standalone MCP Inspector through the dev server and tracks its tokenized URL. */
export interface McpPageInspectorLaunch {
  readonly model: McpInspectorLaunchModel;
  launch(): Promise<void>;
  refresh(): Promise<void>;
  subscribe(listener: (model: McpInspectorLaunchModel) => void): () => void;
}

interface McpPageCommonProps {
  readonly controller: McpPageController;
  readonly initialBinding?: Partial<McpSessionBinding>;
  /** A validated Routes-page handoff; it selects form state but never executes a call. */
  readonly initialToolPrefill?: McpToolPrefill;
  /** Absent when the host has no Inspector launcher; the section then offers only the config download. */
  readonly inspectorLaunch?: McpPageInspectorLaunch;
  readonly onDownloadConfig?: (download: McpConfigDownload) => void;
  readonly onDownloadTrace?: (download: McpDownload) => void;
  /** Replaces the terminal controller with a fresh idle controller in the parent. */
  readonly onResetSession?: () => void;
  /** Lets the host serialize a Runtime departure through this Page's existing preview lifecycle. */
  readonly registerPreviewClose?: (close: () => Promise<void>) => () => void;
}

export type McpPageSource =
  | Readonly<{ readonly kind: 'artifact'; readonly epochOptions: readonly string[]; readonly targetOptions: readonly string[] }>
  | Readonly<{ readonly kind: 'runtime'; readonly binding: DevRuntimeMcpAppRunBinding }>;

export type McpPagePreviewSelection =
  | Readonly<{ readonly kind: 'artifact'; readonly source: McpPageAppPreviewSource }>
  | Readonly<{ readonly kind: 'runtime'; readonly preview: RuntimeAppPreviewProps; readonly binding: DevRuntimeMcpAppRunBinding }>;

type McpPageArtifactPreviewSelection = Extract<McpPagePreviewSelection, { readonly kind: 'artifact' }>;
type McpPageRuntimePreviewSelection = Extract<McpPagePreviewSelection, { readonly kind: 'runtime' }>;

export type McpPagePreviewLifecycle = RuntimeAppPreviewLifecycle;

/** The Page accepts only the two runtime dependencies its existing preview overload needs. */
export type McpPageRuntimePreviewDependencies = Pick<McpAppRuntimePreviewProps, 'client' | 'createBridgeFactory'>;

export interface McpPageArtifactProps extends McpPageCommonProps {
  /** Whether this presentation is visible and may own a live App preview. */
  readonly presentationActive?: boolean;
  /** Credential-owning foreground client; it is never passed to the sandbox frame. */
  readonly appPreviewClient?: McpAppPreviewClient;
  readonly epochOptions: readonly string[];
  readonly initialPreview?: McpPageArtifactPreviewSelection;
  readonly source?: Extract<McpPageSource, { readonly kind: 'artifact' }>;
  /** Artifact-inspected server choices are advisory defaults; operators may still enter another server name. */
  readonly serverOptions?: readonly McpPageServerOption[];
  /** Prevents an unresolved replacement catalog from reclassifying the previous catalog choice as manual input. */
  readonly serverCatalogState?: McpPageServerCatalogState;
  readonly targetOptions: readonly string[];
}

export interface McpPageServerOption {
  readonly name: string;
  readonly target: string;
}

export type McpPageServerCatalogState = 'loading' | 'ready';

export interface McpPageServerCatalog {
  readonly epochId: string;
  readonly options: readonly McpPageServerOption[];
}

export interface McpPageArtifactInspection {
  readonly epochId: string;
  readonly runtime: Readonly<{
    readonly mcpServers: readonly McpPageServerOption[];
  }>;
}

export type McpPageServerNameOrigin = 'catalog' | 'manual';

export interface McpPageBinding {
  readonly epochId: string;
  readonly serverName: string;
  readonly serverNameOrigin: McpPageServerNameOrigin;
  readonly target: string;
}

export interface McpPageBindingOptions {
  readonly epochId: string;
  readonly serverCatalogState: McpPageServerCatalogState;
  readonly serverOptions: readonly McpPageServerOption[];
  readonly sessionPhase: McpBrowserSessionModel['phase'];
  readonly targetOptions: readonly string[];
}

export interface McpPageRuntimeProps extends McpPageCommonProps {
  readonly initialPreview?: McpPageRuntimePreviewSelection;
  readonly runtimePreviewDependencies: McpPageRuntimePreviewDependencies;
  readonly source: Extract<McpPageSource, { readonly kind: 'runtime' }>;
}

/** Legacy artifact props remain source-compatible; runtime callers supply only the discriminated source. */
export type McpPageProps = McpPageArtifactProps | McpPageRuntimeProps;

export type McpConfigDownload = McpDownload;

export interface McpProtocolEvidenceProps {
  readonly ariaLabel: string;
  readonly protocol?: unknown;
  readonly trace: readonly unknown[];
}

type TraceTab = 'raw' | 'logs' | 'progress';

export interface McpPageAppPreviewSource {
  readonly input: McpAppJsonValue;
  readonly invocationId: string;
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly toolName: string;
}

export const supportedMcpAppPreviewProfiles: readonly McpAppPreviewProfile[] = Object.freeze([
  'portable',
  'chatgpt',
  'claude',
]);

export interface McpPageActionTracker {
  readonly pending: readonly string[];
  finish(action: string): void;
  isPending(action: string): boolean;
  start(action: string): boolean;
}

export interface McpPageSessionControls {
  readonly close: boolean;
  readonly open: boolean;
  readonly recovery: 'available' | 'none' | 'unavailable';
  readonly restart: boolean;
}

export interface McpPageControllerReplacementState {
  readonly actionError: undefined;
  readonly cancelledRequests: readonly string[];
  readonly pendingActions: readonly string[];
}

export interface McpPageActionRun {
  readonly action: string;
  readonly generation: number;
  readonly tracker: McpPageActionTracker;
}

export interface McpPageActionSession {
  readonly pending: readonly string[];
  finish(run: McpPageActionRun): readonly string[] | undefined;
  isCurrent(run: McpPageActionRun): boolean;
  reset(): readonly string[];
  start(action: string): McpPageActionRun | undefined;
}

type CatalogItem = Readonly<{
  readonly description?: string;
  readonly name: string;
  readonly schema?: unknown;
  /** The tool's advertised `execution.taskSupport` (MCP 2025-11-25 Tasks); absent means ordinary calls only. */
  readonly taskSupport?: McpTaskSupport;
  readonly uri?: string;
  readonly uriTemplate?: string;
}>;

type McpTaskSupport = 'forbidden' | 'optional' | 'required';

const taskSupportOf = (record: Readonly<Record<string, unknown>>): McpTaskSupport | undefined => {
  const execution = isRecord(record.execution) ? record.execution : undefined;
  const value = execution?.taskSupport;
  return value === 'forbidden' || value === 'optional' || value === 'required' ? value : undefined;
};

/** The retention the Workbench asks of a task it creates: ten minutes after the render settles. */
export const MCP_PAGE_TASK_TTL_MS = 10 * 60 * 1000;

/** One task this session created or listed, folded from the invocation history. */
export interface McpPageTask {
  readonly createdBy?: string;
  /** The JSON-RPC error `tasks/get` or `tasks/result` last answered with, when the task is gone or failed. */
  readonly error?: unknown;
  readonly progress?: Readonly<{ readonly message?: string; readonly progress: number; readonly total?: number }>;
  /** The final `CallToolResult` once `tasks/result` returned it. */
  readonly result?: unknown;
  readonly task: Readonly<Record<string, unknown>> & { readonly status: string; readonly taskId: string };
  readonly toolName?: string;
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'completed', 'failed']);

export const isTerminalMcpTask = (task: McpPageTask): boolean => TERMINAL_TASK_STATUSES.has(task.task.status);

const taskRecord = (value: unknown): McpPageTask['task'] | undefined => {
  if (!isRecord(value) || typeof value.taskId !== 'string' || typeof value.status !== 'string') return undefined;
  return value as McpPageTask['task'];
};

const taskProgress = (task: Readonly<Record<string, unknown>>): McpPageTask['progress'] => {
  const meta = isRecord(task._meta) ? task._meta : undefined;
  const progress = meta === undefined ? undefined : meta['agent-bundle/progress'];
  if (!isRecord(progress) || typeof progress.progress !== 'number') return undefined;
  return Object.freeze({
    progress: progress.progress,
    ...(typeof progress.message === 'string' ? { message: progress.message } : {}),
    ...(typeof progress.total === 'number' ? { total: progress.total } : {}),
  });
};

/**
 * Folds the invocation history into the tasks this session knows about
 * (#369): a `callToolTask` creates one, every later `getTask`, `cancelTask`,
 * `listTasks`, and `getTaskResult` answer refreshes it. Derived, never
 * stored, so the panel can never disagree with the protocol trace.
 */
export const mcpPageTasksFor = (history: readonly McpBrowserSessionInvocation[]): readonly McpPageTask[] => {
  const tasks = new Map<string, McpPageTask>();
  // A successful answer supersedes an earlier error (a tasks/result that
  // timed out while the task was still working, say), so polling resumes.
  const settled = (current: McpPageTask | undefined): Omit<McpPageTask, 'error' | 'task'> & { readonly task?: McpPageTask['task'] } => {
    if (current === undefined) return {};
    const { error: _cleared, ...rest } = current;
    return rest;
  };
  const refresh = (task: McpPageTask['task'], extra: Partial<McpPageTask> = {}): void => {
    const current = tasks.get(task.taskId);
    const { _meta: _dropped, ...bare } = task;
    tasks.set(task.taskId, Object.freeze({
      ...settled(current),
      ...extra,
      progress: taskProgress(task) ?? current?.progress,
      task: bare as McpPageTask['task'],
    }));
  };
  // Timeline order: later answers replace earlier ones.
  for (const invocation of history) {
    const request = isRecord(invocation.request) ? invocation.request : {};
    switch (invocation.operation) {
      case 'callToolTask': {
        const created = isRecord(invocation.result) ? taskRecord(invocation.result.task) : undefined;
        if (created !== undefined) refresh(created, { createdBy: invocation.id, toolName: text(request.name) });
        break;
      }
      case 'getTask':
      case 'cancelTask': {
        const task = taskRecord(invocation.result);
        if (task !== undefined) refresh(task);
        else if (invocation.error !== undefined && typeof request.taskId === 'string') {
          const current = tasks.get(request.taskId);
          if (current !== undefined) tasks.set(request.taskId, Object.freeze({ ...current, error: invocation.error }));
        }
        break;
      }
      case 'listTasks': {
        const listed = isRecord(invocation.result) && Array.isArray(invocation.result.tasks) ? invocation.result.tasks : [];
        for (const entry of listed) {
          const task = taskRecord(entry);
          if (task !== undefined) refresh(task);
        }
        break;
      }
      case 'getTaskResult': {
        if (typeof request.taskId !== 'string') break;
        const current = tasks.get(request.taskId);
        if (current === undefined) break;
        tasks.set(request.taskId, Object.freeze(invocation.error === undefined
          ? { ...settled(current), result: invocation.result, task: current.task }
          : { ...current, error: invocation.error }));
        break;
      }
      case 'callTool':
      case 'cancel':
      case 'close':
      case 'getPrompt':
      case 'initialize':
      case 'listPrompts':
      case 'listResources':
      case 'listResourceTemplates':
      case 'listTools':
      case 'readResource':
      case 'restart':
        break;
      default: {
        const unreachable: never = invocation.operation;
        throw new TypeError(`Unhandled MCP operation ${String(unreachable)}.`);
      }
    }
  }
  return Object.freeze([...tasks.values()]);
};

const runtimeBindingFields = Object.freeze([
  'definitionDigest',
  'registryRevision',
  'serverDigest',
  'serverName',
  'sessionId',
  'sessionRevision',
  'target',
  'transportDigest',
] as const);

type RuntimeBindingField = typeof runtimeBindingFields[number];
type RuntimeBindingSnapshot = Readonly<Pick<DevRuntimeMcpAppRunBinding, RuntimeBindingField>>;
type RuntimePreviewBinding = Readonly<{
  readonly appSurfaceId: string;
  readonly binding: RuntimeBindingSnapshot;
}>;

type RuntimePageAdmission = Readonly<{
  readonly binding: RuntimeBindingSnapshot;
  /** A direct Runtime navigation has authoritative binding evidence but no preview to recreate. */
  readonly selection?: Readonly<{
    readonly appSurfaceId: string;
    readonly preview: McpPageRuntimePreviewSelection;
  }>;
}>;

const runtimePreviewDiagnostic = 'Runtime App preview is unavailable because its binding evidence is invalid.';
const maximumRuntimePreviewDepth = 32;
const maximumRuntimePreviewNodes = 4_096;

const ownDataDescriptors = (value: unknown, allowNullPrototype = true): ReadonlyMap<string, PropertyDescriptor> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && (!allowNullPrototype || prototype !== null)) return undefined;
    const keys = Reflect.ownKeys(value);
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      descriptors.set(key, descriptor);
    }
    return descriptors;
  } catch {
    return undefined;
  }
};

const runtimeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4_096 && value.trim().length > 0 && !value.includes('\0');

const runtimeRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const snapshotRuntimeBinding = (value: unknown, allowNullPrototype = false): RuntimeBindingSnapshot | undefined => {
  const descriptors = ownDataDescriptors(value, allowNullPrototype);
  if (descriptors === undefined || descriptors.size !== runtimeBindingFields.length || runtimeBindingFields.some((field) => !descriptors.has(field))) return undefined;
  const values: Partial<Record<RuntimeBindingField, string | number>> = {};
  for (const field of runtimeBindingFields) {
    const descriptor = descriptors.get(field);
    if (descriptor === undefined) return undefined;
    const current = descriptor.value;
    if (field === 'registryRevision' || field === 'sessionRevision') {
      if (!runtimeRevision(current)) return undefined;
      values[field] = current;
    } else {
      if (!runtimeText(current)) return undefined;
      values[field] = current;
    }
  }
  return Object.freeze({
    definitionDigest: values.definitionDigest!,
    registryRevision: values.registryRevision!,
    serverDigest: values.serverDigest!,
    serverName: values.serverName!,
    sessionId: values.sessionId!,
    sessionRevision: values.sessionRevision!,
    target: values.target!,
    transportDigest: values.transportDigest!,
  }) as RuntimeBindingSnapshot;
};

const sameRuntimeBinding = (left: RuntimeBindingSnapshot, right: RuntimeBindingSnapshot): boolean =>
  runtimeBindingFields.every((field) => left[field] === right[field]);

const detachedRuntimeJson = (value: unknown, ancestors = new WeakSet<object>(), state = { nodes: 0 }, depth = 0): unknown | undefined => {
  state.nodes += 1;
  if (depth > maximumRuntimePreviewDepth || state.nodes > maximumRuntimePreviewNodes) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || ancestors.has(value)) return undefined;
  try {
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const arrayLength: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof arrayLength !== 'number' || !Number.isSafeInteger(arrayLength) || arrayLength < 0 || arrayLength > maximumRuntimePreviewNodes) return undefined;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== arrayLength + 1 || keys.some((key) => typeof key === 'symbol')) return undefined;
      const copy: unknown[] = [];
      for (let index = 0; index < arrayLength; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
        const child = detachedRuntimeJson(descriptor.value, ancestors, state, depth + 1);
        if (child === undefined) return undefined;
        copy.push(child);
      }
      return Object.freeze(copy);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
    const descriptors = ownDataDescriptors(value);
    if (descriptors === undefined) return undefined;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of descriptors) {
      const child = detachedRuntimeJson(descriptor.value, ancestors, state, depth + 1);
      if (child === undefined) return undefined;
      Object.defineProperty(copy, key, { configurable: false, enumerable: true, value: child, writable: false });
    }
    return Object.freeze(copy);
  } catch {
    return undefined;
  } finally {
    ancestors.delete(value);
  }
};

const canonicalRuntimeResourceUri = (value: unknown): value is string => {
  if (!runtimeText(value)) return false;
  try {
    const uri = new URL(value);
    return uri.protocol === 'ui:' && uri.hostname.length > 0 && uri.href === value;
  } catch {
    return false;
  }
};

/** Public App surface IDs are canonical server-side client-surface locators, not invocation surface IDs. */
const canonicalRuntimeClientSurfaceId = (value: unknown): value is string =>
  runtimeText(value) && /^mcp\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(value);

const preparedRuntimePreview = (value: unknown): RuntimeAppPreviewProps | undefined => {
  const descriptors = ownDataDescriptors(value, false);
  if (descriptors === undefined) return undefined;
  const profile = detachedRuntimeJson(descriptors.get('profile')?.value);
  const profileId = descriptors.get('profileId')?.value;
  const run = detachedRuntimeJson(descriptors.get('run')?.value);
  const surface = detachedRuntimeJson(descriptors.get('surface')?.value);
  if (profile === undefined || run === undefined || surface === undefined || !runtimeText(profileId)) return undefined;
  return Object.freeze({
    profile: profile as RuntimeAppPreviewProps['profile'],
    profileId,
    run: run as RuntimeAppPreviewProps['run'],
    surface: surface as RuntimeAppPreviewProps['surface'],
  });
};

const runtimePreviewBinding = (preview: RuntimeAppPreviewProps): RuntimePreviewBinding | undefined => {
  const run = ownDataDescriptors(preview.run);
  const surface = ownDataDescriptors(preview.surface);
  if (run === undefined || surface === undefined || run.get('status')?.value !== 'succeeded') return undefined;
  const result = ownDataDescriptors(run.get('result')?.value);
  const app = result === undefined ? undefined : ownDataDescriptors(result.get('app')?.value);
  if (app === undefined) return undefined;
  const appBinding = snapshotRuntimeBinding(app.get('mcpBinding')?.value, true);
  const appSurfaceId = app.get('surfaceId')?.value;
  const runSurfaceId = run.get('surfaceId')?.value;
  const surfaceId = surface.get('id')?.value;
  const resourceUri = app.get('resourceUri')?.value;
  if (appBinding === undefined || !canonicalRuntimeClientSurfaceId(appSurfaceId) || !runtimeText(runSurfaceId) || runSurfaceId !== surfaceId || !canonicalRuntimeResourceUri(resourceUri)) return undefined;
  return Object.freeze({ appSurfaceId, binding: appBinding });
};

const admitRuntimePage = (source: unknown, selection: unknown): RuntimePageAdmission | undefined => {
  const sourceDescriptors = ownDataDescriptors(source, false);
  if (sourceDescriptors?.get('kind')?.value !== 'runtime') return undefined;
  const sourceBinding = snapshotRuntimeBinding(sourceDescriptors.get('binding')?.value);
  if (sourceBinding === undefined) return undefined;
  if (selection === undefined) return Object.freeze({ binding: sourceBinding });

  const selectionDescriptors = ownDataDescriptors(selection, false);
  if (selectionDescriptors?.get('kind')?.value !== 'runtime') return undefined;
  const selectionBinding = snapshotRuntimeBinding(selectionDescriptors.get('binding')?.value);
  const preview = preparedRuntimePreview(selectionDescriptors.get('preview')?.value);
  const app = preview === undefined ? undefined : runtimePreviewBinding(preview);
  if (selectionBinding === undefined || preview === undefined || app === undefined) return undefined;
  if (!sameRuntimeBinding(sourceBinding, selectionBinding) || !sameRuntimeBinding(sourceBinding, app.binding)) return undefined;
  return Object.freeze({
    binding: sourceBinding,
    selection: Object.freeze({
      appSurfaceId: app.appSurfaceId,
      preview: Object.freeze({ binding: sourceBinding, kind: 'runtime', preview }),
    }),
  });
};

const traceTabs: readonly TraceTab[] = ['raw', 'logs', 'progress'];

const noMcpPageServerOptions: readonly McpPageServerOption[] = Object.freeze([]);

const frozenMcpPageServerOptionsFor = (options: readonly McpPageServerOption[]): readonly McpPageServerOption[] => Object.freeze(
  options.map((option) => Object.freeze({ name: option.name, target: option.target })),
);

/** Keeps only the immutable artifact servers that the selected generated target can start. */
export const mcpPageServerOptionsFor = (
  options: readonly McpPageServerOption[],
  target: string,
): readonly McpPageServerOption[] => frozenMcpPageServerOptionsFor(options.filter((option) => option.target === target));

const mcpPageTargetFor = (target: string, options: readonly string[]): string =>
  options.includes(target) ? target : options[0] ?? '';

const mcpPageCatalogServerNameFor = (
  serverName: string,
  options: readonly McpPageServerOption[],
): string => options.some((option) => option.name === serverName) ? serverName : options[0]?.name ?? '';

/** Replaces only a stale catalog-backed name, retaining arbitrary operator-entered names for the datalist input. */
export const mcpPageServerNameFor = (
  serverName: string,
  options: readonly McpPageServerOption[],
  allOptions: readonly McpPageServerOption[],
): string => {
  if (options.some((option) => option.name === serverName)) return serverName;
  if (serverName.length > 0 && !allOptions.some((option) => option.name === serverName)) return serverName;
  return options[0]?.name ?? '';
};

/** Publishes an immutable catalog only when the completed inspection still belongs to the active epoch. */
export const mcpPageServerCatalogFor = (
  epochId: string,
  inspection: McpPageArtifactInspection,
  signal: Pick<AbortSignal, 'aborted'>,
): McpPageServerCatalog | undefined => {
  if (signal.aborted || inspection.epochId !== epochId) return undefined;
  return Object.freeze({ epochId, options: frozenMcpPageServerOptionsFor(inspection.runtime.mcpServers) });
};

/** Settles a current failed inspection without retaining suggestions from a previous artifact epoch. */
export const mcpPageEmptyServerCatalogFor = (
  epochId: string,
  signal: Pick<AbortSignal, 'aborted'>,
): McpPageServerCatalog | undefined => signal.aborted
  ? undefined
  : Object.freeze({ epochId, options: noMcpPageServerOptions });

const sameMcpPageBinding = (left: McpPageBinding, right: McpPageBinding): boolean =>
  left.epochId === right.epochId
  && left.serverName === right.serverName
  && left.serverNameOrigin === right.serverNameOrigin
  && left.target === right.target;

/** Rebinds only an idle form, preserving typed server names across active artifact rebuilds. */
export const mcpPageBindingFor = (
  binding: McpPageBinding,
  options: McpPageBindingOptions,
): McpPageBinding => {
  if (options.sessionPhase !== 'idle') return binding;
  const epochChanged = binding.epochId !== options.epochId;
  const target = epochChanged ? options.targetOptions[0] ?? '' : mcpPageTargetFor(binding.target, options.targetOptions);
  if (options.serverCatalogState === 'loading') {
    return Object.freeze({ ...binding, epochId: options.epochId, target });
  }
  const targetServerOptions = mcpPageServerOptionsFor(options.serverOptions, target);
  return Object.freeze({
    ...binding,
    epochId: options.epochId,
    serverName: binding.serverNameOrigin === 'manual'
      ? binding.serverName
      : mcpPageCatalogServerNameFor(binding.serverName, targetServerOptions),
    target,
  });
};

/** Rejects submit-time races unless the form still matches a ready catalog binding. */
export const mcpPageOpenBindingFor = (
  binding: McpPageBinding,
  options: McpPageBindingOptions,
): McpSessionBinding | undefined => {
  if (options.serverCatalogState !== 'ready' || options.sessionPhase !== 'idle') return undefined;
  const canonical = mcpPageBindingFor(binding, options);
  if (!sameMcpPageBinding(binding, canonical) || canonical.epochId.length === 0 || canonical.serverName.length === 0 || canonical.target.length === 0) {
    return undefined;
  }
  return Object.freeze({ epochId: canonical.epochId, serverName: canonical.serverName, target: canonical.target });
};

export const createMcpPageActionTracker = (): McpPageActionTracker => {
  const pending = new Set<string>();
  return {
    get pending(): readonly string[] {
      return [...pending];
    },
    finish: (action) => { pending.delete(action); },
    isPending: (action) => pending.has(action),
    start: (action) => {
      if (pending.has(action)) return false;
      pending.add(action);
      return true;
    },
  };
};

export const createMcpPageActionSession = (): McpPageActionSession => {
  let generation = 0;
  let tracker = createMcpPageActionTracker();
  const isCurrent = (run: McpPageActionRun): boolean => run.generation === generation && run.tracker === tracker;
  return {
    get pending(): readonly string[] {
      return tracker.pending;
    },
    finish: (run) => {
      if (!isCurrent(run)) return undefined;
      tracker.finish(run.action);
      return tracker.pending;
    },
    isCurrent,
    reset: () => {
      generation += 1;
      tracker = createMcpPageActionTracker();
      return tracker.pending;
    },
    start: (action) => {
      if (!tracker.start(action)) return undefined;
      return { action, generation, tracker };
    },
  };
};

export const mcpPageControllerReplacementState = (): McpPageControllerReplacementState => ({
  actionError: undefined,
  cancelledRequests: [],
  pendingActions: [],
});

export const mcpPageSessionControls = (
  phase: McpBrowserSessionModel['phase'],
  pending: readonly string[],
  hasReset: boolean,
  serverCatalogState: McpPageServerCatalogState = 'ready',
): McpPageSessionControls => {
  const isPending = (action: string): boolean => pending.includes(action);
  const terminal = phase === 'closed' || phase === 'error';
  return {
    close: !terminal && !isPending('close') && (phase === 'opening' || phase === 'ready' || phase === 'restarting' || isPending('open') || isPending('restart')),
    open: phase === 'idle' && serverCatalogState === 'ready' && !isPending('open'),
    recovery: terminal ? hasReset ? 'available' : 'unavailable' : 'none',
    restart: phase === 'ready' && !isPending('restart'),
  };
};

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

const browserMcpAppHost = (): McpAppHostContext => {
  const browser = typeof window === 'undefined' ? undefined : window;
  const locale = browser?.navigator.language;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Object.freeze({
    availableDisplayModes: Object.freeze(['inline']),
    containerDimensions: Object.freeze({ height: Math.max(0, browser?.innerHeight ?? 0), width: Math.max(0, browser?.innerWidth ?? 0) }),
    deviceCapabilities: Object.freeze({}),
    displayMode: 'inline',
    locale: typeof locale === 'string' && locale.length > 0 ? locale : 'en',
    platform: 'web',
    safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
    styles: Object.freeze({}),
    theme: browser?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    timeZone: typeof timeZone === 'string' && timeZone.length > 0 ? timeZone : 'UTC',
    userAgent: browser?.navigator.userAgent ?? 'unknown',
  });
};

export const mcpAppPreviewSourceFor = (
  session: Pick<McpBrowserSessionModel, 'phase' | 'sessionId'>,
  invocation: McpBrowserSessionInvocation,
): McpPageAppPreviewSource | undefined => {
  if (session.phase !== 'ready' || invocation.operation !== 'callTool' || invocation.error !== undefined || invocation.result === undefined) {
    return undefined;
  }
  const request = isRecord(invocation.request) ? invocation.request : undefined;
  const toolName = request === undefined ? undefined : text(request.name);
  if (toolName === undefined || request === undefined || !Object.hasOwn(request, 'arguments')) return undefined;
  return Object.freeze({
    input: request.arguments as McpAppJsonValue,
    invocationId: invocation.id,
    result: invocation.result as McpAppJsonValue,
    sessionId: session.sessionId,
    toolName,
  });
};

const catalogItems = (catalog: readonly unknown[], fallback: string): readonly CatalogItem[] =>
  catalog.map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const taskSupport = taskSupportOf(record);
    return {
      description: text(record.description),
      name: text(record.name) ?? `${fallback} ${index + 1}`,
      schema: record.inputSchema ?? record.argumentsSchema,
      ...(taskSupport === undefined ? {} : { taskSupport }),
      uri: text(record.uri),
      uriTemplate: text(record.uriTemplate),
    };
  });

const formattedJson = new WeakMap<object, string>();

const prettyJson = (value: object): string => {
  const cached = formattedJson.get(value);
  if (cached !== undefined) return cached;
  const formatted = JSON.stringify(value, null, 2) ?? String(value);
  formattedJson.set(value, formatted);
  return formatted;
};

const display = (value: unknown): string => {
  try {
    if (value !== null && typeof value === 'object') return prettyJson(value);
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[Unserializable protocol value]';
  }
};

const consentDetailLimit = 480;
const consentDetailDepthLimit = 3;
const consentDetailEntryLimit = 8;
const sensitiveConsentDetail = /(?:api[_-]?key|authorization|bearer|cookie|credential|pass(?:word)?|private[_-]?key|secret|token)/iu;

const boundedConsentText = (value: unknown, maximum = 160): string | undefined => {
  if (typeof value !== 'string') return undefined;
  if (sensitiveConsentDetail.test(value)) return '[redacted]';
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
  }).join('');
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
};

/**
 * Formats only bounded, finite JSON consent context for a React text node.
 * It never follows accessors and redacts common credential-bearing names/values.
 */
const redactedConsentJson = (value: unknown, depth = 0, ancestors = new WeakSet<object>()): string | undefined => {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'string') {
    const textValue = boundedConsentText(value);
    return textValue === undefined ? undefined : JSON.stringify(textValue);
  }
  if (typeof value !== 'object' || depth >= consentDetailDepthLimit || ancestors.has(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return undefined;
    ancestors.add(value);
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let index = 0; index < Math.min(value.length, consentDetailEntryLimit); index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const entry = descriptor === undefined || !Object.hasOwn(descriptor, 'value')
          ? '[withheld]'
          : redactedConsentJson(descriptor.value, depth + 1, ancestors);
        if (entry === undefined) return undefined;
        parts.push(entry);
      }
      if (value.length > consentDetailEntryLimit) parts.push('…');
      return `[${parts.join(', ')}]`;
    }
    const parts: string[] = [];
    for (const key of Object.keys(value).sort().slice(0, consentDetailEntryLimit)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return undefined;
      const entry = sensitiveConsentDetail.test(key) ? '"[redacted]"' : redactedConsentJson(descriptor.value, depth + 1, ancestors);
      if (entry === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}: ${entry}`);
    }
    if (Object.keys(value).length > consentDetailEntryLimit) parts.push('…');
    return `{${parts.join(', ')}}`;
  } catch {
    return undefined;
  } finally {
    ancestors.delete(value as object);
  }
};

const boundedConsentSummary = (value: string): string =>
  value.length <= consentDetailLimit ? value : `${value.slice(0, consentDetailLimit - 1)}…`;

const publicQueryKeys = (values: Iterable<unknown>): readonly string[] => {
  const keys = new Set<string>();
  let inspected = 0;
  for (const value of values) {
    if (inspected >= consentDetailEntryLimit * 4 || keys.size >= consentDetailEntryLimit) break;
    inspected += 1;
    keys.add(boundedConsentText(value, 48) ?? '[redacted]');
  }
  return [...keys].sort();
};

const externalLinkTarget = (details: Readonly<Record<string, unknown>>): Readonly<{ readonly queryKeys: readonly string[]; readonly target: string }> | undefined => {
  if (typeof details.target === 'string') {
    const target = boundedConsentText(details.target, 240);
    return target === undefined ? undefined : Object.freeze({ queryKeys: Object.freeze(publicQueryKeys(Array.isArray(details.queryKeys) ? details.queryKeys : [])), target });
  }
  if (typeof details.url !== 'string') return undefined;
  try {
    const target = new URL(details.url);
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username.length > 0 || target.password.length > 0) return undefined;
    const visibleTarget = boundedConsentText(`${target.protocol}//${target.host}${target.pathname}`, 240);
    if (visibleTarget === undefined) return undefined;
    const queryKeys = publicQueryKeys(target.searchParams.keys());
    return Object.freeze({ queryKeys: Object.freeze(queryKeys), target: visibleTarget });
  } catch {
    return undefined;
  }
};

const base64ByteLength = (value: string): number | undefined => {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return undefined;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
};

const contentByteLength = (content: unknown): number | undefined => {
  if (!isRecord(content) || typeof content.type !== 'string') return undefined;
  if (content.type === 'text') return typeof content.text === 'string' ? new TextEncoder().encode(content.text).byteLength : undefined;
  if (content.type === 'image' || content.type === 'audio') return typeof content.data === 'string' ? base64ByteLength(content.data) : undefined;
  if (content.type === 'resource') {
    if (!isRecord(content.resource)) return undefined;
    if (typeof content.resource.text === 'string') return new TextEncoder().encode(content.resource.text).byteLength;
    return typeof content.resource.blob === 'string' ? base64ByteLength(content.resource.blob) : undefined;
  }
  return content.type === 'resource_link' && typeof content.size === 'number' && Number.isSafeInteger(content.size) && content.size >= 0
    ? content.size
    : undefined;
};

const publicDownloadItems = (details: Readonly<Record<string, unknown>>): readonly string[] | undefined => {
  if (Array.isArray(details.items)) return details.items.slice(0, consentDetailEntryLimit).map((entry, index) => {
    const type = isRecord(entry) ? boundedConsentText(entry.type, 48) ?? 'unspecified' : 'unspecified';
    const bytes = isRecord(entry) && typeof entry.bytes === 'number' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 ? entry.bytes : undefined;
    return `${index + 1}: ${type} ${bytes === undefined ? 'size unavailable' : `${bytes} B`}`;
  });
  const contents = Array.isArray(details.contents) ? details.contents : undefined;
  if (contents === undefined) return undefined;
  return contents.slice(0, consentDetailEntryLimit).map((entry, index) => {
    const type = isRecord(entry) ? boundedConsentText(entry.type, 48) ?? 'unspecified' : 'unspecified';
    const bytes = contentByteLength(entry);
    return `${index + 1}: ${type} ${bytes === undefined ? 'size unavailable' : `${bytes} B`}`;
  });
};

const actionFingerprint = (request: Readonly<Record<string, unknown>>): string | undefined =>
  typeof request.actionFingerprint === 'string' && /^act-[A-Za-z0-9_-]{12}$/u.test(request.actionFingerprint)
    ? request.actionFingerprint
    : undefined;

/** A capability-specific, bounded and credential-safe explanation of a server challenge. */
export const mcpAppConsentDetailsSummary = (request: unknown): string => {
  if (!isRecord(request) || !isRecord(request.details) || typeof request.capability !== 'string') return 'Details unavailable.';
  const details = request.details;
  let summary: string;
  switch (request.capability) {
    case 'call-tool': {
      const name = boundedConsentText(details.name, 120);
      const argumentsSummary = redactedConsentJson(details.arguments);
      summary = name === undefined ? 'Tool details unavailable.' : `Tool: ${name}${argumentsSummary === undefined ? '' : `; arguments: ${argumentsSummary}`}`;
      break;
    }
    case 'open-external-link': {
      const target = externalLinkTarget(details);
      summary = target === undefined
        ? 'External link target unavailable.'
        : `External link: ${target.target}${target.queryKeys.length === 0 ? '' : `; query keys: ${target.queryKeys.join(', ')}`}`;
      break;
    }
    case 'download-file': {
      const items = publicDownloadItems(details);
      const itemCount = typeof details.itemCount === 'number' && Number.isSafeInteger(details.itemCount) && details.itemCount >= 0
        ? details.itemCount
        : Array.isArray(details.contents) ? details.contents.length : undefined;
      if (items === undefined || itemCount === undefined) {
        summary = 'Download details unavailable.';
        break;
      }
      summary = `Download ${itemCount} file${itemCount === 1 ? '' : 's'}${items.length === 0 ? '' : ` (${items.join(', ')})`}.`;
      break;
    }
    case 'request-display-mode': {
      const mode = boundedConsentText(details.mode, 80);
      summary = mode === undefined ? 'Display mode details unavailable.' : `Display mode: ${mode}`;
      break;
    }
    default: {
      const value = redactedConsentJson(details);
      summary = value === undefined ? 'Details unavailable.' : `Request details: ${value}`;
    }
  }
  const fingerprint = actionFingerprint(request);
  return boundedConsentSummary(`${summary}${fingerprint === undefined ? '' : `; action reference: ${fingerprint}`}`);
};

/** Read-only provider evidence shared by the live MCP page and Runtime Inspector. */
export const McpProtocolEvidence = ({ ariaLabel, protocol, trace }: McpProtocolEvidenceProps): React.ReactNode => <section aria-label={ariaLabel} className="mcp-page-trace">
  <h3>{ariaLabel}</h3>
  {protocol === undefined ? undefined : <details open><summary>Protocol</summary><pre><code>{display(protocol)}</code></pre></details>}
  {trace.length === 0 ? <p className="mcp-page-empty">No protocol evidence yet.</p> : <ol>{trace.map((entry, index) => <li key={index}><pre><code>{display(entry)}</code></pre></li>)}</ol>}
</section>;

const errorMessage = (reason: unknown): string => reason instanceof Error ? reason.message : 'The MCP session action failed.';

const connectionSummary = (connection: McpBrowserSessionModel['connection']): string => {
  if (connection === undefined) return 'No negotiated connection.';
  const server = isRecord(connection.serverInfo) ? text(connection.serverInfo.name) : undefined;
  return [connection.protocolVersion === undefined ? undefined : `Protocol ${connection.protocolVersion}`, server]
    .filter((value): value is string => value !== undefined)
    .join(' · ') || 'Connection negotiated.';
};

export const mcpConfigDownload = (config: McpSessionInspectorConfig, sessionId: string): McpConfigDownload => ({
  blob: new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: 'application/json' }),
  filename: `mcp-${sessionId}-inspector.json`,
});

export const downloadCurrentMcpProtocolTrace = (
  onDownload: ((download: McpDownload) => void) | undefined,
  source: McpProtocolTraceSource,
): void => {
  if (onDownload !== undefined) onDownload(mcpProtocolTraceDownload(source));
};

const environmentEntries = (environment: Readonly<Record<string, string>>): ReadonlyArray<readonly [string, string]> =>
  Object.entries(environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

const McpLaunchConfiguration = ({ config }: { readonly config: McpSessionInspectorConfig | undefined }) => {
  if (config === undefined) return <section aria-labelledby="mcp-launch-configuration-heading" className="mcp-page-launch-configuration">
    <h3 id="mcp-launch-configuration-heading">Launch configuration</h3>
    <p className="mcp-page-empty">No launch configuration is available for this session.</p>
  </section>;

  if (config.launch.kind === 'streamable-http') return <section aria-labelledby="mcp-launch-configuration-heading" className="mcp-page-launch-configuration">
    <h3 id="mcp-launch-configuration-heading">Launch configuration</h3>
    <dl>
      <div><dt>Transport</dt><dd>streamable-http</dd></div>
      <div><dt>URL</dt><dd><code>{config.launch.url}</code></dd></div>
    </dl>
  </section>;

  const environment = environmentEntries(config.launch.env);
  return <section aria-labelledby="mcp-launch-configuration-heading" className="mcp-page-launch-configuration">
    <h3 id="mcp-launch-configuration-heading">Launch configuration</h3>
    <dl>
      <div><dt>Transport</dt><dd>stdio</dd></div>
      <div><dt>Command</dt><dd><code>{config.launch.command}</code></dd></div>
      <div><dt>Arguments</dt><dd>{config.launch.args.length === 0
        ? <span className="mcp-page-empty">No arguments specified.</span>
        : <ol aria-label="Launch arguments">{config.launch.args.map((argument, index) => <li key={`${argument}-${index}`}><code>{argument}</code></li>)}</ol>}</dd></div>
      <div><dt>Working directory</dt><dd><code>{config.launch.cwd ?? 'Not specified'}</code></dd></div>
      <div><dt>Environment</dt><dd>{environment.length === 0
        ? <span className="mcp-page-empty">No environment variables specified.</span>
        : <ul aria-label="Launch environment">{environment.map(([name, value]) => <li key={name}><code>{name}</code><span aria-hidden="true">=</span><code>{value}</code></li>)}</ul>}</dd></div>
    </dl>
  </section>;
};

const catalogList = (label: string, items: readonly CatalogItem[], action?: (item: CatalogItem) => void) => <section className="mcp-page-catalog" aria-label={label}>
  <h3>{label}</h3>
  {items.length === 0 ? <p className="mcp-page-empty">No {label.toLowerCase()} were advertised.</p> : <ol>
    {items.map((item, index) => <li key={`${item.name}-${index}`}>
      <div>
        <strong>{item.name}</strong>
        {item.description === undefined ? undefined : <p>{item.description}</p>}
        {item.uri === undefined ? undefined : <code>{item.uri}</code>}
        {item.uriTemplate === undefined ? undefined : <code>{item.uriTemplate}</code>}
      </div>
      {action === undefined ? undefined : <button onClick={() => action(item)} type="button">Read {item.uri ?? item.name}</button>}
    </li>)}
  </ol>}
</section>;

const traceValue = (entry: McpBrowserSessionTimelineEntry): unknown => {
  if ('type' in entry && entry.type === 'replay.gap') return entry;
  if ('type' in entry && entry.type === 'invocation') return entry.invocation;
  return entry;
};

interface McpPageAppPreviewProps {
  readonly artifactClient?: McpAppPreviewClient;
  readonly host: McpAppHostContext;
  readonly onLifecycleChange: (lifecycle: McpPagePreviewLifecycle | undefined, current?: McpPagePreviewLifecycle) => void;
  readonly previewProfile: McpAppPreviewProfile;
  readonly runtimePreviewDependencies?: McpPageRuntimePreviewDependencies;
  readonly selection: McpPagePreviewSelection;
}

interface McpPageArtifactPreviewProps {
  readonly client: McpAppPreviewClient;
  readonly host: McpAppHostContext;
  readonly onLifecycleChange: (lifecycle: McpPagePreviewLifecycle | undefined, current?: McpPagePreviewLifecycle) => void;
  readonly previewProfile: McpAppPreviewProfile;
  readonly source: McpPageAppPreviewSource;
}

const previewProfileName = (state: McpAppPreviewState, fallback: McpAppPreviewProfile): string => {
  if (state.phase !== 'ready' && state.phase !== 'fallback') return fallback;
  const profile = isRecord(state.preview.profile) ? text(state.preview.profile.profile) : undefined;
  return profile ?? fallback;
};

const McpPageRuntimeAppPreview = ({ dependencies, onLifecycleChange, preview }: Readonly<{
  readonly dependencies: McpPageRuntimePreviewDependencies;
  readonly onLifecycleChange: McpPageArtifactPreviewProps['onLifecycleChange'];
  readonly preview: RuntimeAppPreviewProps;
}>) => {
  const registerLifecycle = (lifecycle: McpPagePreviewLifecycle): (() => void) => {
    onLifecycleChange(lifecycle);
    // Parent unmount cleanup must join this exact handle before a child effect
    // can release the Page ref. The guarded microtask also makes late old
    // unregisters inert after a replacement has installed its own lifecycle.
    return () => { queueMicrotask(() => onLifecycleChange(undefined, lifecycle)); };
  };
  return <section className="mcp-page-app-preview">
    <McpAppPreview
      {...preview}
      client={dependencies.client}
      createBridgeFactory={dependencies.createBridgeFactory}
      kind="runtime"
      registerLifecycle={registerLifecycle}
    />
  </section>;
};

/** Page-owned artifact composition keeps the approved preview close promise ahead of session teardown. */
const McpPageArtifactPreview = ({ client, host, onLifecycleChange, previewProfile, source }: McpPageArtifactPreviewProps) => {
  const [state, setState] = useState<McpAppPreviewState>(() => Object.freeze({ phase: 'loading' }));
  const [consentChallenges, setConsentChallenges] = useState<readonly McpAppConsentChallenge[]>(Object.freeze([]));
  const [consentPending, setConsentPending] = useState<string>();
  const [blankBarrier, setBlankBarrier] = useState<number>();
  const controller = useRef<McpAppPreviewController | undefined>(undefined);
  const iframe = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const current = createMcpAppPreviewController({
      client,
      frameRelayFactory: createMcpAppFrameRelay,
      host,
      input: source.input,
      previewProfile,
      result: source.result,
      sessionId: source.sessionId,
      toolName: source.toolName,
    });
    controller.current = current;
    onLifecycleChange(current);
    const unsubscribe = current.subscribe(setState);
    let active = true;
    // The poll ticks constantly; keeping the previous array reference when the
    // challenge set is unchanged avoids re-rendering the preview 4x/second.
    const sameChallenges = (left: readonly McpAppConsentChallenge[], right: readonly McpAppConsentChallenge[]): boolean =>
      left.length === right.length &&
      left.every((challenge, index) => challenge.id === right[index]?.id && challenge.expiresAt === right[index]?.expiresAt);
    const refreshConsent = async (): Promise<void> => {
      try {
        const challenges = await current.consentChallenges();
        if (active) setConsentChallenges((previous) => sameChallenges(previous, challenges) ? previous : challenges);
      } catch {
        if (active) setConsentChallenges((previous) => previous.length === 0 ? previous : Object.freeze([]));
      }
    };
    void current.start().then(refreshConsent);
    const poll = setInterval(() => { void refreshConsent(); }, 250);
    return () => {
      active = false;
      clearInterval(poll);
      unsubscribe();
      if (controller.current === current) controller.current = undefined;
      queueMicrotask(() => onLifecycleChange(undefined, current));
      void current.close();
    };
  }, [client, host, onLifecycleChange, previewProfile, source]);

  useEffect(() => {
    if (blankBarrier !== undefined || state.phase !== 'ready' || iframe.current === null || typeof window === 'undefined') return;
    controller.current?.attachFrame(iframe.current, window);
  }, [blankBarrier, state]);

  useEffect(() => {
    if (blankBarrier === undefined) return;
    controller.current?.commitDocumentRemount(blankBarrier);
    setBlankBarrier(undefined);
  }, [blankBarrier]);

  const decideConsent = (challenge: McpAppConsentChallenge, approved: boolean): void => {
    const current = controller.current;
    if (current === undefined || consentPending !== undefined) return;
    const previousRevision = current.state.phase === 'ready' ? current.state.preview.frame?.documentPolicy?.revision : undefined;
    setConsentPending(challenge.id);
    void current.decideConsent(challenge.id, approved).then(async (accepted) => {
      if (!accepted) return;
      const nextRevision = current.pendingDocumentPolicyRevision;
      if (previousRevision !== nextRevision) {
        if (nextRevision !== undefined) setBlankBarrier(nextRevision);
      }
      try {
        setConsentChallenges(await current.consentChallenges());
      } catch {
        setConsentChallenges(Object.freeze([]));
      }
    }).catch(() => undefined).finally(() => { setConsentPending(undefined); });
  };

  const fallback = state.phase === 'fallback' || state.phase === 'error' ? state.fallback : undefined;
  return <section aria-busy={state.phase === 'loading'} aria-label="MCP App preview" className="mcp-page-app-preview">
    <header>
      <h3>MCP App preview</h3>
      <dl><div><dt>Profile</dt><dd>{previewProfileName(state, previewProfile)}</dd></div></dl>
    </header>
    {state.phase === 'loading' ? <p role="status">Creating MCP App preview…</p> : undefined}
    {state.phase === 'error' ? <p role="alert">{state.message}</p> : undefined}
    {fallback === undefined ? undefined : <section aria-label="MCP App fallback" className="mcp-page-app-fallback">
      <p role="status">Interactive App rendering is unavailable ({fallback.reason}). Showing the ordinary tool result instead.</p>
      <details open><summary>Tool input</summary><pre><code>{display(fallback.input)}</code></pre></details>
      <details open><summary>Tool result</summary><pre><code>{display(fallback.result)}</code></pre></details>
    </section>}
    {consentChallenges.length === 0 ? undefined : <section aria-label="MCP App consent">
      <h4>App permission requests</h4>
      <ol>{consentChallenges.map((challenge) => <li key={challenge.id}>
        <p>{isRecord(challenge.request) && typeof challenge.request.summary === 'string'
          ? challenge.request.summary
          : 'Allow this MCP App action?'}</p>
        <p><strong>Details:</strong> {mcpAppConsentDetailsSummary(challenge.request)}</p>
        <button disabled={consentPending !== undefined} onClick={() => { decideConsent(challenge, true); }} type="button">Allow {isRecord(challenge.request) && typeof challenge.request.capability === 'string' ? challenge.request.capability.replaceAll('-', ' ') : 'action'}</button>
        <button disabled={consentPending !== undefined} onClick={() => { decideConsent(challenge, false); }} type="button">Deny</button>
      </li>)}</ol>
    </section>}
    {state.phase === 'ready' && state.preview.frame !== undefined
      ? blankBarrier !== undefined
        ? <iframe data-mcp-app-document-revision={blankBarrier} key={`blank:${blankBarrier}`} ref={iframe} sandbox="" src="about:blank" title={`MCP App preview reload barrier: ${source.toolName}`} />
        : <McpAppPreviewFrame key={state.preview.frame.documentPolicy?.revision ?? 0} frame={state.preview.frame} iframeRef={iframe} title={`MCP App preview: ${source.toolName}`} />
      : undefined}
  </section>;
};

/** The Page retains one preview placement while dispatching its artifact and runtime overloads. */
const McpPageAppPreview = ({ artifactClient, host, onLifecycleChange, previewProfile, runtimePreviewDependencies, selection }: McpPageAppPreviewProps) => {
  if (selection.kind === 'runtime') {
    if (runtimePreviewDependencies === undefined) return null;
    return <McpPageRuntimeAppPreview
      dependencies={runtimePreviewDependencies}
      onLifecycleChange={onLifecycleChange}
      preview={selection.preview}
    />;
  }
  if (artifactClient === undefined) return null;
  return <McpPageArtifactPreview
    client={artifactClient}
    host={host}
    onLifecycleChange={onLifecycleChange}
    previewProfile={previewProfile}
    source={selection.source}
  />;
};

const mcpPageInspectorControl = (
  inspectorLaunch: McpPageInspectorLaunch,
  inspectorModel: McpInspectorLaunchModel,
  config: McpSessionInspectorConfig | undefined,
): React.ReactElement => {
  const launchButton = <button onClick={() => { void inspectorLaunch.launch(); }} type="button">Open MCP Inspector</button>;
  switch (inspectorModel.phase) {
    case 'ready':
      // The click still navigates; the refresh only re-syncs a link the server has since invalidated.
      return inspectorModel.url === undefined
        ? launchButton
        : <a
            className="mcp-page-inspector-link"
            href={mcpInspectorDeepLink(inspectorModel.url, config)}
            onClick={() => { void inspectorLaunch.refresh(); }}
            rel="noopener noreferrer"
            target="_blank"
          >Open MCP Inspector in a new tab</a>;
    case 'starting':
      return <button disabled type="button">Starting MCP Inspector…</button>;
    case 'idle':
    case 'error':
      return launchButton;
    default: {
      const exhaustive: never = inspectorModel.phase;
      throw new TypeError(`Unknown MCP Inspector launch phase: ${String(exhaustive)}`);
    }
  }
};

const mcpPageInspectorStatusLine = (
  inspectorModel: McpInspectorLaunchModel,
  config: McpSessionInspectorConfig | undefined,
): React.ReactElement | undefined => {
  switch (inspectorModel.phase) {
    case 'starting':
      return <p className="mcp-page-inspector-status" role="status">Starting the MCP Inspector. The first launch downloads @modelcontextprotocol/inspector and can take up to 30 seconds.</p>;
    case 'error':
      return inspectorModel.diagnostic === undefined
        ? undefined
        : <p className="mcp-page-inspector-error" role="alert"><strong>{inspectorModel.diagnostic.code}</strong> {inspectorModel.diagnostic.message}</p>;
    case 'ready':
      if (config === undefined) return undefined;
      return config.launch.kind === 'streamable-http'
        ? <p className="mcp-page-inspector-status">The link pre-connects the Inspector to <code>{config.launch.url}</code>.</p>
        : <p className="mcp-page-inspector-status">Inspector 2.x does not start a stdio server from a link; add this session’s command and arguments inside the Inspector. The downloaded config carries the same values.</p>;
    case 'idle':
      return undefined;
    default: {
      const exhaustive: never = inspectorModel.phase;
      throw new TypeError(`Unknown MCP Inspector launch phase: ${String(exhaustive)}`);
    }
  }
};

export const McpPage = (props: McpPageProps) => {
  const { controller, initialBinding, initialPreview, initialToolPrefill, inspectorLaunch, onDownloadConfig, onDownloadTrace, onResetSession, registerPreviewClose } = props;
  const runtimeProps: McpPageRuntimeProps | undefined = 'runtimePreviewDependencies' in props ? props : undefined;
  const artifactProps: McpPageArtifactProps | undefined = 'runtimePreviewDependencies' in props ? undefined : props;
  const [runtimeAdmission] = useState<RuntimePageAdmission | undefined>(() => runtimeProps === undefined
    ? undefined
    : admitRuntimePage(runtimeProps.source, runtimeProps.initialPreview));
  const runtimeSource = runtimeAdmission?.binding;
  const artifactSource = artifactProps?.source ?? (artifactProps === undefined
    ? undefined
    : Object.freeze({ epochOptions: artifactProps.epochOptions, kind: 'artifact' as const, targetOptions: artifactProps.targetOptions }));
  const appPreviewClient = artifactProps?.appPreviewClient;
  const presentationActive = artifactProps?.presentationActive ?? true;
  const epochOptions = artifactSource?.epochOptions ?? Object.freeze([]);
  const targetOptions = artifactSource?.targetOptions ?? Object.freeze([]);
  const serverCatalogState = artifactProps?.serverCatalogState ?? 'ready';
  const serverOptions = artifactProps?.serverOptions ?? noMcpPageServerOptions;
  const runtimePreviewDependencies = runtimeProps?.runtimePreviewDependencies;
  const [model, setModel] = useState(() => controller.model);
  const [binding, setBinding] = useState<McpPageBinding>(() => {
    const initialTarget = mcpPageTargetFor(initialBinding?.target ?? '', targetOptions);
    const initialTargetServerOptions = mcpPageServerOptionsFor(serverOptions, initialTarget);
    const initialServerName = initialBinding?.serverName ?? initialToolPrefill?.serverName ?? '';
    const serverNameOrigin: McpPageServerNameOrigin = initialServerName.length > 0
      && !initialTargetServerOptions.some((option) => option.name === initialServerName)
      ? 'manual'
      : 'catalog';
    return Object.freeze({
      epochId: initialBinding?.epochId ?? '',
      serverName: mcpPageServerNameFor(initialServerName, initialTargetServerOptions, serverOptions),
      serverNameOrigin,
      target: initialTarget,
    });
  });
  const { epochId, serverName, target } = binding;
  const [timeoutMs, setTimeoutMs] = useState('');
  const [timeoutError, setTimeoutError] = useState<string>();
  const [activeTimeoutMs, setActiveTimeoutMs] = useState(controller.session?.timeoutMs);
  const [toolName, setToolName] = useState(initialToolPrefill?.toolName ?? '');
  const [toolArguments, setToolArguments] = useState<ImmutableJsonRecord>(initialToolPrefill?.arguments ?? {});
  const [runAsTask, setRunAsTask] = useState(false);
  const taskPolls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [promptName, setPromptName] = useState('');
  const [promptArguments, setPromptArguments] = useState<ImmutableJsonRecord>({});
  const [actionError, setActionError] = useState<string>();
  const [cancelledRequests, setCancelledRequests] = useState<readonly string[]>([]);
  const [pendingActions, setPendingActions] = useState<readonly string[]>([]);
  const [traceTab, setTraceTab] = useState<TraceTab>('raw');
  const [appPreview, setAppPreview] = useState<McpPagePreviewSelection | undefined>(() =>
    runtimeProps === undefined ? initialPreview : runtimeAdmission?.selection?.preview);
  const [appPreviewBusy, setAppPreviewBusy] = useState(false);
  const [appPreviewProfile, setAppPreviewProfile] = useState<McpAppPreviewProfile>('portable');
  const [appHost] = useState(browserMcpAppHost);
  // Seeded from the controller so a static render (no effects) already shows the current launch state.
  const [inspectorModel, setInspectorModel] = useState<McpInspectorLaunchModel | undefined>(() => inspectorLaunch?.model);
  const actionSession = useRef(createMcpPageActionSession());
  const appPreviewClosePromise = useRef<Promise<void> | undefined>(undefined);
  const appPreviewController = useRef<McpPagePreviewLifecycle | undefined>(undefined);
  const appPreviewOpenGeneration = useRef(0);
  const closeAppPreviewRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const previewCloseFacade = useRef<(() => Promise<void>) | undefined>(undefined);
  const controllerIdentity = useRef(controller);
  const requestNumber = useRef(0);
  const traceTabsByName = useRef<Partial<Record<TraceTab, HTMLButtonElement | null>>>({});

  if (controllerIdentity.current !== controller) {
    controllerIdentity.current = controller;
    actionSession.current.reset();
    const replacement = mcpPageControllerReplacementState();
    if (actionError !== replacement.actionError) setActionError(replacement.actionError);
    if (cancelledRequests.length > 0) setCancelledRequests(replacement.cancelledRequests);
    if (pendingActions.length > 0) setPendingActions(replacement.pendingActions);
  }

  useEffect(() => controller.subscribe((next) => {
    setModel(next);
    setActiveTimeoutMs(controller.session?.timeoutMs);
  }), [controller]);
  useEffect(() => {
    setCancelledRequests((current) => current.filter((id) => Object.hasOwn(model.activeRequests, id)));
  }, [model.activeRequests]);
  useEffect(() => {
    setBinding((current) => {
      const next = mcpPageBindingFor(current, {
        epochId: initialBinding?.epochId ?? current.epochId,
        serverCatalogState,
        serverOptions,
        sessionPhase: model.phase,
        targetOptions,
      });
      return sameMcpPageBinding(current, next) ? current : next;
    });
  }, [initialBinding?.epochId, model.phase, serverCatalogState, serverOptions, targetOptions]);
  useEffect(() => () => { void appPreviewController.current?.close(); }, []);
  useEffect(() => {
    if (inspectorLaunch === undefined) return undefined;
    const unsubscribe = inspectorLaunch.subscribe(setInspectorModel);
    void inspectorLaunch.refresh();
    return unsubscribe;
  }, [inspectorLaunch]);

  const setActiveAppPreviewController = useCallback((next: McpPagePreviewLifecycle | undefined, current?: McpPagePreviewLifecycle): void => {
    if (current !== undefined && appPreviewController.current !== current) return;
    appPreviewController.current = next;
  }, []);
  const closeCurrentAppPreview = useCallback((): Promise<void> => {
    if (appPreviewClosePromise.current !== undefined) return appPreviewClosePromise.current;
    const current = appPreviewController.current;
    setAppPreviewBusy(true);
    const closeReference: { promise: Promise<void> | undefined } = { promise: undefined };
    let closed = false;
    const close = Promise.resolve().then(async (): Promise<void> => {
      await current?.close();
      closed = true;
    }).catch((error: unknown) => {
      setActionError(errorMessage(error));
      throw error;
    }).finally(() => {
      if (appPreviewClosePromise.current === closeReference.promise) {
        appPreviewClosePromise.current = undefined;
        if (closed) {
          if (appPreviewController.current === current) appPreviewController.current = undefined;
          setAppPreview(undefined);
        }
        setAppPreviewBusy(false);
      }
    });
    closeReference.promise = close;
    appPreviewClosePromise.current = close;
    return close;
  }, []);
  const closeAppPreview = useCallback((): Promise<void> => {
    appPreviewOpenGeneration.current += 1;
    return closeCurrentAppPreview();
  }, [closeCurrentAppPreview]);
  closeAppPreviewRef.current = closeAppPreview;
  if (previewCloseFacade.current === undefined) {
    previewCloseFacade.current = () => closeAppPreviewRef.current();
  }
  const openAppPreview = (selection: McpPagePreviewSelection, profile = appPreviewProfile): void => {
    const generation = ++appPreviewOpenGeneration.current;
    setAppPreviewBusy(true);
    void closeCurrentAppPreview().then(() => {
      if (appPreviewOpenGeneration.current !== generation) return;
      setAppPreviewProfile(profile);
      setAppPreview(selection);
      setAppPreviewBusy(false);
    }).catch(() => {
      if (appPreviewOpenGeneration.current === generation) setAppPreviewBusy(false);
    });
  };
  useEffect(() => {
    if (registerPreviewClose === undefined) return undefined;
    return registerPreviewClose(previewCloseFacade.current!);
  }, [registerPreviewClose]);
  useEffect(() => () => { void closeCurrentAppPreview().catch(() => undefined); }, []);
  useEffect(() => {
    if (appPreview !== undefined && (
      model.phase === 'closed' || model.phase === 'error' ||
      (appPreview.kind === 'artifact' && appPreview.source.sessionId !== model.sessionId)
    )) {
      void closeAppPreview().catch(() => undefined);
    }
  }, [appPreview, closeAppPreview, model.phase, model.sessionId]);
  useEffect(() => {
    if (!presentationActive) void closeAppPreview();
  }, [closeAppPreview, presentationActive]);

  const nextRequestId = (): string => {
    requestNumber.current += 1;
    return `mcp-page-${requestNumber.current}`;
  };
  const run = (action: string, operation: () => Promise<unknown>): void => {
    const session = actionSession.current;
    const run = session.start(action);
    if (run === undefined) return;
    setActionError(undefined);
    setPendingActions(session.pending);
    void operation().catch((reason: unknown) => {
      if (session.isCurrent(run)) setActionError(errorMessage(reason));
    }).finally(() => {
      const pending = session.finish(run);
      if (pending !== undefined) setPendingActions(pending);
    });
  };
  const invoke = (operation: Exclude<McpSessionOperation, 'cancel' | 'close' | 'restart'>, request: Readonly<Record<string, unknown>>): void => {
    const requestId = nextRequestId();
    run(`invoke:${operation}`, () => controller.invoke({ id: requestId, operation, request }));
  };
  const tasks = mcpPageTasksFor(controller.history);
  const sessionReady = model.phase === 'ready';
  // Every answered invocation re-evaluates the schedule: a poll that found the
  // task still working has no other trace in the task itself.
  const taskPollKey = `${String(controller.history.length)}|${tasks.map((entry) => `${entry.task.taskId}:${entry.task.status}:${entry.error === undefined ? '' : 'error'}`).join('|')}`;
  // Each working task is polled through tasks/get at the interval the server
  // suggested, as a task-aware host would, until it settles or answers an
  // error; every poll is an ordinary invocation, so it shows in the history
  // and the trace like any other protocol call.
  useEffect(() => {
    const polls = taskPolls.current;
    for (const [taskId, timer] of polls) {
      const entry = tasks.find((candidate) => candidate.task.taskId === taskId);
      if (!sessionReady || entry === undefined || isTerminalMcpTask(entry) || entry.error !== undefined) {
        clearTimeout(timer);
        polls.delete(taskId);
      }
    }
    if (!sessionReady) return;
    for (const entry of tasks) {
      if (isTerminalMcpTask(entry) || entry.error !== undefined || polls.has(entry.task.taskId)) continue;
      const interval = typeof entry.task.pollInterval === 'number' && entry.task.pollInterval > 0 ? entry.task.pollInterval : 1000;
      polls.set(entry.task.taskId, setTimeout(() => {
        polls.delete(entry.task.taskId);
        invoke('getTask', { taskId: entry.task.taskId });
      }, interval));
    }
    // The poll key summarises every task field the schedule depends on.
  }, [sessionReady, taskPollKey]);
  useEffect(() => () => {
    for (const timer of taskPolls.current.values()) clearTimeout(timer);
    taskPolls.current.clear();
  }, []);

  const tools = catalogItems(model.catalogs.tools, 'Tool');
  const prompts = catalogItems(model.catalogs.prompts, 'Prompt');
  const resources = catalogItems(model.catalogs.resources, 'Resource');
  const resourceTemplates = catalogItems(model.catalogs.resourceTemplates, 'Resource template');
  const matchedTool = tools.find((item) => item.name === toolName);
  const selectedTool = matchedTool ?? (initialToolPrefill === undefined && toolName === '' ? tools[0] : undefined);
  const missingToolName = initialToolPrefill !== undefined
    && model.phase === 'ready'
    && !tools.some((item) => item.name === initialToolPrefill.toolName)
    ? initialToolPrefill.toolName
    : undefined;
  const selectedPrompt = prompts.find((item) => item.name === promptName) ?? prompts[0];
  const active = Object.values(model.activeRequests);
  const controls = mcpPageSessionControls(model.phase, pendingActions, onResetSession !== undefined, serverCatalogState);
  const isPending = (action: string): boolean => pendingActions.includes(action);
  const rawTrace = model.conciseTrace;
  const config = model.config;
  const traceEntries = traceTab === 'raw' ? rawTrace : traceTab === 'logs' ? model.logs : model.progress;
  const traceLabel = traceTab === 'raw' ? 'Raw protocol' : traceTab === 'logs' ? 'Logs' : 'Progress';
  const tracePanelId = 'mcp-trace-panel';
  const targetServerOptions = mcpPageServerOptionsFor(serverOptions, target);
  const selectTraceTab = (next: TraceTab): void => {
    setTraceTab(next);
    traceTabsByName.current[next]?.focus();
  };
  const onTraceTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: TraceTab): void => {
    const index = traceTabs.indexOf(current);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? traceTabs[(index + 1) % traceTabs.length]!
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? traceTabs[(index + traceTabs.length - 1) % traceTabs.length]!
        : event.key === 'Home'
          ? traceTabs[0]
          : event.key === 'End'
            ? traceTabs[traceTabs.length - 1]
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    selectTraceTab(next);
  };

  return <main className="mcp-page" aria-label="MCP playground">
    <header className="mcp-page-heading">
      <div>
        <p className="mcp-page-eyebrow">Artifact-bound protocol workbench</p>
        <h1>MCP playground</h1>
        <p>Choose a generated server, open a session, and inspect or replay its protocol calls.</p>
      </div>
      <p className={`mcp-page-phase mcp-page-phase--${model.phase}`} role="status">Session {model.phase}</p>
    </header>

    <section className="mcp-page-section" aria-labelledby="mcp-session-heading">
      <h2 id="mcp-session-heading">Session</h2>
      {controls.recovery !== 'none' ? <div className="mcp-page-recovery" role="status">
        <p>This controller is terminal. Supply a new controller before opening another MCP session.</p>
        {controls.recovery === 'available'
          ? <button onClick={() => run('reset', async () => {
            await closeAppPreview();
            onResetSession?.();
          })} type="button">Reset MCP session</button>
          : <button disabled type="button">New MCP session unavailable</button>}
      </div> : runtimeProps !== undefined ? <section aria-label="Runtime-bound MCP session" className="mcp-page-runtime-binding">
        <h3>Runtime-bound MCP session</h3>
        {runtimeSource === undefined ? <p role="alert">{runtimePreviewDiagnostic}</p> : <>
          <dl>
            <div><dt>Server</dt><dd>{runtimeSource.serverName}</dd></div>
            <div><dt>Target</dt><dd>{runtimeSource.target}</dd></div>
            <div><dt>Definition digest</dt><dd><code>{runtimeSource.definitionDigest}</code></dd></div>
            <div><dt>Transport digest</dt><dd><code>{runtimeSource.transportDigest}</code></dd></div>
            <div><dt>Server digest</dt><dd><code>{runtimeSource.serverDigest}</code></dd></div>
            <div><dt>Registry revision</dt><dd>{runtimeSource.registryRevision}</dd></div>
            <div><dt>Session</dt><dd>{runtimeSource.sessionId} · revision {runtimeSource.sessionRevision}</dd></div>
          </dl>
          <div className="mcp-page-actions">
            <button disabled={!controls.restart} onClick={() => run('restart', async () => {
              await closeAppPreview();
              return controller.restart();
            })} type="button">Restart MCP session</button>
            <button disabled={!controls.close} onClick={() => run('close', async () => {
              await closeAppPreview();
              return controller.close();
            })} type="button">Close MCP session</button>
          </div>
        </>}
      </section> : <form className="mcp-page-binding" onSubmit={(event) => {
        event.preventDefault();
        if (!controls.open) return;
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        const openBinding = mcpPageOpenBindingFor(binding, {
          epochId: initialBinding?.epochId ?? binding.epochId,
          serverCatalogState,
          serverOptions,
          sessionPhase: model.phase,
          targetOptions,
        });
        if (openBinding === undefined) return;
        const trimmedTimeoutMs = timeoutMs.trim();
        const parsedTimeoutMs = trimmedTimeoutMs.length === 0 ? undefined : Number(trimmedTimeoutMs);
        if (parsedTimeoutMs !== undefined && (!Number.isFinite(parsedTimeoutMs) || parsedTimeoutMs <= 0)) {
          setTimeoutError('Session timeout must be a positive finite number.');
          return;
        }
        setTimeoutError(undefined);
        run('open', () => controller.open(openBinding, parsedTimeoutMs));
      }}>
        <label htmlFor="mcp-epoch">Build
          <select disabled={!controls.open} id="mcp-epoch" onChange={(event) => setBinding((current) => Object.freeze({ ...current, epochId: event.currentTarget.value }))} required value={epochId}>
            <option value="">Select a build</option>
            {epochOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label htmlFor="mcp-target">Generated target
          <select disabled={!controls.open} id="mcp-target" onChange={(event) => {
            const nextTarget = event.currentTarget.value;
            setBinding((current) => {
              const target = mcpPageTargetFor(nextTarget, targetOptions);
              const targetServerOptions = mcpPageServerOptionsFor(serverOptions, target);
              return Object.freeze({
                ...current,
                serverName: current.serverNameOrigin === 'manual' || serverCatalogState === 'loading'
                  ? current.serverName
                  : mcpPageCatalogServerNameFor(current.serverName, targetServerOptions),
                target,
              });
            });
          }} required value={target}>
            <option value="">Select a target</option>
            {targetOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label htmlFor="mcp-server-name">Server name
          <input disabled={!controls.open} id="mcp-server-name" list="mcp-server-options" onChange={(event) => {
            const nextServerName = event.currentTarget.value;
            setBinding((current) => Object.freeze({
              ...current,
              serverName: nextServerName,
              serverNameOrigin: targetServerOptions.some((option) => option.name === nextServerName) ? 'catalog' : 'manual',
            }));
          }} required value={serverName} />
          <datalist id="mcp-server-options">
            {targetServerOptions.map((option) => <option key={`${option.target}/${option.name}`} value={option.name}>{option.name}</option>)}
          </datalist>
        </label>
        <label htmlFor="mcp-session-timeout">Session timeout (ms)
          <input
            aria-describedby={timeoutError === undefined ? undefined : 'mcp-session-timeout-error'}
            aria-invalid={timeoutError === undefined ? undefined : true}
            disabled={!controls.open}
            id="mcp-session-timeout"
            inputMode="numeric"
            onChange={(event) => {
              setTimeoutMs(event.currentTarget.value);
              setTimeoutError(undefined);
            }}
            placeholder="Server default"
            type="number"
            value={timeoutMs}
          />
          {timeoutError === undefined ? undefined : <span id="mcp-session-timeout-error" role="alert">{timeoutError}</span>}
        </label>
        <div className="mcp-page-actions">
          <button disabled={!controls.open} type="submit">Open MCP session</button>
          <button disabled={!controls.restart} onClick={() => run('restart', async () => {
            await closeAppPreview();
            return controller.restart();
          })} type="button">Restart MCP session</button>
          <button disabled={!controls.close} onClick={() => run('close', async () => {
            await closeAppPreview();
            return controller.close();
          })} type="button">Close MCP session</button>
        </div>
      </form>}
      {runtimeProps === undefined && activeTimeoutMs !== undefined ? <p className="mcp-page-session-timeout">Active session timeout: {activeTimeoutMs} ms.</p> : undefined}
      <div className="mcp-page-connection" aria-label="Negotiated connection">
        <h3>Negotiated connection</h3>
        <p>{connectionSummary(model.connection)}</p>
        {model.connection === undefined ? undefined : <pre><code>{display({ capabilities: model.connection.serverCapabilities, server: model.connection.serverInfo })}</code></pre>}
      </div>
      {runtimeProps === undefined ? <McpLaunchConfiguration config={config} /> : undefined}
      {active.length === 0 ? undefined : <section aria-label="Active MCP operations" className="mcp-page-active">
        <h3>Active operations</h3>
        <ul>{active.map((request) => <li key={request.id}><span>{request.operation} · {request.id}</span><button disabled={cancelledRequests.includes(request.id)} onClick={() => {
          if (!controller.cancel(request.id)) {
            setActionError(`MCP operation ${request.id} is no longer active.`);
            return;
          }
          setCancelledRequests((current) => current.includes(request.id) ? current : [...current, request.id]);
        }} type="button">Cancel {request.id}</button></li>)}</ul>
      </section>}
    </section>

    <section className="mcp-page-section" aria-labelledby="mcp-catalog-heading">
      <h2 id="mcp-catalog-heading">Catalog</h2>
      {initialToolPrefill === undefined ? undefined : <aside className="mcp-page-prefill" role="status">
        <strong>Tool call prefilled from Routes</strong>
        <p>{initialToolPrefill.serverName} · {initialToolPrefill.toolName}</p>
        <pre><code>{display(initialToolPrefill.arguments)}</code></pre>
        {missingToolName === undefined ? undefined : <p className="mcp-page-missing-tool">
          The server no longer advertises the &quot;{missingToolName}&quot; tool. The prepared arguments were not applied to another tool.
        </p>}
        <p>Open the session and use the existing call control when you are ready. Nothing runs automatically.</p>
      </aside>}
      <div className="mcp-page-catalog-grid">
        <section className="mcp-page-catalog" aria-label="Tools">
          <h3>Tools</h3>
          {tools.length === 0 ? <p className="mcp-page-empty">No tools were advertised.</p> : <ol>{tools.map((item, index) => <li key={`${item.name}-${index}`}>
            <button aria-pressed={selectedTool?.name === item.name} onClick={() => {
              setToolName(item.name);
              setToolArguments({});
            }} type="button">{item.name}</button>
            {item.description === undefined ? undefined : <p>{item.description}</p>}
          </li>)}</ol>}
          {selectedTool === undefined ? undefined : <>
            {selectedTool.taskSupport === 'optional' || selectedTool.taskSupport === 'required' ? <label className="mcp-page-task-toggle">
              <input
                checked={selectedTool.taskSupport === 'required' || runAsTask}
                disabled={selectedTool.taskSupport === 'required' || model.phase !== 'ready'}
                onChange={(event) => setRunAsTask(event.currentTarget.checked)}
                type="checkbox"
              />
              Run as task {selectedTool.taskSupport === 'required'
                ? '(this tool requires task-augmented calls)'
                : '(tools/call answers with a task; the result arrives through tasks/result)'}
            </label> : undefined}
            <McpJsonInput
              disabled={model.phase !== 'ready' || isPending('invoke:callTool') || isPending('invoke:callToolTask')}
              id="mcp-tool-arguments"
              label="Tool arguments"
              onChange={setToolArguments}
              onSubmit={(argumentsValue) => (selectedTool.taskSupport === 'required' || (runAsTask && selectedTool.taskSupport === 'optional')
                ? invoke('callToolTask', { arguments: argumentsValue, name: selectedTool.name, task: { ttl: MCP_PAGE_TASK_TTL_MS } })
                : invoke('callTool', { arguments: argumentsValue, name: selectedTool.name }))}
              schema={selectedTool.schema}
              submitLabel={selectedTool.taskSupport === 'required' || (runAsTask && selectedTool.taskSupport === 'optional')
                ? `Run ${selectedTool.name} as task`
                : `Call ${selectedTool.name}`}
              value={toolArguments}
            />
          </>}
        </section>
        <section className="mcp-page-catalog" aria-label="Prompts">
          <h3>Prompts</h3>
          {prompts.length === 0 ? <p className="mcp-page-empty">No prompts were advertised.</p> : <ol>{prompts.map((item, index) => <li key={`${item.name}-${index}`}>
            <button aria-pressed={selectedPrompt?.name === item.name} onClick={() => {
              setPromptName(item.name);
              setPromptArguments({});
            }} type="button">{item.name}</button>
            {item.description === undefined ? undefined : <p>{item.description}</p>}
          </li>)}</ol>}
          {selectedPrompt === undefined ? undefined : <McpJsonInput
            disabled={model.phase !== 'ready' || isPending('invoke:getPrompt')}
            id="mcp-prompt-arguments"
            label="Prompt arguments"
            onChange={setPromptArguments}
            onSubmit={(argumentsValue) => invoke('getPrompt', { arguments: argumentsValue, name: selectedPrompt.name })}
            submitLabel={`Get ${selectedPrompt.name}`}
            value={promptArguments}
          />}
        </section>
        {catalogList('Resources', resources, (item) => {
          if (item.uri !== undefined) invoke('readResource', { uri: item.uri });
        })}
        {catalogList('Resource templates', resourceTemplates)}
      </div>
    </section>

    <section className="mcp-page-section" aria-labelledby="mcp-operations-heading">
      <h2 id="mcp-operations-heading">Operations and results</h2>
      <div className="mcp-page-actions" aria-label="Catalog operations">
        <button disabled={model.phase !== 'ready' || isPending('invoke:listTools')} onClick={() => invoke('listTools', {})} type="button">List tools</button>
        <button disabled={model.phase !== 'ready' || isPending('invoke:listResources')} onClick={() => invoke('listResources', {})} type="button">List resources</button>
        <button disabled={model.phase !== 'ready' || isPending('invoke:listResourceTemplates')} onClick={() => invoke('listResourceTemplates', {})} type="button">List resource templates</button>
        <button disabled={model.phase !== 'ready' || isPending('invoke:listPrompts')} onClick={() => invoke('listPrompts', {})} type="button">List prompts</button>
        {model.connection?.serverCapabilities !== undefined && isRecord(model.connection.serverCapabilities) && isRecord(model.connection.serverCapabilities.tasks)
          ? <button disabled={model.phase !== 'ready' || isPending('invoke:listTasks')} onClick={() => invoke('listTasks', {})} type="button">List tasks</button>
          : undefined}
      </div>
      {tasks.length === 0 ? undefined : <section aria-label="MCP tasks" className="mcp-page-tasks">
        <h3>Tasks</h3>
        <p>Task-augmented calls this session created or listed. Working tasks are polled through <code>tasks/get</code> at the server’s suggested interval.</p>
        <ol>{tasks.map((entry) => {
          const terminal = isTerminalMcpTask(entry);
          const progress = entry.progress;
          return <li data-task-id={entry.task.taskId} data-task-status={entry.task.status} key={entry.task.taskId}>
            <div>
              <strong>{entry.toolName ?? 'task'}</strong>
              <span className={`mcp-page-task-status mcp-page-task-status-${entry.task.status}`}>{entry.task.status}</span>
              <code>{entry.task.taskId}</code>
            </div>
            {typeof entry.task.statusMessage === 'string' ? <p>{entry.task.statusMessage}</p> : undefined}
            {progress === undefined ? undefined : <p className="mcp-page-task-progress">
              Progress {progress.total === undefined ? String(progress.progress) : `${String(progress.progress)} / ${String(progress.total)}`}{progress.message === undefined ? '' : ` · ${progress.message}`}
            </p>}
            <p className="mcp-page-task-times">created {String(entry.task.createdAt)} · updated {String(entry.task.lastUpdatedAt)} · ttl {String(entry.task.ttl)} ms{typeof entry.task.pollInterval === 'number' ? ` · poll every ${String(entry.task.pollInterval)} ms` : ''}</p>
            {entry.error === undefined ? undefined : <p className="mcp-page-task-error" role="status">{display(entry.error)}</p>}
            <div className="mcp-page-actions">
              <button disabled={model.phase !== 'ready' || isPending('invoke:getTask')} onClick={() => invoke('getTask', { taskId: entry.task.taskId })} type="button">Poll {entry.task.taskId.slice(0, 8)}</button>
              <button disabled={model.phase !== 'ready' || isPending('invoke:getTaskResult')} onClick={() => invoke('getTaskResult', { taskId: entry.task.taskId })} type="button">Fetch result {entry.task.taskId.slice(0, 8)}</button>
              <button disabled={model.phase !== 'ready' || terminal || isPending('invoke:cancelTask')} onClick={() => invoke('cancelTask', { taskId: entry.task.taskId })} type="button">Cancel {entry.task.taskId.slice(0, 8)}</button>
            </div>
            {entry.result === undefined ? undefined : <pre><code>{display(entry.result)}</code></pre>}
          </li>;
        })}</ol>
      </section>}
      {appPreviewClient === undefined ? undefined : <section aria-label="MCP App preview controls" className="mcp-page-app-controls">
        <div>
          <h3>App preview</h3>
          <p>Open a sandboxed preview from a successful tool call using the selected supported host profile.</p>
        </div>
        <label htmlFor="mcp-app-profile">Preview profile
          <select disabled={appPreviewBusy} id="mcp-app-profile" onChange={(event) => {
            const profile = event.currentTarget.value as McpAppPreviewProfile;
            if (!supportedMcpAppPreviewProfiles.includes(profile)) return;
            if (appPreview === undefined) {
              setAppPreviewProfile(profile);
              return;
            }
            openAppPreview(appPreview, profile);
          }} value={appPreviewProfile}>
            {supportedMcpAppPreviewProfiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
          </select>
        </label>
        {appPreview === undefined ? <p className="mcp-page-empty">Select a completed tool call below to create an App preview.</p> : <button disabled={appPreviewBusy} onClick={() => { void closeAppPreview().catch(() => undefined); }} type="button">Close App preview</button>}
      </section>}
      {runtimeProps === undefined || appPreview?.kind !== 'runtime' ? undefined : <section aria-label="Runtime App preview controls" className="mcp-page-app-controls">
        <div>
          <h3>Runtime App preview</h3>
          <p>This preview is bound to the selected runtime session evidence.</p>
        </div>
        <button disabled={appPreviewBusy} onClick={() => { void closeAppPreview().catch(() => undefined); }} type="button">Close App preview</button>
      </section>}
      {appPreview === undefined ? undefined : <McpPageAppPreview
        artifactClient={appPreviewClient}
        host={appHost}
        key={appPreview.kind === 'artifact'
          ? `${appPreview.source.invocationId}-${appPreviewProfile}`
          : `runtime:${appPreview.binding.sessionId}:${appPreview.binding.sessionRevision}:${runtimeAdmission?.selection?.appSurfaceId ?? ''}:${appPreview.preview.run.id}`}
        onLifecycleChange={setActiveAppPreviewController}
        previewProfile={appPreviewProfile}
        runtimePreviewDependencies={runtimePreviewDependencies}
        selection={appPreview}
      />}
      <section aria-label="Invocation history" className="mcp-page-history">
        <h3>Invocation history</h3>
        {controller.history.length === 0 ? <p className="mcp-page-empty">No completed invocations yet.</p> : <ol>{controller.history.map((invocation) => {
          const previewSource = mcpAppPreviewSourceFor(model, invocation);
          return <li key={invocation.id}>
          <div><strong>{invocation.operation}</strong><span>{invocation.id}</span>{invocation.replayOf === undefined ? undefined : <span>Replay of {invocation.replayOf}</span>}</div>
          <pre><code>{display({ error: invocation.error, request: invocation.request, result: invocation.result, timing: invocation.timing })}</code></pre>
          <button disabled={model.phase !== 'ready' || isPending('replay')} onClick={() => run('replay', () => controller.replay({ id: nextRequestId(), invocationId: invocation.id }))} type="button">Replay {invocation.id}</button>
          {appPreviewClient === undefined || previewSource === undefined ? undefined : <button disabled={appPreviewBusy} onClick={() => openAppPreview({ kind: 'artifact', source: previewSource })} type="button">Open App preview for {invocation.id}</button>}
        </li>;
        })}</ol>}
      </section>
    </section>

    <section className="mcp-page-section" aria-labelledby="mcp-trace-heading">
      <h2 id="mcp-trace-heading">Trace</h2>
      <p>Download the current browser MCP trace, not a durable Playground session export.</p>
      <button disabled={onDownloadTrace === undefined} onClick={() => downloadCurrentMcpProtocolTrace(onDownloadTrace, { history: controller.history, model })} type="button">Download current protocol trace</button>
      <div aria-label="Trace-derived views" className="mcp-page-tabs" role="tablist">
        {traceTabs.map((candidate) => <button
          aria-controls={tracePanelId}
          aria-selected={traceTab === candidate}
          id={`mcp-trace-tab-${candidate}`}
          key={candidate}
          onClick={() => selectTraceTab(candidate)}
          onKeyDown={(event) => onTraceTabKeyDown(event, candidate)}
          ref={(element) => { traceTabsByName.current[candidate] = element; }}
          role="tab"
          tabIndex={traceTab === candidate ? 0 : -1}
          type="button"
        >
          {candidate === 'raw' ? 'Raw protocol' : candidate[0]!.toUpperCase()}{candidate === 'raw' ? undefined : candidate.slice(1)}
        </button>)}
      </div>
      <section aria-labelledby={`mcp-trace-tab-${traceTab}`} className="mcp-page-trace" id={tracePanelId} role="tabpanel" tabIndex={0}>
        {traceTab === 'raw'
          ? <McpProtocolEvidence ariaLabel={traceLabel} trace={rawTrace.map(traceValue)} />
          : <><h3>{traceLabel}</h3>{traceEntries.length === 0 ? <p className="mcp-page-empty">No {traceLabel.toLowerCase()} entries yet.</p> : <ol>{traceEntries.map((entry, index) => <li key={`${traceTab}-${'sequence' in entry ? entry.sequence : 'local'}-${index}`}>
            <pre><code>{display(traceValue(entry))}</code></pre>
          </li>)}</ol>}</>}
      </section>
    </section>

    <section className="mcp-page-section mcp-page-config" aria-labelledby="mcp-config-heading">
      <h2 id="mcp-config-heading">MCP Inspector</h2>
      <p>The standalone MCP Inspector is a separate localhost app with its own token URL. It opens in a new tab and is never embedded here; export the selected session’s resolved command and non-secret environment to configure it.</p>
      <div aria-label="Inspector actions" className="mcp-page-actions">
        {inspectorLaunch === undefined || inspectorModel === undefined ? undefined : mcpPageInspectorControl(inspectorLaunch, inspectorModel, config)}
        <button disabled={config === undefined || onDownloadConfig === undefined} onClick={() => {
          if (config !== undefined && onDownloadConfig !== undefined) onDownloadConfig(mcpConfigDownload(config, model.sessionId));
        }} type="button">Download Inspector config</button>
      </div>
      {inspectorLaunch === undefined || inspectorModel === undefined ? undefined : mcpPageInspectorStatusLine(inspectorModel, config)}
    </section>

    {actionError === undefined && model.diagnostics.length === 0 ? undefined : <section aria-label="MCP diagnostics" className="mcp-page-diagnostics" role="alert">
      {actionError === undefined ? undefined : <p>{actionError}</p>}
      {model.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</p>)}
    </section>}
  </main>;
};
