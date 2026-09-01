import React from 'react';

import type { RouteCatalog, RouteCatalogEntry, RouteCatalogGroup } from './routes-model.ts';
import './routes-page.css';

export interface RoutesPageProps {
  readonly catalog: RouteCatalog;
}

const stateSummaries: Readonly<Record<RouteCatalog['state'], string>> = Object.freeze({
  current: 'This catalog is the compiled route graph the published build was produced from.',
  stale: 'The dev server has compiled newer source than the published build. Rebuild to publish these routes.',
  unavailable: 'The compiled route manifest could not be read from the foreground server.',
});

const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${String(count)} ${count === 1 ? singular : plural}`;

const configSummary = (entry: RouteCatalogEntry): string => entry.config.length === 0
  ? 'No static config export'
  : entry.config.map((field) => `${field.key}: ${field.value}`).join(' · ');

const commandSummary = (entry: RouteCatalogEntry): string | undefined => {
  const command = entry.command;
  if (command === undefined) return undefined;
  const options = command.options.map((option) => option.positional === undefined
    ? (option.required ? `--${option.option}` : `[--${option.option}]`)
    : (option.repeated ? `[<${option.key}>…]` : `<${option.key}>`));
  return [...command.path, ...options].join(' ');
};

const RouteGroup = ({ group }: { readonly group: RouteCatalogGroup }) => <section
  aria-labelledby={`route-group-${group.serverId ?? 'project'}-${group.kind}`}
  className="route-group"
>
  <div className="route-group-heading">
    <h2 id={`route-group-${group.serverId ?? 'project'}-${group.kind}`}>{group.label}</h2>
    <p>
      {counted(group.entries.length, 'route')}
      {group.mode === undefined ? '' : ` · ${group.mode}`}
    </p>
  </div>
  <table className="route-table">
    <thead>
      <tr>
        <th scope="col">Route ID</th>
        <th scope="col">Source</th>
        <th scope="col">Config</th>
      </tr>
    </thead>
    <tbody>{group.entries.map((entry) => <tr key={entry.id}>
      <th scope="row">
        <span className="route-id">{entry.id}</span>
        {entry.event === undefined ? undefined : <span className="route-event">{entry.event}</span>}
        {commandSummary(entry) === undefined ? undefined : <span className="route-command">{commandSummary(entry)}</span>}
        {entry.description === undefined ? undefined : <span className="route-description">{entry.description}</span>}
      </th>
      <td className="route-source">
        {entry.source}
        <span className="route-provenance">{entry.provenance}</span>
      </td>
      <td className="route-config">{configSummary(entry)}</td>
    </tr>)}</tbody>
  </table>
</section>;

/**
 * The compiled route catalog: one read of the same manifest the build, inspect,
 * and test harness use. Discovery runs once in the compiler; this page renders it.
 */
export const RoutesPage = ({ catalog }: RoutesPageProps) => <div className="routes-content">
  <div className="page-heading routes-page-heading">
    <div>
      <h1>Routes</h1>
      <p>{stateSummaries[catalog.state]}</p>
    </div>
  </div>
  {catalog.state === 'unavailable'
    ? <p className="request-error" role="alert">{catalog.message ?? stateSummaries.unavailable}</p>
    : <>
      <section aria-label="Route graph identity" className="route-identity">
        <dl>
          <div><dt>Routes</dt><dd>{catalog.routeCount}</dd></div>
          <div><dt>Graph digest</dt><dd className="route-digest">{catalog.digest === '' ? '—' : catalog.digest}</dd></div>
          <div><dt>Source revision</dt><dd className="route-digest">{catalog.sourceRevision ?? '—'}</dd></div>
          <div><dt>State</dt><dd className={`route-state route-state--${catalog.state}`}>{catalog.state}</dd></div>
        </dl>
      </section>
      {catalog.diagnostics.length === 0 ? undefined : <section aria-label="Route graph diagnostics" className="route-diagnostics">
        <h2>Route diagnostics ({catalog.diagnostics.length})</h2>
        {catalog.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${String(index)}`}>
          <span className={`severity severity--${diagnostic.severity}`}>{diagnostic.severity}</span>
          <span className="route-diagnostic-code">{diagnostic.code}</span>
          {diagnostic.message}
        </p>)}
      </section>}
      {catalog.groups.length === 0
        ? <p className="empty-row" role="status">This project declares no conventional route modules.</p>
        : catalog.groups.map((group) => <RouteGroup group={group} key={`${group.serverId ?? 'project'}-${group.kind}`} />)}
      {catalog.providers.length === 0 ? undefined : <section aria-label="Context providers" className="route-group">
        <div className="route-group-heading">
          <h2>Context providers</h2>
          <p>{counted(catalog.providers.length, 'provider')}</p>
        </div>
        <table className="route-table">
          <thead><tr><th scope="col">Provider ID</th><th scope="col">Source</th></tr></thead>
          <tbody>{catalog.providers.map((provider) => <tr key={provider.id}>
            <th scope="row"><span className="route-id">{provider.id}</span></th>
            <td className="route-source">{provider.source}</td>
          </tr>)}</tbody>
        </table>
      </section>}
    </>}
</div>;
