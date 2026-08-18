import React, { type Ref, useState } from 'react';

import type { JsonObject, JsonValue } from '../../../agent-bundle/src/dev/types.ts';

export type ImmutableJsonValue = JsonValue;
export type ImmutableJsonRecord = JsonObject;

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
  additionalProperties?: false;
  description?: string;
  properties: Readonly<Record<string, FormFieldSchema>>;
  required?: readonly string[];
  title?: string;
  type: 'object';
}>;

type McpJsonInputSharedProps = Readonly<{
  disabled?: boolean;
  formLabel?: string;
  id: string;
  invalidJsonLabel?: string;
  label: string;
  onRawDraftChange?: (draft: string) => void;
  rawDraft?: string;
  rawLabel?: string;
  schema?: unknown;
  submitLabel?: string;
  submitRef?: Ref<HTMLButtonElement>;
  submitShortcut?: string;
}>;

type McpJsonRecordInputProps = McpJsonInputSharedProps & Readonly<{
  allowNonObjectJson?: false | undefined;
  onChange: (value: ImmutableJsonRecord) => void;
  onSubmit: (value: ImmutableJsonRecord) => void;
  value: ImmutableJsonRecord;
}>;

type McpJsonValueInputProps = McpJsonInputSharedProps & Readonly<{
  /** Runtime surfaces may intentionally use arrays or primitive JSON values. */
  allowNonObjectJson: true;
  onChange: (value: ImmutableJsonValue) => void;
  onSubmit: (value: ImmutableJsonValue) => void;
  value: ImmutableJsonValue;
}>;

export type McpJsonInputProps = McpJsonRecordInputProps | McpJsonValueInputProps;

const supportedRootKeywords = new Set([
  '$schema',
  'additionalProperties',
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

const isNonNegativeInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value >= 0;

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
  if (value.minLength !== undefined && !isNonNegativeInteger(value.minLength)) return false;
  if (value.maxLength !== undefined && !isNonNegativeInteger(value.maxLength)) return false;
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
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return null;
  if (schema.title !== undefined && typeof schema.title !== 'string') return null;
  if (schema.description !== undefined && typeof schema.description !== 'string') return null;

  const properties: Record<string, FormFieldSchema> = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!isSupportedFieldSchema(field)) return null;
    properties[name] = field;
  }

  let required: readonly string[] | undefined;
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((field) => typeof field === 'string')) return null;
    if (new Set(schema.required).size !== schema.required.length) return null;
    if (!schema.required.every((field) => Object.hasOwn(properties, field))) return null;
    required = Object.freeze([...schema.required]);
  }

  const form: {
    additionalProperties?: false;
    description?: string;
    properties: Readonly<Record<string, FormFieldSchema>>;
    required?: readonly string[];
    title?: string;
    type: 'object';
  } = { properties: Object.freeze(properties), type: 'object' };
  if (schema.additionalProperties === false) form.additionalProperties = false;
  if (typeof schema.description === 'string') form.description = schema.description;
  if (required !== undefined) form.required = required;
  if (typeof schema.title === 'string') form.title = schema.title;
  return Object.freeze(form);
};

const freezeJson = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('JSON numbers must be finite.');
  }
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeJson(entry)])));
  }
  throw new TypeError('Value must be JSON-compatible.');
};

export const immutableJsonValue = (value: JsonValue): ImmutableJsonValue => freezeJson(value);

export const immutableJsonRecord = (value: Readonly<Record<string, unknown>>): ImmutableJsonRecord => {
  const frozen = freezeJson(value);
  if (!isRecord(frozen)) throw new TypeError('McpJsonInput records must be JSON objects.');
  return frozen;
};

export const applyFormEdit = (
  value: ImmutableJsonRecord,
  field: string,
  next: JsonValue | undefined,
): ImmutableJsonRecord => {
  if (next === undefined) {
    return immutableJsonRecord(Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)));
  }
  return immutableJsonRecord({ ...value, [field]: next });
};

/** `undefined` is the parse-failure sentinel: JSON `null` is a valid runtime value. */
export const parseRawJsonValue = (raw: string): ImmutableJsonValue | undefined => {
  try {
    return freezeJson(JSON.parse(raw));
  } catch {
    return undefined;
  }
};

export const parseRawJsonRecord = (raw: string): ImmutableJsonRecord | null => {
  const parsed = parseRawJsonValue(raw);
  return parsed === undefined || !isRecord(parsed) ? null : parsed;
};

type RawJsonDraftState = Readonly<{
  draft: string;
  error: string | undefined;
}>;

