import React, { useState } from 'react';

export type ImmutableJsonRecord = Readonly<Record<string, unknown>>;

type FormFieldType = 'boolean' | 'integer' | 'number' | 'string';

type FormFieldSchema = Readonly<{
  default?: boolean | number | string;
  description?: string;
  enum?: readonly string[];
  maximum?: number;
  minimum?: number;
  maxLength?: number;
  minLength?: number;
  title?: string;
  type: FormFieldType;
}>;

type FormSchema = Readonly<{
  description?: string;
  properties: Readonly<Record<string, FormFieldSchema>>;
  required?: readonly string[];
  title?: string;
  type: 'object';
}>;

export type McpJsonInputProps = Readonly<{
  disabled?: boolean;
  id: string;
  label: string;
  onChange: (value: ImmutableJsonRecord) => void;
  onSubmit: (value: ImmutableJsonRecord) => void;
  schema?: unknown;
  submitLabel?: string;
  value: Readonly<Record<string, unknown>>;
}>;

const supportedRootKeywords = new Set([
  '$schema',
  'description',
  'properties',
  'required',
  'title',
  'type',
]);

const supportedFieldKeywords = new Set([
  'default',
  'description',
  'enum',
  'maximum',
  'minimum',
  'maxLength',
  'minLength',
  'title',
  'type',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isSupportedDefault = (type: string, value: unknown): boolean => {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return isFiniteNumber(value) && Number.isInteger(value);
    case 'number':
      return isFiniteNumber(value);
    default:
      return false;
  }
};

const isSupportedFieldSchema = (value: unknown): value is FormFieldSchema => {
  if (!isRecord(value) || !hasOnlyKeys(value, supportedFieldKeywords)) return false;
  if (!['string', 'number', 'integer', 'boolean'].includes(value.type as string)) return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  if (value.default !== undefined && !isSupportedDefault(value.type as string, value.default)) return false;

  if (value.enum !== undefined) {
    if (value.type !== 'string' || !Array.isArray(value.enum) || !value.enum.every((item) => typeof item === 'string')) return false;
  }

  if (value.minimum !== undefined && !isFiniteNumber(value.minimum)) return false;
  if (value.maximum !== undefined && !isFiniteNumber(value.maximum)) return false;
  if (value.minLength !== undefined && (!Number.isInteger(value.minLength) || value.minLength < 0)) return false;
  if (value.maxLength !== undefined && (!Number.isInteger(value.maxLength) || value.maxLength < 0)) return false;
  return true;
};

/**
 * Narrows only the schema subset that the embedded form can represent exactly.
 * All other JSON Schema features stay available through raw JSON rather than
 * being silently reinterpreted by a partial form.
 */
export const formSchemaFromJsonSchema = (schema: unknown): FormSchema | null => {
  if (!isRecord(schema) || !hasOnlyKeys(schema, supportedRootKeywords)) return null;
  if (schema.type !== 'object' || !isRecord(schema.properties)) return null;
  if (schema.$schema !== undefined && typeof schema.$schema !== 'string') return null;
  if (schema.title !== undefined && typeof schema.title !== 'string') return null;
  if (schema.description !== undefined && typeof schema.description !== 'string') return null;

  const properties = schema.properties;
  if (!Object.values(properties).every(isSupportedFieldSchema)) return null;

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((field) => typeof field === 'string')) return null;
    if (new Set(schema.required).size !== schema.required.length) return null;
    if (!schema.required.every((field) => Object.hasOwn(properties, field))) return null;
  }

  return schema as FormSchema;
};

const freezeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeJson(entry)])));
  }
  return value;
};

export const immutableJsonRecord = (value: Readonly<Record<string, unknown>>): ImmutableJsonRecord =>
  freezeJson(value) as ImmutableJsonRecord;

