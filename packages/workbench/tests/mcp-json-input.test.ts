import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import {
  McpJsonInput,
  applyFormEdit,
  formSchemaFromJsonSchema,
  parseRawJsonRecord,
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

  it('makes form edits into a new frozen canonical record', () => {
    const original = { nested: { enabled: false }, name: 'Ada' };
    const edited = applyFormEdit(original, 'name', 'Grace');

    expect(edited).toEqual({ nested: { enabled: false }, name: 'Grace' });
    expect(edited).not.toBe(original);
    expect(edited.nested).not.toBe(original.nested);
    expect(original).toEqual({ nested: { enabled: false }, name: 'Ada' });
    expect(Object.isFrozen(edited)).toBe(true);
    expect(Object.isFrozen(edited.nested)).toBe(true);
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

  it('renders an accessible form/raw chooser and submits equivalent immutable payloads through one callback', () => {
    const submitted: readonly Readonly<Record<string, unknown>>[] = [];
    const submit = (value: Readonly<Record<string, unknown>>) => submitted.push(value);
    const formValue = applyFormEdit({}, 'count', 2);
    const rawValue = parseRawJsonRecord('{"count":2}');

    submitJsonRecord(formValue, submit);
    submitJsonRecord(rawValue!, submit);

    expect(submitted).toEqual([{ count: 2 }, { count: 2 }]);
    expect(submitted[0]).not.toBe(submitted[1]);
    expect(Object.isFrozen(submitted[0])).toBe(true);
    expect(Object.isFrozen(submitted[1])).toBe(true);

    const markup = renderToStaticMarkup(createElement(McpJsonInput, {
      id: 'tool-arguments',
      label: 'Tool arguments',
      onChange: () => undefined,
      onSubmit: submit,
      schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
      value: formValue,
    }));

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-controls="tool-arguments-form-panel"');
    expect(markup).toContain('aria-controls="tool-arguments-raw-panel"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('required=""');
    expect(markup).toContain('Call tool');
  });
});
