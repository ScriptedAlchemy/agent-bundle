import React, { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import {
  type ApplicationNodeRef,
  sameApplicationNodeRef,
} from '../../../agent-bundle/src/contracts/workbench-shell.ts';
import {
  filterApplicationTree,
  type ApplicationGroup,
  type ApplicationLeaf,
  type ApplicationServerGroup,
  type ApplicationSubgroup,
  type ApplicationTree,
} from './application-tree-model.ts';
import './application-tree.css';

export interface ApplicationTreeViewProps {
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (ref: ApplicationNodeRef) => void;
  readonly query: string;
  readonly selected?: ApplicationNodeRef;
  readonly tree: ApplicationTree;
}

const leafCountForServer = (server: ApplicationServerGroup): number =>
  server.subgroups.reduce((total, subgroup) => total + subgroup.leaves.length, 0);

const leafCountForGroup = (group: ApplicationGroup): number =>
  group.kind === 'mcp'
    ? group.servers.reduce((total, server) => total + leafCountForServer(server), 0)
    : group.leaves.length;

const Count = ({ value }: { readonly value: number }) =>
  <span aria-label={`${String(value)} ${value === 1 ? 'item' : 'items'}`} className="application-tree-count">{value}</span>;

const Branch = ({ count, expanded, label, onToggle }: {
  readonly count: number;
  readonly expanded: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) => (
  <button
    aria-expanded={expanded}
    className="application-tree-branch"
    onClick={onToggle}
    role="treeitem"
    type="button"
  >
    <span aria-hidden="true" className="application-tree-disclosure">{expanded ? '▾' : '▸'}</span>
    <span>{label}</span>
    <Count value={count} />
  </button>
);

const Leaf = ({ leaf, onKeyDown, onSelect, selected }: {
  readonly leaf: ApplicationLeaf;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, leaf: ApplicationLeaf) => void;
  readonly onSelect: (ref: ApplicationNodeRef) => void;
  readonly selected: boolean;
}) => (
  <button
    aria-selected={selected}
    className="application-tree-leaf"
    data-application-leaf={leaf.key}
    onClick={() => onSelect(leaf.ref)}
    onKeyDown={(event) => onKeyDown(event, leaf)}
    role="treeitem"
    tabIndex={selected ? 0 : -1}
    type="button"
  >
    <span>{leaf.label}</span>
    {leaf.description === undefined ? undefined : <small>{leaf.description}</small>}
  </button>
);

export const ApplicationTreeView = ({
  onQueryChange,
  onSelect,
  query,
  selected,
  tree,
}: ApplicationTreeViewProps) => {
  const filterId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const visibleTree = useMemo(() => filterApplicationTree(tree, query), [query, tree]);

  const toggle = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const leafKeyDown = (event: KeyboardEvent<HTMLButtonElement>, leaf: ApplicationLeaf): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSelect(leaf.ref);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const leaves = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-application-leaf]') ?? [])];
    const current = leaves.indexOf(event.currentTarget);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    leaves[Math.max(0, Math.min(leaves.length - 1, current + offset))]?.focus();
  };

  const renderLeaves = (label: string, leaves: readonly ApplicationLeaf[]) => (
    <div aria-label={label} role="group">
      {leaves.map((leaf) => (
        <Leaf
          key={leaf.key}
          leaf={leaf}
          onKeyDown={leafKeyDown}
          onSelect={onSelect}
          selected={sameApplicationNodeRef(selected, leaf.ref)}
        />
      ))}
    </div>
  );

  const renderSubgroup = (subgroup: ApplicationSubgroup) => {
    const expanded = !collapsed.has(subgroup.key);
    return <div className="application-tree-node" key={subgroup.key}>
      <Branch
        count={subgroup.leaves.length}
        expanded={expanded}
        label={subgroup.label}
        onToggle={() => toggle(subgroup.key)}
      />
      {expanded ? renderLeaves(subgroup.label, subgroup.leaves) : undefined}
    </div>;
  };

  const renderServer = (server: ApplicationServerGroup) => {
    const expanded = !collapsed.has(server.key);
    return <div className="application-tree-node" key={server.key}>
      <Branch
        count={leafCountForServer(server)}
        expanded={expanded}
        label={server.label}
        onToggle={() => toggle(server.key)}
      />
      {expanded
        ? <div aria-label={server.label} role="group">{server.subgroups.map(renderSubgroup)}</div>
        : undefined}
    </div>;
  };

  const renderGroup = (group: ApplicationGroup) => {
    const expanded = !collapsed.has(group.key);
    return <div className="application-tree-node" key={group.key}>
      <Branch
        count={leafCountForGroup(group)}
        expanded={expanded}
        label={group.label}
        onToggle={() => toggle(group.key)}
      />
      {expanded
        ? group.kind === 'mcp'
          ? <div aria-label={group.label} role="group">{group.servers.map(renderServer)}</div>
          : renderLeaves(group.label, group.leaves)
        : undefined}
    </div>;
  };

  const stateMessage = tree.message ?? (
    tree.state === 'stale'
      ? 'Application routes are newer than the published build.'
      : 'Application routes are unavailable.'
  );

  return <section aria-label="Application navigation" className="application-tree-view">
    <label className="application-tree-filter" htmlFor={filterId}>
      <span>Filter application</span>
      <input
        id={filterId}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        type="search"
        value={query}
      />
    </label>
    {tree.state === 'fresh'
      ? undefined
      : <p className={`application-tree-banner application-tree-banner--${tree.state}`} role={tree.state === 'unavailable' ? 'alert' : 'status'}>
          {stateMessage}
        </p>}
    {visibleTree.leafCount === 0
      ? <p className="application-tree-empty">
          {query.trim().length === 0
            ? 'This project declares no application surfaces.'
            : 'No application surfaces match this filter.'}
        </p>
      : <div aria-label="Application" className="application-tree" data-testid="application-tree" ref={root} role="tree">
          {visibleTree.groups.map(renderGroup)}
        </div>}
  </section>;
};
