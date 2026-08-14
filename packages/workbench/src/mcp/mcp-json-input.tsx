import React, { useEffect, useState } from 'react';

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
): ImmutableJsonRecord => immutableJsonRecord({ ...value, [field]: next });

export const parseRawJsonRecord = (raw: string): ImmutableJsonRecord | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? immutableJsonRecord(parsed) : null;
  } catch {
    return null;
  }
};

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
): void => onSubmit(immutableJsonRecord(value));

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
      const current = value[name] ?? field.default;
      const required = schema.required?.includes(name) ?? false;
      const change = (next: unknown): void => onChange(applyFormEdit(value, name, next));

      if (field.type === 'boolean') {
        return (
          <p key={name}>
            <input checked={current === true} disabled={disabled} id={fieldId} onChange={(event) => change(event.currentTarget.checked)} required={required} type="checkbox" />
            <label htmlFor={fieldId}>{fieldLabel}</label>
            {field.description === undefined ? undefined : <small>{field.description}</small>}
          </p>
        );
      }

      if (field.type === 'string' && field.enum !== undefined) {
        return (
          <p key={name}>
            <label htmlFor={fieldId}>{fieldLabel}</label>
            <select disabled={disabled} id={fieldId} onChange={(event) => change(event.currentTarget.value)} required={required} value={typeof current === 'string' ? current : ''}>
              <option value="">Select {fieldLabel}</option>
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
  const [rawDraft, setRawDraft] = useState(() => serializeJsonRecord(value));
  const [rawError, setRawError] = useState<string>();

  useEffect(() => {
    setRawDraft(serializeJsonRecord(value));
  }, [value]);

  useEffect(() => {
    if (formSchema === null) setMode('raw');
  }, [formSchema]);

  const selectMode = (next: 'form' | 'raw'): void => {
    setMode(next);
    if (next === 'raw') {
      setRawDraft(serializeJsonRecord(value));
      setRawError(undefined);
    }
  };

  const rawPanel = formSchema === null || mode === 'raw';
  const panelId = rawPanel ? `${id}-raw-panel` : `${id}-form-panel`;
  const tabId = rawPanel ? `${id}-raw-tab` : `${id}-form-tab`;
  const rawErrorId = `${id}-raw-error`;

  return (
    <section aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`}>{label}</h3>
      {formSchema === null ? <p>Raw JSON is required because this schema cannot be represented without changing it.</p> : (
        <div aria-label={`${label} input mode`} role="tablist">
          <button aria-controls={`${id}-form-panel`} aria-selected={mode === 'form'} id={`${id}-form-tab`} onClick={() => selectMode('form')} role="tab" type="button">Form</button>
          <button aria-controls={`${id}-raw-panel`} aria-selected={mode === 'raw'} id={`${id}-raw-tab`} onClick={() => selectMode('raw')} role="tab" type="button">Raw JSON</button>
        </div>
      )}
      <div aria-labelledby={tabId} id={panelId} role="tabpanel">
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
                setRawDraft(draft);
                const parsed = parseRawJsonRecord(draft);
                if (parsed === null) {
                  setRawError('Enter a valid JSON object.');
                } else {
                  setRawError(undefined);
                  onChange(parsed);
                }
              }}
              spellCheck={false}
              value={rawDraft}
            />
            {rawError === undefined ? undefined : <p id={rawErrorId} role="alert">{rawError}</p>}
          </>
        ) : <FormEditor disabled={disabled} id={id} onChange={onChange} schema={formSchema} value={value} />}
      </div>
      <button disabled={disabled} onClick={() => submitJsonRecord(value, onSubmit)} type="button">{submitLabel}</button>
    </section>
  );
};
