import type { Diagnostic } from '../../core/diagnostics.ts';
import type { ProjectEventHub } from '../events.ts';
import type { ProjectEventMessage } from '../types.ts';
import type { TracePublisher } from './trace-hub.ts';

const diagnosticDetails = (diagnostics: readonly Diagnostic[]) =>
  Object.freeze(diagnostics.map((diagnostic) => Object.freeze({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
  })));

const publishBuildFailure = (
  trace: TracePublisher,
  event: Extract<ProjectEventMessage, { readonly type: 'build.failed' }>,
): void => {
  trace.publish({
    correlation: {
      ...(event.epochId === undefined ? {} : { epochId: event.epochId }),
    },
    details: {
      buildId: event.payload.id,
      diagnostics: diagnosticDetails(event.payload.diagnostics),
      sourceRevision: event.payload.sourceRevision,
    },
    href: '/problems',
    kind: 'diagnostic.build.failed',
    occurredAt: event.occurredAt,
    source: 'diagnostic',
    status: 'error',
    summary: 'Build failed.',
  });
};

const publishContractFailure = (
  trace: TracePublisher,
  event: Extract<ProjectEventMessage, { readonly type: 'dev.contract.status' }>,
): void => {
  if (event.payload.state !== 'failed') return;
  const failures = event.payload.failures.length === 0 ? [undefined] : event.payload.failures;
  for (const failure of failures) {
    trace.publish({
      correlation: {
        epochId: event.epochId,
        ...(failure === undefined ? {} : { routeId: failure.routeId }),
      },
      details: {
        ...(failure === undefined ? {} : { checks: failure.checks }),
        diagnostics: diagnosticDetails(event.payload.diagnostics),
      },
      href: '/problems',
      kind: 'diagnostic.contract.failed',
      occurredAt: event.occurredAt,
      source: 'diagnostic',
      status: 'error',
      summary: event.payload.summary,
    });
  }
};

const publishHostSyncFailure = (
  trace: TracePublisher,
  event: Extract<ProjectEventMessage, { readonly type: 'dev.host.sync' }>,
): void => {
  if (event.payload.state !== 'failed') return;
  trace.publish({
    correlation: {
      epochId: event.epochId,
      host: event.payload.host,
    },
    details: { diagnostics: diagnosticDetails(event.payload.diagnostics) },
    href: '/problems',
    kind: 'diagnostic.host.sync',
    occurredAt: event.occurredAt,
    source: 'diagnostic',
    status: 'error',
    summary: `${event.payload.host} host sync failed.`,
  });
};

const receive = (trace: TracePublisher, event: ProjectEventMessage): void => {
  switch (event.type) {
    case 'build.failed':
      publishBuildFailure(trace, event);
      break;
    case 'dev.contract.status':
      publishContractFailure(trace, event);
      break;
    case 'dev.host.sync':
      publishHostSyncFailure(trace, event);
      break;
    case 'route.invocation':
    case 'artifact.available':
    case 'artifact.status':
    case 'build.started':
    case 'invalidation':
    case 'replay.gap':
    case 'runtime.event':
    case 'source.changed':
    case 'source.status':
      break;
    default: {
      const exhausted: never = event;
      throw new Error(`Unhandled project event: ${String(exhausted)}`);
    }
  }
};

export const attachProjectEventTrace = (
  trace: TracePublisher,
  projectEvents: ProjectEventHub,
): (() => void) => {
  const subscription = projectEvents.subscribe((event) => receive(trace, event));
  return () => subscription.unsubscribe();
};
