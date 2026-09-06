/**
 * The schema-driven input editor of the route workspace (#600), lifted from
 * the deleted Routes page. One editor serves every executable leaf kind:
 *
 * - a generated form from the route's bounded `inputSchema`, or raw JSON when
 *   the schema is richer than the static grammar (always switchable);
 * - for CLI leaves, the same form projected through the compiled command
 *   grammar into the argv the routed CLI receives, with a preview;
 * - fixtures (the served lifecycle catalog's native host payloads for event
 *   leaves) and the last input the user ran, restored by the workspace.
 *
 * The editor is controlled: it reports every edit through `onChange` and
 * `routeInputSubmission` turns the value into the request draft the backend
 * receives. Full schema validation runs during execution; this editor only
 * enforces the static grammar.
 */
import React from 'react';

import type { RouteInputPropertySchema, RouteManifestCliCommand } from '../../../agent-bundle/src/contracts/routes.ts';
import type { JsonObject, JsonValue } from '../../../agent-bundle/src/contracts/strict-json.ts';
import {
  cliCommandUsage,
  createRouteInputDraft,
  routeInputLabel,
  validateRawRouteInput,
  validateRouteInput,
  type RouteInputArguments,
  type RouteInputDraft,
  type RouteInputDraftValue,
} from '../routes/routes-model.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import type { RouteInputFixture, RouteInvocationDraft } from './workspace-contracts.ts';
import './workspace.css';

export type RouteInputMode = 'form' | 'raw';

export interface RouteInputValue {
  /** True once the user tried to run; field errors show only after that. */
  readonly attempted: boolean;
  readonly draft: RouteInputDraft;
  /** The fixture the value was seeded from, cleared by any edit. */
  readonly fixtureId?: string;
  readonly mode: RouteInputMode;
  readonly raw: string;
}

export type RouteInputSubmission =
  | Readonly<{ readonly draft: RouteInvocationDraft; readonly error?: undefined; readonly fieldErrors?: undefined }>
  | Readonly<{ readonly draft?: undefined; readonly error: string; readonly fieldErrors?: Readonly<Record<string, string>> }>;

const rawJson = (value: JsonValue): string => JSON.stringify(value, null, 2);

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const draftValueFromJson = (schema: RouteInputPropertySchema, value: JsonValue): RouteInputDraftValue | undefined => {
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) => typeof item === 'boolean' ? item : typeof item === 'string' || typeof item === 'number' ? String(item) : undefined);
    return items.every((item) => item !== undefined) ? Object.freeze(items as (boolean | string)[]) : undefined;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
};

/**
 * Projects a JSON object onto the schema form when every known property fits
 * the static grammar; otherwise the caller falls back to raw mode so no input
 * is silently dropped.
 */
const draftFromJson = (leaf: ApplicationLeaf, input: JsonObject): RouteInputDraft | undefined => {
  const schema = leaf.inputSchema;
  if (schema === undefined) return undefined;
  const entries: [string, RouteInputDraftValue][] = [];
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key];
    if (property === undefined) return undefined;
    const draftValue = draftValueFromJson(property, value);
    if (draftValue === undefined) return undefined;
    entries.push([key, draftValue]);
  }
  return Object.freeze(Object.fromEntries(entries));
};

/** Schema defaults (or `{}` for raw-only leaves) — the value a fresh leaf opens with. */
export const defaultRouteInputValue = (leaf: ApplicationLeaf): RouteInputValue => Object.freeze({
  attempted: false,
  draft: leaf.inputSchema === undefined ? Object.freeze({}) : createRouteInputDraft(leaf.inputSchema),
  mode: leaf.inputSchema === undefined ? 'raw' : 'form',
  raw: '{}',
});

/**
 * Seeds the editor from a JSON input (the last input, a fixture, a loaded
 * invocation's `input`): the form when it fits the schema, raw JSON otherwise.
 */
export const routeInputValueFromJson = (leaf: ApplicationLeaf, input: JsonValue, fixtureId?: string): RouteInputValue => {
  const base = defaultRouteInputValue(leaf);
  const draft = isJsonObject(input) ? draftFromJson(leaf, input) : undefined;
  return Object.freeze({
    ...base,
    ...(fixtureId === undefined ? {} : { fixtureId }),
    ...(draft === undefined
      ? { mode: 'raw' as const, raw: rawJson(input) }
      : { draft, mode: 'form' as const, raw: rawJson(input) }),
  });
};

