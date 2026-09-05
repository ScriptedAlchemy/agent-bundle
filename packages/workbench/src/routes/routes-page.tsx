import { useAtom } from '@effect/atom-react';
import React from 'react';

import type {
  RouteInputPropertySchema,
  RouteManifestState,
} from '../../../agent-bundle/src/contracts/routes.ts';
import { routeEditorKey, routeEditorStateAtom } from './route-editor-atoms.ts';
import {
  cliCommandUsage,
  initialRouteEditorState,
  mcpToolPrefillFor,
  routeInputLabel,
  setRouteEditorDraftValue,
  setRouteEditorRaw,
  validateRouteEditor,
  type McpToolPrefill,
  type RouteCatalog,
  type RouteCatalogEntry,
  type RouteCatalogGroup,
  type RouteCatalogServer,
  type RouteInputDraftValue,
} from './routes-model.ts';
import './routes-page.css';

export interface RoutesPageProps {
  readonly catalog: RouteCatalog;
  readonly onOpenMcp?: (prefill: McpToolPrefill) => void;
}

const stateSummaries: Readonly<Record<RouteCatalog['state'], string>> = Object.freeze({
  current: 'This catalog is the compiled route graph the published build was produced from.',
  stale: 'The dev server has compiled newer source than the published build. Rebuild to publish these routes.',
  unavailable: 'The compiled route manifest could not be read from the foreground server.',
});

