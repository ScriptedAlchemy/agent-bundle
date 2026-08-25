import React, { useRef, useState, type KeyboardEvent } from 'react';

import type { DevRuntimeDiagnostic, DevRuntimeRun, DevRuntimeStatus, DevRuntimeSurface, DevRuntimeTreeNode } from '../../agent-bundle/src/contracts/runtime.ts';
import { InspectorRuntimeEvidence } from './inspector/adapter/inspector-session-adapter.tsx';
import type { RuntimeInspectorTab } from './runtime-model.ts';

export interface RuntimeInspectorProps {
  readonly onDownloadFlight?: (run: DevRuntimeRun) => void;
  readonly onTabChange?: (tab: RuntimeInspectorTab) => void;
  readonly run?: DevRuntimeRun;
  readonly status?: DevRuntimeStatus;
  readonly surface?: DevRuntimeSurface;
  readonly tab?: RuntimeInspectorTab;
}

const tabs: readonly Readonly<{ readonly id: RuntimeInspectorTab; readonly label: string }>[] = [
  { id: 'tree', label: 'Tree' },
  { id: 'result', label: 'Result' },
  { id: 'flight', label: 'Flight' },
  { id: 'protocol', label: 'Protocol' },
  { id: 'state', label: 'State' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

const display = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[Unserializable runtime evidence]';
  }
};

const TreeNode = ({ expanded, level, node, showProps }: Readonly<{
  readonly expanded: boolean;
  readonly level: number;
  readonly node: DevRuntimeTreeNode;
  readonly showProps: boolean;
}>): React.ReactNode => <li aria-expanded={node.children.length === 0 ? undefined : expanded} aria-level={level} role="treeitem">
  <span>{node.label}</span> <small>{node.kind}</small>
  {showProps && node.props !== undefined ? <pre><code>{display(node.props)}</code></pre> : undefined}
  {node.children.length === 0 || !expanded ? undefined : <ul role="group">{node.children.map((child) => <TreeNode expanded={expanded} key={child.id} level={level + 1} node={child} showProps={showProps} />)}</ul>}
</li>;

const resultDiagnostics = (run: DevRuntimeRun | undefined, status: DevRuntimeStatus | undefined): readonly DevRuntimeDiagnostic[] => [
  ...(status?.diagnostics ?? []),
  ...(run?.status === 'failed' ? run.diagnostics : []),
];

export const RuntimeInspector = ({ onDownloadFlight, onTabChange, run, status, surface, tab }: RuntimeInspectorProps): React.ReactNode => {
  const [internalTab, setInternalTab] = useState<RuntimeInspectorTab>('tree');
  const [treeExpanded, setTreeExpanded] = useState(true);
  const [showProps, setShowProps] = useState(false);
  const buttons = useRef<Partial<Record<RuntimeInspectorTab, HTMLButtonElement | null>>>({});
  const selectedTab = tab ?? internalTab;
  const selected = run?.status === 'succeeded' ? run.result : undefined;
  const diagnostics = resultDiagnostics(run, status);
  const panelId = 'runtime-inspector-panel';
  const selectTab = (next: RuntimeInspectorTab): void => {
    if (tab === undefined) setInternalTab(next);
    onTabChange?.(next);
    buttons.current[next]?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: RuntimeInspectorTab): void => {
    const index = tabs.findIndex((candidate) => candidate.id === current);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? tabs[(index + 1) % tabs.length]?.id
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? tabs[(index + tabs.length - 1) % tabs.length]?.id
        : event.key === 'Home'
          ? tabs[0]?.id
          : event.key === 'End'
            ? tabs[tabs.length - 1]?.id
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next);
  };

  return <section aria-label="Runtime inspector" className="runtime-inspector">
    <div aria-label="Runtime inspector panels" className="runtime-inspector-tabs" role="tablist">
      {tabs.map((candidate) => <button
        aria-controls={panelId}
        aria-selected={candidate.id === selectedTab}
        id={`runtime-inspector-tab-${candidate.id}`}
        key={candidate.id}
        onClick={() => selectTab(candidate.id)}
        onKeyDown={(event) => onTabKeyDown(event, candidate.id)}
        ref={(element) => { buttons.current[candidate.id] = element; }}
        role="tab"
        tabIndex={candidate.id === selectedTab ? 0 : -1}
        type="button"
      >{candidate.label}</button>)}
    </div>
    <section aria-labelledby={`runtime-inspector-tab-${selectedTab}`} className="runtime-inspector-panel" id={panelId} role="tabpanel" tabIndex={0}>
      {selectedTab === 'tree' ? <>
        <header className="runtime-inspector-heading"><div><h2>Decoded React tree</h2><p>Decoded render output, not source code or an App frame.</p></div><div><button aria-pressed={showProps} onClick={() => setShowProps((value) => !value)} type="button">Show component props</button><button aria-pressed={treeExpanded} disabled={treeExpanded} onClick={() => setTreeExpanded(true)} type="button">Expand all</button><button aria-pressed={!treeExpanded} disabled={!treeExpanded} onClick={() => setTreeExpanded(false)} type="button">Collapse all</button></div></header>
        {selected === undefined || selected.tree.length === 0 ? <p>No decoded React tree is available.</p> : <ul role="tree">{selected.tree.map((node) => <TreeNode expanded={treeExpanded} key={node.id} level={1} node={node} showProps={showProps} />)}</ul>}
      </> : undefined}
      {selectedTab === 'result' ? <>
        <h2>Result</h2>
        {selected === undefined ? <p>No result is available.</p> : <pre><code>{display({ agentVisible: selected.agentVisible, modelVisible: selected.modelVisible, native: selected.native, protocol: surface?.kind === 'mcp-tool' || surface?.kind === 'mcp-resource' || surface?.kind === 'mcp-app' ? undefined : selected.protocol })}</code></pre>}
      </> : undefined}
      {selectedTab === 'flight' ? <>
        <h2>Flight</h2>
        {selected?.flight === undefined ? <p>No Flight payload is available.</p> : <><p>{selected.flight.bytes} bytes{selected.flight.truncated ? ' (preview truncated)' : ''}</p><pre><code>{selected.flight.preview}</code></pre>{selected.flight.downloadPath === undefined || onDownloadFlight === undefined || run === undefined ? undefined : <button onClick={() => onDownloadFlight(run)} type="button">Download Flight payload</button>}</>}
      </> : undefined}
      {selectedTab === 'protocol' ? (surface?.kind === 'mcp-tool' || surface?.kind === 'mcp-resource' || surface?.kind === 'mcp-app')
        ? <InspectorRuntimeEvidence evidence={{ kind: 'protocol', protocol: selected?.protocol, trace: selected?.trace ?? [] }} />
        : <><h2>Protocol</h2><pre><code>{display(selected?.protocol)}</code></pre></> : undefined}
      {selectedTab === 'state' ? <>
        <h2>State</h2>
        {selected === undefined ? <p>No state evidence is available.</p> : <dl className="runtime-inspector-state"><div><dt>State store</dt><dd>{selected.state.identity.stateStoreId}</dd></div><div><dt>State version</dt><dd>{selected.state.identity.stateVersion}</dd></div></dl>}
        {selected?.state.snapshot === undefined ? undefined : <pre><code>{display(selected.state.snapshot)}</code></pre>}
      </> : undefined}
      {selectedTab === 'diagnostics' ? <><InspectorRuntimeEvidence evidence={{ diagnostics, kind: 'diagnostics' }} />{selected === undefined ? undefined : <InspectorRuntimeEvidence evidence={{ kind: 'trace', trace: selected.trace }} />}</> : undefined}
    </section>
  </section>;
};
