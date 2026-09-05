/**
 * The one route workspace (#600): selecting any application leaf opens it.
 * Dispatch is by the leaf's execution kind —
 *
 * - `invoke`   → the executable body (tools, resources, prompts, CLI, scripts)
 *                or, for event leaves, the same body behind a host selector;
 * - `preview`  → the MCP App preview as the center;
 * - `document` → the rendered Skill document, or a read-only source view for
 *                rules, commands, and configuration-declared leaves.
 *
 * The shell mounts exactly one of these for the selected leaf; a leaf change
 * remounts so no input, result, or session leaks between leaves.
 */
import React from 'react';

import { AppRouteWorkspace } from './app-route-workspace.tsx';
import type { ApplicationLeaf } from './application-tree-model.ts';
import { EventRouteWorkspace } from './event-route-workspace.tsx';
import { ExecutableRouteWorkspace, useRouteInvocation, WorkspaceHeader } from './executable-route-workspace.tsx';
import { SkillWorkspace } from './skill-workspace.tsx';
import type { RouteWorkspaceProps } from './workspace-contracts.ts';
import './workspace.css';

const configRows = (leaf: ApplicationLeaf): readonly { readonly label: string; readonly value: string }[] =>
  leaf.config.map((entry) => ({ label: entry.key, value: entry.kind === 'string' ? entry.value : `${entry.value} (${entry.kind})` }));

/** Rules, commands, and configuration-declared leaves: what the plugin declares, read-only. */
export const DocumentWorkspace = ({ leaf }: { readonly leaf: ApplicationLeaf }): React.ReactNode => <div className="route-workspace document-workspace" data-testid="route-workspace">
  <div className="route-workspace-main">
    <WorkspaceHeader leaf={leaf} />
    <section aria-label="Declaration" className="document-workspace-body">
      <dl className="inspector-rows">
        <div><dt>Source</dt><dd>{leaf.source ?? 'Declared in configuration; no source module.'}</dd></div>
        {leaf.event === undefined ? undefined : <div><dt>Event</dt><dd>{leaf.event}</dd></div>}
        {configRows(leaf).map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}
      </dl>
      <p className="result-note">This leaf is a document the host reads as written; there is nothing to run. Edit the source and the published build picks it up.</p>
    </section>
  </div>
</div>;

const InvokeWorkspace = ({ backends, clients, invocationId, leaf, onNavigate, tab, trace }: RouteWorkspaceProps): React.ReactNode => {
  const controller = useRouteInvocation({ backends, ...(invocationId === undefined ? {} : { invocationId }), leaf });
  return leaf.ref.kind === 'event'
    ? <EventRouteWorkspace clients={clients} controller={controller} invocationId={invocationId} leaf={leaf} onNavigate={onNavigate} tab={tab} trace={trace} />
    : <ExecutableRouteWorkspace controller={controller} invocationId={invocationId} leaf={leaf} onNavigate={onNavigate} tab={tab} trace={trace} />;
};

/** Mounts the workspace body the selected leaf's execution kind calls for. */
export const RouteWorkspace = (props: RouteWorkspaceProps): React.ReactNode => {
  const { leaf } = props;
  switch (leaf.execution) {
    case 'invoke':
      return <InvokeWorkspace key={leaf.key} {...props} />;
    case 'preview':
      return <AppRouteWorkspace clients={props.clients} key={leaf.key} leaf={leaf} onNavigate={props.onNavigate} status={props.status} />;
    case 'document':
      return leaf.ref.kind === 'skill'
        ? <SkillWorkspace clients={props.clients} key={leaf.key} leaf={leaf} status={props.status} />
        : <DocumentWorkspace key={leaf.key} leaf={leaf} />;
    default: {
      const exhaustive: never = leaf.execution;
      return exhaustive;
    }
  }
};