const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${String(count)} ${count === 1 ? singular : plural}`;

const configSummary = (entry: RouteCatalogEntry): string => {
  if (entry.config.length === 0) return 'No static config export';
  const fields = entry.config.filter((field) => !(field.key === 'description' && entry.description !== undefined));
  return fields.length === 0
    ? 'No config beyond the description'
    : fields.map((field) => `${field.key}: ${field.value}`).join(' · ');
};

const emptyServerSummary = (server: RouteCatalogServer): string => {
  switch (server.mode) {
    case 'command':
    case 'custom':
    case 'remote':
      return `Routes are packaged externally in ${server.mode} mode, so the compiler manifest does not list route modules.`;
    case 'generated':
      return 'No conventional route modules were compiler-discovered for this generated server.';
    case 'conflict':
      return 'No conventional route modules are listed while this server packaging mode remains in conflict.';
    default: {
      const exhaustiveMode: never = server.mode;
      return exhaustiveMode;
    }
  }
};

const EmptyServerSurface = ({ server }: { readonly server: RouteCatalogServer }) => <section
  aria-labelledby={`route-server-${server.id}`}
  className="route-group"
>
  <div className="route-group-heading">
    <h2 id={`route-server-${server.id}`}>{server.name}</h2>
    <p>{server.mode} mode</p>
  </div>
  <p className="route-server-summary">{emptyServerSummary(server)}</p>
</section>;

/** Whole units only, so `7d` reads as the config author wrote it; odd values fall back to milliseconds. */
const formatDuration = (milliseconds: number): string => {
  const units: readonly [string, number][] = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]];
  const unit = units.find(([, size]) => milliseconds % size === 0);
  return unit === undefined ? `${milliseconds}ms` : `${milliseconds / unit[1]}${unit[0]} (${milliseconds}ms)`;
};

const StatePanel = ({ state }: { readonly state?: RouteManifestState }) => <section
  aria-label="State"
  className="route-group route-state-panel"
>
  <div className="route-group-heading"><h2>State</h2><p>read-only catalog</p></div>
  {state === undefined
    ? <p className="empty-row">This project declares no state module.</p>
    : <>
      <dl className="route-state-facts">
        <div><dt>ID</dt><dd>{state.id}</dd></div>
        <div><dt>Effective lifetime</dt><dd>{state.lifetime}</dd></div>
        <div><dt>Driver</dt><dd>{state.driver}</dd></div>
        <div><dt>Source</dt><dd>{state.source}</dd></div>
      </dl>
      <div className="route-state-detail">
        <h3>Budgets</h3>
        {state.budgets.source === 'dynamic'
          ? <p>dynamic — statically unreadable</p>
          : <>
            <p className="route-state-source">{state.budgets.source}</p>
            <dl className="route-state-budgets">
              <div><dt>maxCommitMs</dt><dd>{state.budgets.resolved.maxCommitMs}</dd></div>
              <div><dt>maxEventBytes</dt><dd>{state.budgets.resolved.maxEventBytes}</dd></div>
              <div><dt>maxRevisions</dt><dd>{state.budgets.resolved.maxRevisions}</dd></div>
              <div><dt>maxStateBytes</dt><dd>{state.budgets.resolved.maxStateBytes}</dd></div>
            </dl>
          </>}
      </div>
      {state.durableLocation === undefined ? undefined : <div className="route-state-detail">
        <h3>Durable location</h3>
        <p>{state.durableLocation}</p>
      </div>}
      {state.noticeRetention === undefined ? undefined : <div className="route-state-detail route-state-retention">
        <h3>Notice retention</h3>
        <p className="route-state-source">{state.noticeRetention.source}</p>
        <dl className="route-state-budgets">
          <div><dt>terminalTtl</dt><dd>{formatDuration(state.noticeRetention.resolved.terminalTtlMs)}</dd></div>
          <div><dt>maxTerminal</dt><dd>{state.noticeRetention.resolved.maxTerminal}</dd></div>
          <div><dt>maxJournalBytes</dt><dd>{state.noticeRetention.resolved.maxJournalBytes}</dd></div>
        </dl>
      </div>}
      {state.notices.map((notice) => <p className="route-state-notice" key={notice}>{notice}</p>)}
    </>}
</section>;

const editorId = (routeId: string, key: string): string =>
  `route-input-${routeId}-${key}`.replace(/[^a-zA-Z0-9_-]/gu, '-');

const contractSummary = (entry: RouteCatalogEntry): string | undefined => {
  const contract = entry.contract;
  if (contract === undefined) return undefined;
  // Route-local contracts use a stable declaration label instead of repeating
  // the route source already shown in the adjacent table cell.
  const origin = contract.origin.module === entry.source
    ? 'declared in this module'
    : contract.origin.module;
  return [
    `Contract ${contract.origin.binding}`,
    origin,
    ...(contract.sharedWith.length === 0 ? [] : [`shared with ${contract.sharedWith.join(', ')}`]),
  ].join(' · ');
};

const scalarControl = (
  routeId: string,
  key: string,
  schema: Exclude<RouteInputPropertySchema, { readonly type: 'array' }>,
  required: boolean,
  value: RouteInputDraftValue | undefined,
  setValue: (value: RouteInputDraftValue | undefined) => void,
): React.ReactNode => {
  const id = editorId(routeId, key);
  switch (schema.type) {
    case 'boolean':
      // A checkbox cannot express "unset", so an optional boolean without a
      // schema default keeps a third omitted state instead of submitting false.
      return required || schema.default !== undefined
        ? <input checked={value === true} id={id} onChange={(event) => setValue(event.currentTarget.checked)} type="checkbox" />
        : <select
            id={id}
            onChange={(event) => setValue(event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true')}
            value={value === true ? 'true' : value === false ? 'false' : ''}
          >
            <option value="">(omitted)</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>;
    case 'number':
      return <input id={id} onChange={(event) => setValue(event.currentTarget.value)} type="number" value={typeof value === 'string' ? value : ''} />;
    case 'string':
      return schema.enum === undefined
        ? <input id={id} onChange={(event) => setValue(event.currentTarget.value)} type="text" value={typeof value === 'string' ? value : ''} />
        : <select id={id} onChange={(event) => setValue(event.currentTarget.value)} value={typeof value === 'string' ? value : ''}>
            <option value="">Select {routeInputLabel(key).toLowerCase()}</option>
            {schema.enum.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
          </select>;
    default: {
      const unreachable: never = schema;
      throw new TypeError(`Unhandled route input control ${String(unreachable)}.`);
    }
  }
};

const RouteInputEditor = ({ digest, entry, group, onOpenMcp }: {
  readonly digest: string;
  readonly entry: RouteCatalogEntry;
  readonly group: RouteCatalogGroup;
  readonly onOpenMcp?: (prefill: McpToolPrefill) => void;
}) => {
  const schema = entry.inputSchema;
  const [stored, setStored] = useAtom(routeEditorStateAtom(routeEditorKey(digest, entry.id)));
  const state = stored ?? initialRouteEditorState(schema);
  const {
    arguments: argumentsValue,
    argv,
    draft,
    errors,
    raw,
    rawError,
  } = state;
  const setValue = (key: string, value: RouteInputDraftValue | undefined): void => {
    setStored((current) => setRouteEditorDraftValue(
      current ?? initialRouteEditorState(schema),
      schema,
      entry.command,
      key,
      value,
    ));
  };
  const validate = (): void => {
    setStored((current) => validateRouteEditor(
      current ?? initialRouteEditorState(schema),
      schema,
      entry.command,
    ));
  };
  const openMcp = (): void => {
    if (argumentsValue === undefined || onOpenMcp === undefined) return;
    const prefill = mcpToolPrefillFor(group, entry, argumentsValue);
    if (prefill !== undefined) onOpenMcp(prefill);
  };

  const contract = contractSummary(entry);
  return <section aria-label={`Input for ${entry.id}`} className="route-input-editor">
    <h3>{schema === undefined ? 'Raw JSON input' : 'Generated input editor'}</h3>
    {contract === undefined ? undefined : <p className="route-input-note">{contract}</p>}
    {schema === undefined
      ? <label htmlFor={editorId(entry.id, 'raw')}>Schema not statically projectable; enter a JSON object.
          <textarea
            aria-invalid={rawError === undefined ? undefined : true}
            id={editorId(entry.id, 'raw')}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setStored((current) => setRouteEditorRaw(
                current ?? initialRouteEditorState(schema),
                next,
              ));
            }}
            rows={4}
            value={raw}
          />
          {rawError === undefined ? undefined : <span className="route-input-error" role="alert">{rawError}</span>}
        </label>
      : Object.keys(schema.properties).sort().map((key) => {
          const property = schema.properties[key]!;
          const label = routeInputLabel(key);
          const required = schema.required?.includes(key) === true;
          const error = errors[key];
          if (property.type !== 'array') {
            return <div className="route-input-field" key={key}>
              <label htmlFor={editorId(entry.id, key)}>{label}{required ? ' (required)' : ''}
                {scalarControl(entry.id, key, property, required, draft[key], (value) => setValue(key, value))}
              </label>
              {property.description === undefined ? undefined : <p>{property.description}</p>}
              {error === undefined ? undefined : <span className="route-input-error" role="alert">{error}</span>}
            </div>;
          }
          const values = Array.isArray(draft[key]) ? draft[key] : [];
          return <fieldset className="route-input-field route-input-array" key={key}>
            <legend>{label}{required ? ' (required)' : ''}</legend>
            {property.description === undefined ? undefined : <p>{property.description}</p>}
            {values.map((value, index) => <div className="route-input-array-row" key={`${key}-${String(index)}`}>
              {/* Array rows exist only after "Add", so items are always set. */}
              {scalarControl(entry.id, `${key}-${String(index)}`, property.items, true, value, (nextValue) => {
                if (nextValue === undefined) return;
                const next = [...values];
                next[index] = nextValue as boolean | string;
                setValue(key, Object.freeze(next));
              })}
              <button onClick={() => setValue(key, Object.freeze(values.filter((_, candidate) => candidate !== index)))} type="button">
                Remove {label} item {String(index + 1)}
              </button>
            </div>)}
            <button onClick={() => setValue(key, Object.freeze([
              ...values,
              property.items.type === 'boolean' ? false : '',
            ]))} type="button">Add {label} item</button>
            {error === undefined ? undefined : <span className="route-input-error" role="alert">{error}</span>}
          </fieldset>;
        })}
    <p className="route-input-note">Full schema validation runs during execution.</p>
    <div className="route-input-actions">
      <button onClick={validate} type="button">Validate input</button>
      {entry.kind === 'tool'
        ? <button disabled={argumentsValue === undefined || onOpenMcp === undefined} onClick={openMcp} type="button">Open in MCP session</button>
        : undefined}
    </div>
    {entry.kind !== 'tool' && entry.kind !== 'cli'
      ? <p className="route-input-honesty">Validation only; this route kind is not invokable from Routes.</p>
      : undefined}
    {argv === undefined ? undefined : <div className="route-cli-invocation">
      <label htmlFor={editorId(entry.id, 'argv')}>Generated argv invocation
        <input id={editorId(entry.id, 'argv')} readOnly value={argv} />
      </label>
      <button onClick={() => { void globalThis.navigator?.clipboard?.writeText(argv); }} type="button">Copy argv</button>
    </div>}
  </section>;
};

// command.projection is decoded and available on the manifest; it surfaces in
// the selected-operation inspector (#600), not on this page.
const commandSummary = (entry: RouteCatalogEntry): string | undefined =>
  entry.command === undefined ? undefined : cliCommandUsage(entry.command);

const RouteGroup = ({ digest, group, onOpenMcp }: {
  readonly digest: string;
  readonly group: RouteCatalogGroup;
  readonly onOpenMcp?: (prefill: McpToolPrefill) => void;
}) => <section
  aria-labelledby={`route-group-${group.serverId ?? 'project'}-${group.kind}`}
  className="route-group"
>
  <div className="route-group-heading">
    <h2 id={`route-group-${group.serverId ?? 'project'}-${group.kind}`}>{group.label}</h2>
    <p>{counted(group.entries.length, 'route')}{group.mode === undefined ? '' : ` · ${group.mode}`}</p>
  </div>
  <table className="route-table">
    <thead><tr><th scope="col">Route ID</th><th scope="col">Source</th><th scope="col">Config and input</th></tr></thead>
    <tbody>{group.entries.map((entry) => <tr key={entry.id}>
      <th scope="row">
        <span className="route-id">{entry.id}</span>
        {entry.event === undefined ? undefined : <span className="route-event">{entry.event}</span>}
        {commandSummary(entry) === undefined ? undefined : <span className="route-command">{commandSummary(entry)}</span>}
        {entry.description === undefined ? undefined : <span className="route-description">{entry.description}</span>}
      </th>
      <td className="route-source">{entry.source}<span className="route-provenance">{entry.provenance}</span></td>
      <td className="route-config">
        <p className="route-config-summary">{configSummary(entry)}</p>
        <RouteInputEditor digest={digest} entry={entry} group={group} onOpenMcp={onOpenMcp} />
      </td>
    </tr>)}</tbody>
  </table>
</section>;

export const RoutesPage = ({ catalog, onOpenMcp }: RoutesPageProps) => <div className="routes-content">
  <div className="page-heading routes-page-heading"><div><h1>Routes</h1><p>{stateSummaries[catalog.state]}</p></div></div>
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
      <StatePanel state={catalog.stateDefinition} />
      {catalog.diagnostics.length === 0 ? undefined : <section aria-label="Route graph diagnostics" className="route-diagnostics">
        <h2>Route diagnostics ({catalog.diagnostics.length})</h2>
        {catalog.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${String(index)}`}>
          <span className={`severity severity--${diagnostic.severity}`}>{diagnostic.severity}</span>
          <span className="route-diagnostic-code">{diagnostic.code}</span>
          {diagnostic.message}
        </p>)}
      </section>}
      {catalog.groups.length === 0 && catalog.servers.length === 0
        ? <p className="empty-row" role="status">This project declares no conventional route modules.</p>
        : <>
          {catalog.servers.filter((server) => server.routeCount === 0)
            .map((server) => <EmptyServerSurface key={server.id} server={server} />)}
          {catalog.groups.map((group) => <RouteGroup
            digest={catalog.digest}
            group={group}
            key={`${catalog.digest}-${group.serverId ?? 'project'}-${group.kind}`}
            onOpenMcp={onOpenMcp}
          />)}
        </>}
      {catalog.providers.length === 0 ? undefined : <section aria-label="Context providers" className="route-group">
        <div className="route-group-heading"><h2>Context providers</h2><p>{counted(catalog.providers.length, 'provider')}</p></div>
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