export const applyFormEdit = (
  value: Readonly<Record<string, unknown>>,
  field: string,
  next: unknown,
): ImmutableJsonRecord => {
  if (next === undefined) {
    return immutableJsonRecord(Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)));
  }
  return immutableJsonRecord({ ...value, [field]: next });
};

export const parseRawJsonRecord = (raw: string): ImmutableJsonRecord | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? immutableJsonRecord(parsed) : null;
  } catch {
    return null;
  }
};

type RawJsonDraftState = Readonly<{
  draft: string;
  error: string | undefined;
}>;

const rawJsonError = 'Enter a valid JSON object.';

export const rawJsonDraftState = (
  value: Readonly<Record<string, unknown>>,
  draft = serializeJsonRecord(value),
): RawJsonDraftState => ({
  draft,
  error: parseRawJsonRecord(draft) === null ? rawJsonError : undefined,
});

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
};

export const serializeJsonRecord = (value: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(sortJson(value), undefined, 2);

export const submitJsonRecord = (
  value: Readonly<Record<string, unknown>>,
  onSubmit: (value: ImmutableJsonRecord) => void,
  rawDraft?: string,
): boolean => {
  const submitted = rawDraft === undefined ? immutableJsonRecord(value) : parseRawJsonRecord(rawDraft);
  if (submitted === null) return false;
  onSubmit(submitted);
  return true;
};

const hasMissingRequiredFormValue = (
  schema: FormSchema,
  value: Readonly<Record<string, unknown>>,
): boolean => schema.required?.some((field) => !Object.hasOwn(value, field) || value[field] === undefined) ?? false;

const enumUnsetValue = (id: string, field: string, options: readonly string[]): string => {
  let value = `__agent_bundle_unset_${id}_${field}__`;
  while (options.includes(value)) value = `${value}_`;
  return value;
};

const FormEditor = ({
  disabled,
  id,
  onChange,
  schema,
  value,
}: Readonly<{
  disabled: boolean;
  id: string;
  onChange: (value: ImmutableJsonRecord) => void;
  schema: FormSchema;
  value: Readonly<Record<string, unknown>>;
}>) => (
  <div>
    {Object.entries(schema.properties).map(([name, field]) => {
      const fieldId = `${id}-${name}`;
      const fieldLabel = field.title ?? name;
      const current = value[name];
      const required = schema.required?.includes(name) ?? false;
      const change = (next: unknown): void => onChange(applyFormEdit(value, name, next));
      const unset = !required && Object.hasOwn(value, name)
        ? <button aria-label={`Unset ${fieldLabel}`} onClick={() => change(undefined)} type="button">Unset {fieldLabel}</button>
        : undefined;

      if (field.type === 'boolean') {
        return (
          <p key={name}>
            <input checked={current === true} disabled={disabled} id={fieldId} onChange={(event) => change(event.currentTarget.checked)} required={required} type="checkbox" />
            <label htmlFor={fieldId}>{fieldLabel}</label>
            {unset}
            {field.description === undefined ? undefined : <small>{field.description}</small>}
          </p>
        );
      }

      if (field.type === 'string' && field.enum !== undefined) {
        const unsetValue = enumUnsetValue(id, name, field.enum);
        return (
          <p key={name}>
            <label htmlFor={fieldId}>{fieldLabel}</label>
            <select disabled={disabled} id={fieldId} onChange={(event) => change(event.currentTarget.value === unsetValue ? undefined : event.currentTarget.value)} required={required} value={typeof current === 'string' ? current : unsetValue}>
              <option disabled={required} value={unsetValue}>{required ? `Select ${fieldLabel}` : `Unset ${fieldLabel}`}</option>
              {field.enum.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            {field.description === undefined ? undefined : <small>{field.description}</small>}
          </p>
        );
      }

      if (field.type === 'string') {
        return (
          <p key={name}>
            <label htmlFor={fieldId}>{fieldLabel}</label>
            <input disabled={disabled} id={fieldId} maxLength={field.maxLength} minLength={field.minLength} onChange={(event) => change(event.currentTarget.value)} required={required} type="text" value={typeof current === 'string' ? current : ''} />
            {unset}
            {field.description === undefined ? undefined : <small>{field.description}</small>}
          </p>
        );
      }

      return (
        <p key={name}>
          <label htmlFor={fieldId}>{fieldLabel}</label>
          <input
            disabled={disabled}
            id={fieldId}
            max={field.maximum}
            min={field.minimum}
            onChange={(event) => {
              if (event.currentTarget.value === '') {
                change(undefined);
                return;
              }
              const next = event.currentTarget.valueAsNumber;
              if (!Number.isFinite(next) || (field.type === 'integer' && !Number.isInteger(next))) return;
              change(next);
            }}
            required={required}
            step={field.type === 'integer' ? 1 : 'any'}
            type="number"
            value={typeof current === 'number' ? current : ''}
          />
          {field.description === undefined ? undefined : <small>{field.description}</small>}
        </p>
      );
    })}
  </div>
);

export const McpJsonInput = ({
  disabled = false,
  id,
  label,
  onChange,
  onSubmit,
  schema,
  submitLabel = 'Call tool',
  value,
}: McpJsonInputProps) => {
  const formSchema = formSchemaFromJsonSchema(schema);
  const [mode, setMode] = useState<'form' | 'raw'>(formSchema === null ? 'raw' : 'form');
  const [rawState, setRawState] = useState(() => ({ source: value, ...rawJsonDraftState(value) }));
  const currentRawState = rawState.source === value ? rawState : { source: value, ...rawJsonDraftState(value) };
  if (currentRawState !== rawState) setRawState(currentRawState);
  const { draft: rawDraft, error: rawError } = currentRawState;

  const selectMode = (next: 'form' | 'raw'): void => {
    setMode(next);
    if (next === 'raw') {
      setRawState({ source: value, ...rawJsonDraftState(value) });
    }
  };

  const rawPanel = formSchema === null || mode === 'raw';
  const rawSubmissionValid = !rawPanel || rawError === undefined;
  const formSubmissionValid = formSchema === null || !hasMissingRequiredFormValue(formSchema, value);
  const rawErrorId = `${id}-raw-error`;

  return (
    <section aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`}>{label}</h3>
      {formSchema === null ? <p>Raw JSON is required because this schema cannot be represented without changing it.</p> : (
        <fieldset>
          <legend>{label} input mode</legend>
          <label><input checked={mode === 'form'} disabled={disabled} name={`${id}-mode`} onChange={() => selectMode('form')} type="radio" />Form</label>
          <label><input checked={mode === 'raw'} disabled={disabled} name={`${id}-mode`} onChange={() => selectMode('raw')} type="radio" />Raw JSON</label>
        </fieldset>
      )}
      <div>
        {rawPanel ? (
          <>
            <label htmlFor={`${id}-raw`}>Raw JSON object</label>
            <textarea
              aria-describedby={rawError === undefined ? undefined : rawErrorId}
              aria-invalid={rawError === undefined ? undefined : true}
              disabled={disabled}
              id={`${id}-raw`}
              onChange={(event) => {
                const draft = event.currentTarget.value;
                const nextRawState = rawJsonDraftState(value, draft);
                setRawState({ source: value, ...nextRawState });
                const parsed = parseRawJsonRecord(draft);
                if (parsed !== null) onChange(parsed);
              }}
              spellCheck={false}
              value={rawDraft}
            />
            {rawError === undefined ? undefined : <p id={rawErrorId} role="alert">{rawError}</p>}
          </>
        ) : <FormEditor disabled={disabled} id={id} onChange={onChange} schema={formSchema} value={value} />}
      </div>
      <button disabled={disabled || !rawSubmissionValid || !formSubmissionValid} onClick={() => submitJsonRecord(value, onSubmit, rawPanel ? rawDraft : undefined)} type="button">{submitLabel}</button>
    </section>
  );
};
