import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import {
  McpJsonInput,
  applyFormEdit,
  formSchemaFromJsonSchema,
  parseRawJsonRecord,
  rawJsonDraftState,
  serializeJsonRecord,
  submitJsonRecord,
} from '../src/mcp/mcp-json-input.tsx';

describe('MCP JSON input', () => {
  it('falls back to raw input for unsupported schema shapes and keywords', () => {
    expect(formSchemaFromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })).not.toBeNull();
    expect(formSchemaFromJsonSchema({
      type: 'array',
      items: { type: 'string' },
    })).toBeNull();
    expect(formSchemaFromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string', pattern: '.*' } },
    })).toBeNull();
    expect(formSchemaFromJsonSchema({
      type: 'object',
      properties: { name: { $ref: '#/$defs/name' } },
    })).toBeNull();
  });

  it('makes form edits into a new frozen canonical record and exactly omits cleared optional values', () => {
    const original = { nested: { enabled: false }, name: 'Ada' };
    const edited = applyFormEdit(original, 'name', 'Grace');

    expect(edited).toEqual({ nested: { enabled: false }, name: 'Grace' });
    expect(edited).not.toBe(original);
    expect(edited.nested).not.toBe(original.nested);
    expect(original).toEqual({ nested: { enabled: false }, name: 'Ada' });
    expect(Object.isFrozen(edited)).toBe(true);
    expect(Object.isFrozen(edited.nested)).toBe(true);
    const withoutLimit = applyFormEdit({ limit: 3 }, 'limit', undefined);
    const withoutEnabled = applyFormEdit({ enabled: false, name: '', option: '' }, 'enabled', undefined);
    const withoutName = applyFormEdit({ enabled: false, name: '', option: '' }, 'name', undefined);
    const withoutOption = applyFormEdit({ enabled: false, name: '', option: '' }, 'option', undefined);

    expect(Object.hasOwn(withoutLimit, 'limit')).toBe(false);
    expect(Object.hasOwn(withoutEnabled, 'enabled')).toBe(false);
    expect(Object.hasOwn(withoutName, 'name')).toBe(false);
    expect(Object.hasOwn(withoutOption, 'option')).toBe(false);
    expect(withoutEnabled).toEqual({ name: '', option: '' });
    expect(withoutName).toEqual({ enabled: false, option: '' });
    expect(withoutOption).toEqual({ enabled: false, name: '' });
  });

  it('updates canonical JSON only from a valid raw object and serializes it deterministically', () => {
    const previous = applyFormEdit({}, 'name', 'Ada');

    expect(parseRawJsonRecord('{"name":')).toBeNull();
    expect(parseRawJsonRecord('["Ada"]')).toBeNull();
    expect(parseRawJsonRecord('{"z":1,"a":{"later":true,"first":false}}')).toEqual({
      a: { first: false, later: true },
      z: 1,
    });
    expect(serializeJsonRecord(previous)).toBe('{\n  "name": "Ada"\n}');
    expect(serializeJsonRecord({ z: 1, a: { later: true, first: false } })).toBe(
      '{\n  "a": {\n    "first": false,\n    "later": true\n  },\n  "z": 1\n}',
    );
  });

  it('blocks invalid raw JSON from submitting stale canonical input', () => {
    const submitted: readonly Readonly<Record<string, unknown>>[] = [];
    const submit = (value: Readonly<Record<string, unknown>>) => submitted.push(value);

    expect(submitJsonRecord({ stale: true }, submit, '{"next":')).toBe(false);
    expect(submitted).toEqual([]);
    expect(submitJsonRecord({ stale: true }, submit, '{"next":true}')).toBe(true);
    expect(submitted).toEqual([{ next: true }]);
  });

  it('resets raw validation when replay replaces an invalid draft', () => {
    expect(rawJsonDraftState({ stale: true }, '{"next":').error).toBe('Enter a valid JSON object.');
    expect(rawJsonDraftState({ next: true })).toEqual({
      draft: '{\n  "next": true\n}',
      error: undefined,
    });
  });

  it('renders an accessible mode group and submits equivalent form and raw payloads through one callback', () => {
    const submitted: readonly Readonly<Record<string, unknown>>[] = [];
    const submit = (value: Readonly<Record<string, unknown>>) => submitted.push(value);
    const formValue = applyFormEdit({}, 'count', 2);
    const rawValue = parseRawJsonRecord('{"count":2}');

    expect(rawValue).toEqual(formValue);
    expect(submitJsonRecord(formValue, submit)).toBe(true);
    expect(submitJsonRecord({}, submit, '{"count":2}')).toBe(true);

    expect(submitted).toEqual([{ count: 2 }, { count: 2 }]);
    expect(submitted[0]).not.toBe(submitted[1]);
    expect(Object.isFrozen(submitted[0])).toBe(true);
    expect(Object.isFrozen(submitted[1])).toBe(true);

    const markup = renderToStaticMarkup(createElement(McpJsonInput, {
      id: 'tool-arguments',
      label: 'Tool arguments',
      onChange: () => undefined,
      onSubmit: submit,
      schema: {
        type: 'object',
        properties: {
          count: { default: 3, type: 'number' },
          enabled: { type: 'boolean' },
          name: { type: 'string' },
          option: { enum: ['', 'named'], type: 'string' },
        },
        required: ['count'],
      },
      value: { enabled: false, name: '', option: '' },
    }));

    expect(markup).toContain('<fieldset>');
    expect(markup).toContain('<legend>Tool arguments input mode</legend>');
    expect(markup).toContain('type="radio"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain('role="tabpanel"');
    expect(markup).toContain('required=""');
    expect(markup).toContain('value=""');
    expect(markup).not.toContain('value="3"');
    expect(markup).toContain('Unset enabled');
    expect(markup).toContain('Unset name');
    expect(markup).toContain('Unset option');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Call tool');
  });
});
