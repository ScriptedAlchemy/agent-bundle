import { expect, it } from '@rstest/core';

import type {
  RouteInputSchema,
  RouteManifestCliCommand,
} from '../../agent-bundle/src/contracts/routes.ts';
import {
  createRouteInputDraft,
  initialRouteEditorState,
  setRouteEditorDraftValue,
  setRouteEditorRaw,
  validateRouteEditor,
  type RouteEditorState,
} from '../src/routes/routes-model.ts';

const typedSchema: RouteInputSchema = {
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    source: { items: { type: 'string' }, type: 'array' },
  },
  required: ['source'],
  type: 'object',
};

const repeatedCommand: RouteManifestCliCommand = {
  aliases: [],
  exitCode: 'zero',
  options: [
    { key: 'source', kind: 'string', option: 'source', repeated: true, required: true },
    { key: 'enabled', kind: 'boolean', option: 'enabled', repeated: false, required: false },
  ],
  path: ['library', 'import'],
  routeId: 'cli:library/import',
};

const rawCommand: RouteManifestCliCommand = {
  aliases: [],
  exitCode: 'zero',
  options: [
    { key: 'input', kind: 'string', option: 'input', positional: 0, repeated: false, required: true },
  ],
  path: ['library', 'audit'],
  routeId: 'cli:library/audit',
};

it('creates frozen initial editor state with the existing draft defaults', () => {
  const typed = initialRouteEditorState(typedSchema);
  const raw = initialRouteEditorState();

  expect(typed).toEqual({
    attempted: false,
    draft: createRouteInputDraft(typedSchema),
    errors: {},
    raw: '{}',
  });
  expect(raw).toEqual({
    attempted: false,
    draft: {},
    errors: {},
    raw: '{}',
  });
  expect(Object.isFrozen(typed)).toBe(true);
  expect(Object.isFrozen(typed.draft)).toBe(true);
  expect(Object.isFrozen(typed.errors)).toBe(true);
});

it('changes the draft before validation without producing validation output', () => {
  const initial = initialRouteEditorState(typedSchema);
  const edited = setRouteEditorDraftValue(initial, typedSchema, repeatedCommand, 'source', ['audio']);

  expect(edited).toEqual({
    attempted: false,
    draft: { source: ['audio'] },
    errors: {},
    raw: '{}',
  });
});

it('revalidates typed input after an attempt and projects repeated argv options', () => {
  const attempted = validateRouteEditor(initialRouteEditorState(typedSchema), typedSchema, repeatedCommand);
  expect(attempted.errors).toEqual({ source: 'Source is required.' });

  const valid = setRouteEditorDraftValue(attempted, typedSchema, repeatedCommand, 'source', ['audio', 'books']);

  expect(valid.errors).toEqual({});
  expect(valid.arguments).toEqual({ source: ['audio', 'books'] });
  expect(valid.argv).toBe('library import --source audio --source books');
  expect(Object.isFrozen(valid)).toBe(true);
  expect(Object.isFrozen(valid.errors)).toBe(true);
});

it('preserves optional boolean omission through true, false, and undefined', () => {
  const attempted = validateRouteEditor(initialRouteEditorState(typedSchema), typedSchema, repeatedCommand);
  const withSource = setRouteEditorDraftValue(attempted, typedSchema, repeatedCommand, 'source', ['audio']);
  const enabled = setRouteEditorDraftValue(withSource, typedSchema, repeatedCommand, 'enabled', true);
  const disabled = setRouteEditorDraftValue(enabled, typedSchema, repeatedCommand, 'enabled', false);
  const omitted = setRouteEditorDraftValue(disabled, typedSchema, repeatedCommand, 'enabled', undefined);

  expect(enabled.arguments).toEqual({ enabled: true, source: ['audio'] });
  expect(disabled.arguments).toEqual({ enabled: false, source: ['audio'] });
  expect(omitted.arguments).toEqual({ source: ['audio'] });
  expect(Object.hasOwn(omitted.draft, 'enabled')).toBe(false);
});

it('deletes a draft key when the next value is undefined', () => {
  const withValue = setRouteEditorDraftValue(
    initialRouteEditorState(typedSchema),
    typedSchema,
    repeatedCommand,
    'source',
    ['audio'],
  );
  const deleted = setRouteEditorDraftValue(withValue, typedSchema, repeatedCommand, 'source', undefined);

  expect(Object.hasOwn(deleted.draft, 'source')).toBe(false);
});

it('revalidates raw text after an attempt without changing the prior argv', () => {
  const withRaw = setRouteEditorRaw(initialRouteEditorState(), '{"input":"before"}');
  const attempted = validateRouteEditor(withRaw, undefined, rawCommand);
  expect(attempted.argv).toBe('library audit before');

  const changed = setRouteEditorRaw(attempted, '{"input":"after"}');
  expect(changed.arguments).toEqual({ input: 'after' });
  expect(changed.rawError).toBeUndefined();
  expect(changed.argv).toBe('library audit before');

  const invalid = setRouteEditorRaw(changed, '{');
  expect(invalid.arguments).toBeUndefined();
  expect(invalid.rawError).toBe('Enter a valid JSON object.');
  expect(invalid.argv).toBe('library audit before');
});

it('keeps typed and raw validation errors isolated to their respective paths', () => {
  const rawSeed: RouteEditorState = Object.freeze({
    ...initialRouteEditorState(),
    errors: Object.freeze({ retained: 'typed error' }),
  });
  const rawValidated = validateRouteEditor(setRouteEditorRaw(rawSeed, '{'), undefined, rawCommand);
  expect(rawValidated.errors).toEqual({ retained: 'typed error' });
  expect(rawValidated.rawError).toBe('Enter a valid JSON object.');

  const typedSeed: RouteEditorState = Object.freeze({
    ...initialRouteEditorState(typedSchema),
    rawError: 'retained raw error',
  });
  const typedValidated = validateRouteEditor(typedSeed, typedSchema, repeatedCommand);
  expect(typedValidated.errors).toEqual({ source: 'Source is required.' });
  expect(typedValidated.rawError).toBe('retained raw error');
});