/** The routed CLI's argv after the command path, in the grammar's positional-then-flag order. */
export const cliCommandArgv = (
  command: RouteManifestCliCommand,
  argumentsValue: RouteInputArguments,
): readonly string[] | undefined => {
  const argv: string[] = [];
  const append = (option: RouteManifestCliCommand['options'][number], positional: boolean): boolean => {
    const value = argumentsValue[option.key];
    if (option.kind === 'boolean') {
      if (value === true && !positional) argv.push(`--${option.option}`);
      return value !== undefined || !option.required;
    }
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    if (values.length === 0) return !option.required;
    for (const item of values) {
      if (!positional) argv.push(`--${option.option}`);
      argv.push(String(item));
    }
    return true;
  };
  const positionals = command.options.filter((option) => option.positional !== undefined)
    .toSorted((left, right) => left.positional! - right.positional!);
  if (positionals.some((option) => !append(option, true))) return undefined;
  for (const option of command.options.filter((candidate) => candidate.positional === undefined)) {
    if (!append(option, false)) return undefined;
  }
  return Object.freeze(argv);
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const parseRawArgs = (raw: string): readonly string[] | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    return isStringArray(value) ? Object.freeze([...value]) : undefined;
  } catch {
    return undefined;
  }
};

const cliSurfaceDraft = (command: NonNullable<ApplicationLeaf['command']>, args: readonly string[]): RouteInputSubmission =>
  Object.freeze({
    draft: Object.freeze({
      surface: Object.freeze({ args, command: command.path.join(' '), kind: 'cli' }),
    }),
  });

const cliDraft = (leaf: ApplicationLeaf, argumentsValue: RouteInputArguments): RouteInputSubmission => {
  if (leaf.command === undefined) return Object.freeze({ error: 'This CLI route has no compiled command grammar to build argv from.' });
  const args = cliCommandArgv(leaf.command, argumentsValue);
  return args === undefined
    ? Object.freeze({ error: 'A required CLI option is missing.' })
    : cliSurfaceDraft(leaf.command, args);
};

/** The validated input the current editor value submits, or why it cannot run. */
export const routeInputSubmission = (
  leaf: ApplicationLeaf,
  value: RouteInputValue,
  cliSurface = leaf.ref.kind === 'cli',
): RouteInputSubmission => {
  if (value.mode === 'raw' || leaf.inputSchema === undefined) {
    if (cliSurface) {
      const args = parseRawArgs(value.raw);
      if (args !== undefined && leaf.command !== undefined) return cliSurfaceDraft(leaf.command, args);
    }
    const validated = validateRawRouteInput(value.raw);
    if (validated.error !== undefined || validated.arguments === undefined) {
      return Object.freeze({ error: cliSurface ? 'Enter a JSON array of argv strings or a JSON object of option values.' : validated.error ?? 'Enter a valid JSON object.' });
    }
    return cliSurface ? cliDraft(leaf, validated.arguments) : Object.freeze({ draft: Object.freeze({ input: validated.arguments }) });
  }
  const validated = validateRouteInput(leaf.inputSchema, value.draft);
  if (validated.arguments === undefined) {
    return Object.freeze({ error: 'Fix the highlighted fields before running.', fieldErrors: validated.errors });
  }
  return cliSurface ? cliDraft(leaf, validated.arguments) : Object.freeze({ draft: Object.freeze({ input: validated.arguments }) });
};

/** The JSON the workspace persists as the leaf's last input: the argv array for CLI leaves, the input object otherwise. */
export const routeInputJson = (
  leaf: ApplicationLeaf,
  value: RouteInputValue,
  cliSurface = leaf.ref.kind === 'cli',
): JsonValue | undefined => {
  const submission = routeInputSubmission(leaf, value, cliSurface);
  if (submission.draft === undefined) return undefined;
  return submission.draft.surface?.kind === 'cli'
    ? Object.freeze([...submission.draft.surface.args])
    : submission.draft.input;
};

const editorId = (leafKey: string, key: string): string =>
  `route-input-${leafKey}-${key}`.replace(/[^a-zA-Z0-9_-]/gu, '-');

