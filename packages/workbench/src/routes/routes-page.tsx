import React, { useState } from 'react';

import type { RouteInputPropertySchema } from '../../../agent-bundle/src/contracts/routes.ts';
import {
  cliCommandInvocation,
  cliCommandUsage,
  createRouteInputDraft,
  mcpToolPrefillFor,
  routeInputLabel,
  validateRawRouteInput,
  validateRouteInput,
  type McpToolPrefill,
  type RouteCatalog,
  type RouteCatalogEntry,
  type RouteCatalogGroup,
  type RouteCatalogServer,
  type RouteInputArguments,
  type RouteInputDraft,
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

const editorId = (routeId: string, key: string): string =>
  `route-input-${routeId}-${key}`.replace(/[^a-zA-Z0-9_-]/gu, '-');

const scalarControl = (
  routeId: string,
  key: string,
  schema: Exclude<RouteInputPropertySchema, { readonly type: 'array' }>,
  value: RouteInputDraftValue | undefined,
  setValue: (value: RouteInputDraftValue) => void,
): React.ReactNode => {
  const id = editorId(routeId, key);
  switch (schema.type) {
    case 'boolean':
      return <input checked={value === true} id={id} onChange={(event) => setValue(event.currentTarget.checked)} type="checkbox" />;
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

const RouteInputEditor = ({ entry, group, onOpenMcp }: {
  readonly entry: RouteCatalogEntry;
  readonly group: RouteCatalogGroup;
  readonly onOpenMcp?: (prefill: McpToolPrefill) => void;
}) => {
  const schema = entry.inputSchema;
  const [draft, setDraft] = useState<RouteInputDraft>(() => schema === undefined ? Object.freeze({}) : createRouteInputDraft(schema));
  const [raw, setRaw] = useState('{}');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [rawError, setRawError] = useState<string>();
  const [attempted, setAttempted] = useState(false);
  const [argumentsValue, setArgumentsValue] = useState<RouteInputArguments>();
  const [argv, setArgv] = useState<string>();

  const commitValidation = (next: RouteInputDraft): void => {
    if (schema === undefined || !attempted) return;
    const validated = validateRouteInput(schema, next);
    setErrors(validated.errors);
    setArgumentsValue(validated.arguments);
    setArgv(validated.arguments === undefined || entry.command === undefined
      ? undefined
      : cliCommandInvocation(entry.command, validated.arguments));
  };
  const setValue = (key: string, value: RouteInputDraftValue): void => {
    const next = Object.freeze({ ...draft, [key]: value });
    setDraft(next);
    commitValidation(next);
  };
  const validate = (): void => {
    setAttempted(true);
    if (schema === undefined) {
      const validated = validateRawRouteInput(raw);
      setRawError(validated.error);
      setArgumentsValue(validated.arguments);
      setArgv(validated.arguments === undefined || entry.command === undefined
        ? undefined
        : cliCommandInvocation(entry.command, validated.arguments));
      return;
    }
    const validated = validateRouteInput(schema, draft);
    setErrors(validated.errors);
    setArgumentsValue(validated.arguments);
    setArgv(validated.arguments === undefined || entry.command === undefined
      ? undefined
      : cliCommandInvocation(entry.command, validated.arguments));
  };
  const openMcp = (): void => {
    if (argumentsValue === undefined || onOpenMcp === undefined) return;
    const prefill = mcpToolPrefillFor(group, entry, argumentsValue);
    if (prefill !== undefined) onOpenMcp(prefill);
  };

  return <section aria-label={`Input for ${entry.id}`} className="route-input-editor">
    <h3>{schema === undefined ? 'Raw JSON input' : 'Generated input editor'}</h3>
    {schema === undefined
      ? <label htmlFor={editorId(entry.id, 'raw')}>Schema not statically projectable; enter a JSON object.
          <textarea
            aria-invalid={rawError === undefined ? undefined : true}
            id={editorId(entry.id, 'raw')}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setRaw(next);
              if (attempted) {
                const validated = validateRawRouteInput(next);
                setRawError(validated.error);
                setArgumentsValue(validated.arguments);
              }
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
                {scalarControl(entry.id, key, property, draft[key], (value) => setValue(key, value))}
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
              {scalarControl(entry.id, `${key}-${String(index)}`, property.items, value, (nextValue) => {
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

const commandSummary = (entry: RouteCatalogEntry): string | undefined =>
  entry.command === undefined ? undefined : cliCommandUsage(entry.command);

const RouteGroup = ({ group, onOpenMcp }: {
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
        <RouteInputEditor entry={entry} group={group} onOpenMcp={onOpenMcp} />
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
