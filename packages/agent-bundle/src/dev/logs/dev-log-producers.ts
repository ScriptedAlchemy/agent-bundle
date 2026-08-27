import { isRecord } from '../../core/strict-json.ts';
import type { ProjectServiceLogger } from '../project-service.ts';
import type { ProjectEvent, ProjectEventMessage } from '../types.ts';
import type { ProjectEventHub } from '../events.ts';
import { devLogKinds, type DevLogInput, type DevLogInputFor, type DevLogKindFor, type DevLogSink } from './dev-log-service.ts';
import type { McpSessionTraceSink } from '../mcp-session/mcp-session-service.ts';

const stringAt = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;

const diagnosticLevel = (value: unknown): 'error' | 'info' | 'warning' =>
  stringAt(value, 'severity') === 'error' ? 'error' : stringAt(value, 'severity') === 'warning' ? 'warning' : 'info';

const contextFor = (event: ProjectEvent): Readonly<Record<string, string>> => {
  const payload = event.payload;
  const buildId = stringAt(payload, 'id');
  if (event.type === 'build.started' || event.type === 'build.failed') {
    return buildId === undefined ? Object.freeze({}) : Object.freeze({ buildId });
  }
  if (event.type === 'artifact.available' || event.type === 'runtime.event') {
    return event.epochId === undefined ? Object.freeze({}) : Object.freeze({ epochId: event.epochId });
  }
  return Object.freeze({});
};

const levelFor = (event: ProjectEvent): DevLogInput['level'] =>
  event.type === 'build.failed' ? 'error' : event.type === 'source.status' && stringAt(event.payload, 'state') === 'invalid' ? 'warning' : 'info';

const summaryFor = (event: ProjectEvent): string => {
  if (event.type === 'source.changed') return 'Project source changed.';
  if (event.type === 'source.status') return 'Project source status was updated.';
  if (event.type === 'invalidation') return 'Project rebuild was invalidated.';
  if (event.type === 'build.started') return 'Project build started.';
  if (event.type === 'build.failed') return 'Project build failed.';
  if (event.type === 'artifact.available') return 'Project artifact became available.';
  if (event.type === 'artifact.status') return 'Project artifact status was updated.';
  return 'Project runtime event was published.';
};

const diagnosticsFor = (event: ProjectEvent): readonly unknown[] => {
  const payload: unknown = event.payload;
  if (!isRecord(payload) || !Array.isArray(payload.diagnostics)) return Object.freeze([]);
  return Object.freeze([...payload.diagnostics]);
};

const write = (sink: DevLogSink, input: DevLogInput): void => {
  try { sink.log(input); }
  catch { /* Dev Logs must never alter the producer's result. */ }
};

const projectKinds: ReadonlySet<string> = new Set(devLogKinds.project);

const isProjectKind = (value: string): value is DevLogKindFor<'project'> => projectKinds.has(value);

const diagnosticKindFor = (event: ProjectEvent): DevLogKindFor<'diagnostic'> => `${event.type}.diagnostic`;

/** Converts the existing ProjectService observation seam into producer-wide records. */
export const createProjectDevLogger = (sink: DevLogSink): ProjectServiceLogger => Object.freeze({
  log: (event: string, details: Readonly<Record<string, unknown>>) => {
    if (!isProjectKind(event)) return;
    const target = typeof details.target === 'string' ? details.target : undefined;
    write(sink, {
      ...(target === undefined ? {} : { context: { target } }),
      details,
      kind: event,
      level: event === 'project.invalid-source' ? 'error' : 'info',
      producer: 'project',
      summary: event === 'project.invalid-source' ? 'Project source could not be prepared.' : 'Project service event recorded.',
    });
  },
});

const recordEvent = (sink: DevLogSink, message: ProjectEventMessage): void => {
  if (message.type === 'replay.gap') {
    write(sink, {
      details: message,
      kind: 'project.events.replay-gap',
      level: 'warning',
      producer: 'project',
      summary: 'Project event replay omitted expired records.',
    });
    return;
  }
  const shared = {
    context: contextFor(message),
    details: message.payload,
    level: levelFor(message),
    summary: summaryFor(message),
  } as const;
  switch (message.type) {
    case 'artifact.available':
    case 'build.failed':
    case 'build.started':
      write(sink, { ...shared, kind: message.type, producer: 'build' });
      break;
    case 'artifact.status':
    case 'invalidation':
    case 'runtime.event':
    case 'source.changed':
    case 'source.status':
      write(sink, { ...shared, kind: message.type, producer: 'project' });
      break;
    default:
      message satisfies never;
  }
  const buildId = stringAt(message.payload, 'id');
  for (const diagnostic of diagnosticsFor(message)) {
    const code = stringAt(diagnostic, 'code');
    write(sink, {
      context: Object.freeze({
        ...(buildId === undefined ? {} : { buildId }),
        ...(code === undefined ? {} : { diagnosticCode: code }),
      }),
      details: diagnostic,
      kind: diagnosticKindFor(message),
      level: diagnosticLevel(diagnostic),
      producer: 'diagnostic',
      summary: 'Project diagnostic was recorded.',
    });
  }
};

/** Attaches exactly one ordered ProjectEventHub observer; callers release it during server shutdown. */
export const attachProjectEventLogs = (sink: DevLogSink, events: ProjectEventHub): (() => void) => {
  const subscription = events.subscribe({ afterSequence: events.latestSequence }, (event) => recordEvent(sink, event));
  return () => subscription.unsubscribe();
};

/** Drops raw protocol frames and progress notifications; only high-level trace data reaches Dev Logs. */
export const createMcpDevLogTraceSink = (sink: DevLogSink): McpSessionTraceSink => (binding, entry) => {
  if (entry.kind === 'frame' || entry.kind === 'progress') return;
  const context = Object.freeze({ epochId: binding.epochId, target: binding.target });
  if (entry.kind === 'operation') {
    write(sink, {
      context,
      details: { operation: entry.operation, phase: entry.phase },
      kind: `mcp.operation.${entry.phase}` as DevLogInputFor<'mcp'>['kind'],
      level: entry.phase === 'failed' ? 'error' : 'info',
      occurredAt: new Date(entry.occurredAt).toISOString(),
      producer: 'mcp',
      summary: `MCP ${entry.operation} ${entry.phase}.`,
    });
    return;
  }
  if (entry.kind === 'stderr') {
    write(sink, {
      context,
      details: { text: entry.text },
      kind: 'mcp.stderr',
      level: 'warning',
      occurredAt: new Date(entry.occurredAt).toISOString(),
      producer: 'mcp',
      summary: 'MCP server wrote stderr output.',
    });
    return;
  }
  write(sink, {
    context,
    details: entry.payload,
    kind: 'mcp.logging',
    level: 'info',
    occurredAt: new Date(entry.occurredAt).toISOString(),
    producer: 'mcp',
    summary: 'MCP server emitted a logging notification.',
  });
};