const scalarControl = (
  leafKey: string,
  key: string,
  schema: Exclude<RouteInputPropertySchema, { readonly type: 'array' }>,
  required: boolean,
  value: RouteInputDraftValue | undefined,
  setValue: (value: RouteInputDraftValue | undefined) => void,
  disabled: boolean,
): React.ReactNode => {
  const id = editorId(leafKey, key);
  switch (schema.type) {
    case 'boolean':
      // A checkbox cannot express "unset", so an optional boolean without a
      // schema default keeps a third omitted state instead of submitting false.
      return required || schema.default !== undefined
        ? <input checked={value === true} disabled={disabled} id={id} onChange={(event) => setValue(event.currentTarget.checked)} type="checkbox" />
        : <select
            disabled={disabled}
            id={id}
            onChange={(event) => setValue(event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true')}
            value={value === true ? 'true' : value === false ? 'false' : ''}
          >
            <option value="">(omitted)</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>;
    case 'number':
      return <input disabled={disabled} id={id} onChange={(event) => setValue(event.currentTarget.value)} type="number" value={typeof value === 'string' ? value : ''} />;
    case 'string':
      return schema.enum === undefined
        ? <input disabled={disabled} id={id} onChange={(event) => setValue(event.currentTarget.value)} type="text" value={typeof value === 'string' ? value : ''} />
        : <select disabled={disabled} id={id} onChange={(event) => setValue(event.currentTarget.value)} value={typeof value === 'string' ? value : ''}>
            <option value="">Select {routeInputLabel(key).toLowerCase()}</option>
            {schema.enum.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
          </select>;
    default: {
      const unreachable: never = schema;
      throw new TypeError(`Unhandled route input control ${String(unreachable)}.`);
    }
  }
};

export interface RouteInputEditorProps {
  readonly cliSurface?: boolean;
  readonly disabled?: boolean;
  readonly fixtures?: readonly RouteInputFixture[];
  readonly leaf: ApplicationLeaf;
  readonly onChange: (value: RouteInputValue) => void;
  readonly onRun: () => void;
  readonly running: boolean;
  readonly value: RouteInputValue;
}

const isRunShortcut = (event: React.KeyboardEvent): boolean =>
  event.key === 'Enter' && (event.metaKey || event.ctrlKey);

/** The workspace's input panel: form or raw JSON, fixtures, argv preview, and Run. */
export const RouteInputEditor = ({ cliSurface, disabled = false, fixtures = [], leaf, onChange, onRun, running, value }: RouteInputEditorProps): React.ReactNode => {
  const schema = leaf.inputSchema;
  const submission = routeInputSubmission(leaf, value, cliSurface);
  const fieldErrors = value.attempted && submission.fieldErrors !== undefined ? submission.fieldErrors : {};
  const rawError = value.attempted && value.mode === 'raw' && submission.error !== undefined ? submission.error : undefined;
  const locked = disabled || running;
  const setDraftValue = (key: string, next: RouteInputDraftValue | undefined): void => {
    const entries = { ...value.draft };
    if (next === undefined) {
      delete entries[key];
    } else {
      entries[key] = next;
    }
    onChange(Object.freeze({ ...value, draft: Object.freeze(entries), fixtureId: undefined }));
  };
  const setMode = (mode: RouteInputMode): void => {
    if (mode === value.mode) return;
    if (mode === 'raw') {
      // Carry the form over so switching never loses an edit.
      const json = routeInputJson(leaf, value, cliSurface);
      onChange(Object.freeze({ ...value, mode, raw: json === undefined ? value.raw : rawJson(json) }));
      return;
    }
    const validated = validateRawRouteInput(value.raw);
    const draft = validated.arguments === undefined ? undefined : draftFromJson(leaf, validated.arguments);
    onChange(Object.freeze({ ...value, draft: draft ?? value.draft, mode }));
  };
  const selectFixture = (fixtureId: string): void => {
    const fixture = fixtures.find((candidate) => candidate.id === fixtureId);
    onChange(fixture === undefined ? defaultRouteInputValue(leaf) : routeInputValueFromJson(leaf, fixture.input, fixture.id));
  };
  const run = (): void => {
    if (locked) return;
    if (submission.draft === undefined) {
      onChange(Object.freeze({ ...value, attempted: true }));
      return;
    }
    onRun();
  };
  const argv = submission.draft?.surface?.kind !== 'cli'
    ? undefined
    : [submission.draft.surface.command, ...submission.draft.surface.args].join(' ');

  return <section
    aria-label={`Input for ${leaf.label}`}
    className="route-input-editor"
    data-testid="route-input-editor"
    onKeyDown={(event) => { if (isRunShortcut(event)) { event.preventDefault(); run(); } }}
  >
    <div className="route-input-toolbar">
      <div aria-label="Input mode" className="route-input-modes" role="group">
        <button
          aria-pressed={value.mode === 'form'}
          disabled={schema === undefined || locked}
          onClick={() => setMode('form')}
          title={schema === undefined ? 'This route\u2019s schema is richer than the static grammar; edit raw JSON.' : undefined}
          type="button"
        >Form</button>
        <button aria-pressed={value.mode === 'raw'} disabled={locked} onClick={() => setMode('raw')} type="button">Raw JSON</button>
      </div>
      {fixtures.length === 0 ? undefined : <label className="route-input-fixture">
        <span>Fixture</span>
        <select disabled={locked} onChange={(event) => selectFixture(event.currentTarget.value)} value={value.fixtureId ?? ''}>
          <option value="">Custom input</option>
          {fixtures.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label}</option>)}
        </select>
      </label>}
      <button className="route-input-reset" disabled={locked} onClick={() => onChange(defaultRouteInputValue(leaf))} type="button">Reset</button>
    </div>
    {value.mode === 'raw' || schema === undefined
      ? <label className="route-input-raw" htmlFor={editorId(leaf.key, 'raw')}>
          <span>{cliSurface === true || leaf.ref.kind === 'cli' ? 'Argv as a JSON array, or option values as a JSON object' : 'Input as a JSON object'}</span>
          <textarea
            aria-invalid={rawError === undefined ? undefined : true}
            disabled={locked}
            id={editorId(leaf.key, 'raw')}
            onChange={(event) => onChange(Object.freeze({ ...value, fixtureId: undefined, raw: event.currentTarget.value }))}
            rows={Math.min(24, Math.max(4, value.raw.split('\n').length + 1))}
            spellCheck={false}
            value={value.raw}
          />
          {rawError === undefined ? undefined : <span className="route-input-error" role="alert">{rawError}</span>}
        </label>
      : <div className="route-input-fields">
        {Object.keys(schema.properties).sort().map((key) => {
          const property = schema.properties[key]!;
          const label = routeInputLabel(key);
          const required = schema.required?.includes(key) === true;
          const error = fieldErrors[key];
          if (property.type !== 'array') {
            return <div className="route-input-field" key={key}>
              <label htmlFor={editorId(leaf.key, key)}>{label}{required ? ' (required)' : ''}
                {scalarControl(leaf.key, key, property, required, value.draft[key], (next) => setDraftValue(key, next), locked)}
              </label>
              {property.description === undefined ? undefined : <p>{property.description}</p>}
              {error === undefined ? undefined : <span className="route-input-error" role="alert">{error}</span>}
            </div>;
          }
          const values = Array.isArray(value.draft[key]) ? value.draft[key] : [];
          return <fieldset className="route-input-field route-input-array" key={key}>
            <legend>{label}{required ? ' (required)' : ''}</legend>
            {property.description === undefined ? undefined : <p>{property.description}</p>}
            {values.map((item, index) => <div className="route-input-array-row" key={`${key}-${String(index)}`}>
              {/* Array rows exist only after "Add", so items are always set. */}
              {scalarControl(leaf.key, `${key}-${String(index)}`, property.items, true, item, (next) => {
                if (next === undefined) return;
                const nextValues = [...values];
                nextValues[index] = next as boolean | string;
                setDraftValue(key, Object.freeze(nextValues));
              }, locked)}
              <button disabled={locked} onClick={() => setDraftValue(key, Object.freeze(values.filter((_, candidate) => candidate !== index)))} type="button">
                Remove {label} item {String(index + 1)}
              </button>
            </div>)}
            <button disabled={locked} onClick={() => setDraftValue(key, Object.freeze([
              ...values,
              property.items.type === 'boolean' ? false : '',
            ]))} type="button">Add {label} item</button>
            {error === undefined ? undefined : <span className="route-input-error" role="alert">{error}</span>}
          </fieldset>;
        })}
      </div>}
    {leaf.command === undefined ? undefined : <div className="route-input-argv">
      <p className="route-input-note">Usage: <code>{cliCommandUsage(leaf.command)}</code></p>
      <label htmlFor={editorId(leaf.key, 'argv')}>Argv the routed CLI receives
        <input id={editorId(leaf.key, 'argv')} readOnly value={argv ?? ''} />
      </label>
      {argv === undefined ? undefined : <button onClick={() => { void globalThis.navigator?.clipboard?.writeText(argv); }} type="button">Copy argv</button>}
    </div>}
    <div className="route-input-actions">
      <button
        className="route-run"
        data-testid="route-run"
        disabled={locked}
        onClick={run}
        title="Run (Ctrl/⌘ + Enter)"
        type="button"
      >{running ? 'Running…' : 'Run'}</button>
      <span className="route-input-shortcut">Ctrl/⌘ + Enter</span>
      {value.attempted && submission.error !== undefined && value.mode !== 'raw'
        ? <span className="route-input-error" role="alert">{submission.error}</span>
        : undefined}
    </div>
  </section>;
};