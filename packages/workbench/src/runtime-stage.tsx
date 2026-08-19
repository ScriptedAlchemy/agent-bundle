import React from 'react';

import type { DevRuntimeInspectionEnvelope, DevRuntimeRun, DevRuntimeStatus, DevRuntimeSurface } from '../../agent-bundle/src/dev/runtime-protocol.ts';
import type { RuntimeProfileOption } from './runtime-model.ts';
import type { RuntimeAppPreviewLifecycleRegistrar } from './runtime-playground.tsx';

export interface RuntimeAppPreviewProps {
  readonly profile: RuntimeProfileOption;
  readonly profileId: string;
  readonly registerLifecycle?: RuntimeAppPreviewLifecycleRegistrar;
  readonly run: DevRuntimeRun;
  readonly surface: DevRuntimeSurface;
}

export type RuntimeAppPreviewRenderer = (props: RuntimeAppPreviewProps) => React.ReactNode;

export interface RuntimeLiveMcpPageProps extends RuntimeAppPreviewProps {
  readonly mcpBinding: NonNullable<DevRuntimeInspectionEnvelope['app']>['mcpBinding'];
}

/** Later host-owned handoff renderer. It must never mount the live McpPage. */
export type RuntimeLiveMcpPageRenderer = (props: RuntimeLiveMcpPageProps) => React.ReactNode;

export type RuntimeLiveMcpPageAdapter =
  | Readonly<{ readonly kind: 'disabled' }>
  | Readonly<{ readonly kind: 'host-owned'; readonly render: RuntimeLiveMcpPageRenderer }>;

export interface RuntimeStageProps {
  readonly lastGoodRun?: DevRuntimeRun;
  readonly liveMcpPageAdapter?: RuntimeLiveMcpPageAdapter;
  readonly profile?: RuntimeProfileOption;
  readonly profileId?: string;
  readonly renderAppPreview?: RuntimeAppPreviewRenderer;
  readonly registerAppPreviewLifecycle?: RuntimeAppPreviewLifecycleRegistrar;
  readonly run?: DevRuntimeRun;
  readonly status?: DevRuntimeStatus;
  readonly surface?: DevRuntimeSurface;
}

const display = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[Unserializable runtime value]';
  }
};

const outputCard = (label: string, value: unknown, className: string): React.ReactNode => <section className={`runtime-stage-output ${className}`}>
  <h3>{label}</h3>
  {value === undefined ? <p>No {label.toLowerCase()} was returned for this run.</p> : <pre><code>{display(value)}</code></pre>}
</section>;

const sameRuntimeIdentity = (left: DevRuntimeRun['vector'], right: DevRuntimeRun['vector']): boolean =>
  left.providerSessionId === right.providerSessionId &&
  left.runtimeGenerationId === right.runtimeGenerationId &&
  left.stateStoreId === right.stateStoreId &&
  left.stateVersion === right.stateVersion;

const renderedApp = (
  run: DevRuntimeRun | undefined,
  surface: DevRuntimeSurface | undefined,
  profile: RuntimeProfileOption | undefined,
  profileId: string | undefined,
  renderer: RuntimeAppPreviewRenderer | undefined,
  registerLifecycle: RuntimeAppPreviewLifecycleRegistrar | undefined,
): React.ReactNode | undefined => {
  if (run?.status !== 'succeeded' || run.result.app === undefined || surface === undefined || profile === undefined || profileId === undefined || renderer === undefined) {
    return undefined;
  }
  try {
    return renderer({
      profile,
      profileId,
      ...(registerLifecycle === undefined ? {} : { registerLifecycle }),
      run,
      surface,
    });
  } catch {
    return undefined;
  }
};

const renderedLiveMcpPage = (
  run: DevRuntimeRun | undefined,
  surface: DevRuntimeSurface | undefined,
  profile: RuntimeProfileOption | undefined,
  profileId: string | undefined,
  adapter: RuntimeLiveMcpPageAdapter | undefined,
  registerLifecycle: RuntimeAppPreviewLifecycleRegistrar | undefined,
): React.ReactNode | undefined => {
  if (adapter?.kind !== 'host-owned' || run?.status !== 'succeeded' || run.result.app === undefined || surface === undefined || profile === undefined || profileId === undefined) {
    return undefined;
  }
  const app = run.result.app;
  const mcpBinding = app.mcpBinding;
  if (Object.keys(mcpBinding).length === 0 || run.surfaceId !== surface.id || profile.id !== profileId) return undefined;
  try {
    return adapter.render({
      mcpBinding,
      profile,
      profileId,
      ...(registerLifecycle === undefined ? {} : { registerLifecycle }),
      run,
      surface,
    });
  } catch {
    return undefined;
  }
};

export const RuntimeStage = ({ lastGoodRun, liveMcpPageAdapter, profile, profileId, renderAppPreview, registerAppPreviewLifecycle, run, status, surface }: RuntimeStageProps): React.ReactNode => {
  const retainedLastGood = run?.status === 'failed' ? lastGoodRun : undefined;
  const evidenceRun = run?.status === 'succeeded' ? run : retainedLastGood;
  const result = evidenceRun?.status === 'succeeded' ? evidenceRun.result : undefined;
  const app = renderedApp(evidenceRun, surface, profile, profileId, renderAppPreview, registerAppPreviewLifecycle);
  const liveMcpPage = renderedLiveMcpPage(run, surface, profile, profileId, liveMcpPageAdapter, registerAppPreviewLifecycle);
  const activeVector = status?.activeVector;
  const evidenceCurrent = evidenceRun !== undefined && activeVector !== undefined && sameRuntimeIdentity(evidenceRun.vector, activeVector);
  const lastGood = lastGoodRun ?? (run?.status === 'succeeded' ? run : undefined);

  return <section aria-label="Runtime output stage" className="runtime-stage">
    <header className={`runtime-stage-generation ${evidenceCurrent ? 'runtime-stage-generation--current' : 'runtime-stage-generation--stale'}`}>
      {run === undefined ? <p>No runtime output selected.</p> : retainedLastGood !== undefined
        ? <p>Selected run failed in runtime generation {run.vector.runtimeGenerationId}. Retained last-good output is shown below.</p>
        : evidenceCurrent
          ? <p>All outputs are from the current runtime generation ({run.vector.runtimeGenerationId}). No stale views.</p>
          : <p>Selected output is from runtime generation {run.vector.runtimeGenerationId}; current generation is {activeVector?.runtimeGenerationId ?? 'unavailable'}.</p>}
      {lastGood === undefined ? undefined : <p>Last good: {lastGood.vector.runtimeGenerationId}{run !== undefined && !sameRuntimeIdentity(run.vector, lastGood.vector) ? ' (shown separately)' : ''}</p>}
      {retainedLastGood === undefined ? undefined : <p>Retained last-good output ({evidenceCurrent ? 'current evidence' : 'stale evidence'}): {retainedLastGood.vector.runtimeGenerationId}.</p>}
    </header>
    {run?.status === 'failed' ? <section aria-label="Runtime output diagnostics" className="runtime-stage-diagnostics" role="alert">
      <h2>Runtime run failed</h2>
      {run.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.phase}</strong> {diagnostic.code}: {diagnostic.message}</p>)}
    </section> : undefined}
    <div className="runtime-stage-output-grid">
      {outputCard('Agent-visible output', result?.agentVisible, 'runtime-stage-output--agent')}
      {outputCard('Native response', result?.native, 'runtime-stage-output--native')}
      {outputCard('Model-visible output', result?.modelVisible, 'runtime-stage-output--model')}
      {app}
      {liveMcpPage}
    </div>
  </section>;
};