const rawJsonError = 'Enter a valid JSON object.';
const rawJsonValueError = 'Enter valid JSON.';

export const rawJsonValueDraftState = (
  value: JsonValue,
  draft = serializeJsonValue(value),
): RawJsonDraftState => ({
  draft,
  error: parseRawJsonValue(draft) === undefined ? rawJsonValueError : undefined,
});

export const rawJsonDraftState = (
  value: ImmutableJsonRecord,
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

export const serializeJsonValue = (value: JsonValue): string =>
  JSON.stringify(sortJson(value), undefined, 2);

export const serializeJsonRecord = (value: ImmutableJsonRecord): string => serializeJsonValue(value);

export const submitJsonValue = (
  value: ImmutableJsonValue,
  onSubmit: (value: ImmutableJsonValue) => void,
  rawDraft?: string,
): boolean => {
  const submitted = rawDraft === undefined ? immutableJsonValue(value) : parseRawJsonValue(rawDraft);
  if (submitted === undefined) return false;
  onSubmit(submitted);
  return true;
};

export const submitJsonRecord = (
  value: ImmutableJsonRecord,
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
  value: ImmutableJsonRecord,
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
  value: ImmutableJsonRecord;
}>) => (
  <div>
    {Object.entries(schema.properties).map(([name, field]) => {
      const fieldId = `${id}-${name}`;
      const fieldLabel = field.title ?? name;
      const current = value[name];
      const required = schema.required?.includes(name) ?? false;
      const missing = required && (!Object.hasOwn(value, name) || current === undefined);
      const errorId = `${fieldId}-error`;
      const validation = {
        'aria-describedby': missing ? errorId : undefined,
        'aria-invalid': missing || undefined,
        'aria-required': required || undefined,
      };
      const fieldError = missing ? <span id={errorId} role="alert">{fieldLabel} is required.</span> : undefined;
      const change = (next: JsonValue | undefined): void => onChange(applyFormEdit(value, name, next));
      const unset = !required && Object.hasOwn(value, name)
        ? <button aria-label={`Unset ${fieldLabel}`} disabled={disabled} onClick={() => change(undefined)} type="button">Unset {fieldLabel}</button>
        : undefined;

      if (field.type === 'boolean') {
        return (
          <p key={name}>
            <label className="mcp-json-input-boolean">
              <input {...validation} checked={current === true} disabled={disabled} id={fieldId} onChange={(event) => change(event.currentTarget.checked)} type="checkbox" />
              {fieldLabel}
            </label>
            {unset}
            {field.description === undefined ? undefined : <small>{field.description}</small>}
            {fieldError}
          </p>
        );
      }

      if (field.type === 'string' && field.enum !== undefined) {
        const unsetValue = enumUnsetValue(id, name, field.enum);
        return (
          <p key={name}>
            <label htmlFor={fieldId}>{fieldLabel}</label>
            <select {...validation} disabled={disabled} id={fieldId} onChange={(event) => change(event.currentTarget.value === unsetValue ? undefined : event.currentTarget.value)} value={typeof current === 'string' ? current : unsetValue}>
              <option disabled={required} value={unsetValue}>{required ? `Select ${fieldLabel}` : `Unset ${fieldLabel}`}</option>
              {field.enum.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            {field.description === undefined ? undefined : <small>{field.description}</small>}
            {fieldError}
          </p>
        );
      }

      if (field.type === 'string') {
        return (
          <p key={name}>
            <label htmlFor={fieldId}>{fieldLabel}</label>
            <input {...validation} disabled={disabled} id={fieldId} maxLength={field.maxLength} minLength={field.minLength} onChange={(event) => change(event.currentTarget.value)} type="text" value={typeof current === 'string' ? current : ''} />
            {unset}
            {field.description === undefined ? undefined : <small>{field.description}</small>}
            {fieldError}
          </p>
        );
      }

      return (
        <p key={name}>
          <label htmlFor={fieldId}>{fieldLabel}</label>
          <input
            {...validation}
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
            step={field.type === 'integer' ? 1 : 'any'}
            type="number"
            value={typeof current === 'number' ? current : ''}
          />
          {field.description === undefined ? undefined : <small>{field.description}</small>}
          {fieldError}
        </p>
      );
    })}
  </div>
);

export const McpJsonInput = (props: McpJsonInputProps) => {
  const {
    disabled = false,
    formLabel = 'Form',
    id,
    invalidJsonLabel,
    label,
    onRawDraftChange,
    rawDraft: controlledRawDraft,
    rawLabel = 'Raw JSON',
    schema,
    submitLabel = 'Call tool',
    submitRef,
    submitShortcut,
    value,
  } = props;
  if ((controlledRawDraft === undefined) !== (onRawDraftChange === undefined)) {
    throw new Error('McpJsonInput rawDraft and onRawDraftChange must be provided together.');
  }
  const controlled = controlledRawDraft !== undefined;
  const recordValue = isRecord(value) ? value : undefined;
  const formSchema = recordValue === undefined ? null : formSchemaFromJsonSchema(schema);
  const rawStateFor = (draft?: string): RawJsonDraftState => {
    if (props.allowNonObjectJson === true) return rawJsonValueDraftState(props.value, draft);
    return rawJsonDraftState(props.value, draft);
  };
  const rawErrorLabel = invalidJsonLabel ?? (props.allowNonObjectJson === true ? rawJsonValueError : rawJsonError);
  const [mode, setMode] = useState<'form' | 'raw'>(() =>
    formSchema === null || rawStateFor(controlledRawDraft).error !== undefined ? 'raw' : 'form');
  const [rawState, setRawState] = useState(() => ({ source: value, ...rawStateFor() }));
  const uncontrolledRawState = rawState.source === value ? rawState : { source: value, ...rawStateFor() };
  if (!controlled && uncontrolledRawState !== rawState) setRawState(uncontrolledRawState);
  const currentRawState = controlled
    ? rawStateFor(controlledRawDraft)
    : uncontrolledRawState;
  const { draft: rawDraft, error: rawError } = currentRawState;

  const selectMode = (next: 'form' | 'raw'): void => {
    setMode(next);
    if (next === 'raw' && !controlled) {
      setRawState({ source: value, ...rawStateFor() });
    }
  };

  const rawPanel = formSchema === null || mode === 'raw';
  const rawSubmissionValid = !rawPanel || rawError === undefined;
  const formSubmissionValid = formSchema === null || (recordValue !== undefined && !hasMissingRequiredFormValue(formSchema, recordValue));
  const rawErrorId = `${id}-raw-error`;

  const change = (next: ImmutableJsonValue): void => {
    if (props.allowNonObjectJson === true) {
      props.onChange(next);
      return;
    }
    if (isRecord(next)) props.onChange(next);
  };

  const submit = (): void => {
    if (props.allowNonObjectJson === true) {
      submitJsonValue(props.value, props.onSubmit, rawPanel ? rawDraft : undefined);
      return;
    }
    submitJsonRecord(props.value, props.onSubmit, rawPanel ? rawDraft : undefined);
  };

  return (
    <section aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`}>{label}</h3>
      {formSchema === null ? <p>Raw JSON is required because this schema cannot be represented without changing it.</p> : (
        <fieldset>
          <legend>{label} input mode</legend>
          <label><input checked={mode === 'form'} disabled={disabled} name={`${id}-mode`} onChange={() => selectMode('form')} type="radio" />{formLabel}</label>
          <label><input checked={mode === 'raw'} disabled={disabled} name={`${id}-mode`} onChange={() => selectMode('raw')} type="radio" />{rawLabel}</label>
        </fieldset>
      )}
      <div>
        {rawPanel ? (
          <>
            <label htmlFor={`${id}-raw`}>{rawLabel}</label>
            <textarea
              aria-describedby={rawError === undefined ? undefined : rawErrorId}
              aria-invalid={rawError === undefined ? undefined : true}
              disabled={disabled}
              id={`${id}-raw`}
              onChange={(event) => {
                const draft = event.currentTarget.value;
                if (controlled) onRawDraftChange!(draft);
                else setRawState({ source: value, ...rawStateFor(draft) });
                if (props.allowNonObjectJson === true) {
                  const parsed = parseRawJsonValue(draft);
                  if (parsed !== undefined) props.onChange(parsed);
                } else {
                  const parsed = parseRawJsonRecord(draft);
                  if (parsed !== null) props.onChange(parsed);
                }
              }}
              spellCheck={false}
              value={rawDraft}
            />
            {rawError === undefined ? undefined : <p id={rawErrorId} role="alert">{rawErrorLabel}</p>}
          </>
        ) : formSchema === null || recordValue === undefined
          ? undefined
          : <FormEditor disabled={disabled} id={id} onChange={change} schema={formSchema} value={recordValue} />}
      </div>
      <button aria-keyshortcuts={submitShortcut} disabled={disabled || !rawSubmissionValid || !formSubmissionValid} onClick={submit} ref={submitRef} type="button">{submitLabel}</button>
    </section>
  );
};
