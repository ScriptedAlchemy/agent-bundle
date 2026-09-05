import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { createRsbuild } from '@rsbuild/core';

import { createWorkbenchFixtureConfig } from './support/workbench-fixture-config.ts';
import { browserLaunchOptions } from './support/workbench-e2e.ts';
import { chromium } from 'playwright';
import { describe, expect, it } from '@rstest/core';
import type { JsonValue } from '../../agent-bundle/src/dev/types.ts';

import {
  McpJsonInput,
  applyFormEdit,
  formSchemaFromJsonSchema,
  parseRawJsonValue,
  parseRawJsonRecord,
  rawJsonDraftState,
  serializeJsonValue,
  serializeJsonRecord,
  submitJsonValue,
  submitJsonRecord,
} from '../src/mcp/mcp-json-input.tsx';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const inputComponent = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-json-input.tsx');
const workbenchStyles = join(workspaceRoot, 'packages', 'workbench', 'src', 'styles.css');

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('MCP JSON input fixture did not receive a TCP address.');
  return `http://127.0.0.1:${address.port}`;
};

const mountedInputFixture = async (source: readonly string[]) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-json-input-'));
  const entry = join(root, 'input.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, source.join('\n'));
  const rsbuild = await createRsbuild({
    config: createWorkbenchFixtureConfig({ distRoot: dist, entry: { input: entry } }),
    cwd: workspaceRoot,
  });
  const build = await rsbuild.build();
  await build.close();
  const assets = await readdir(dist, { recursive: true });
  if (!assets.includes('input.html')) throw new Error('MCP JSON input fixture did not produce its browser document.');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const asset = pathname === '/' ? 'input.html' : pathname.slice(1);
    const file = join(dist, asset);
    if (relative(dist, file).startsWith('..')) return response.writeHead(404).end();
    try {
      const body = await readFile(file);
      const contentType = asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html';
      response.writeHead(200, { 'content-type': contentType }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const origin = await listen(server);
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(root, { force: true, recursive: true });
    },
    url: `${origin}/input.html`,
  };
};

const mountedControlledInputFixture = async () => mountedInputFixture([
    "import React, { useState } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { McpJsonInput } from ${JSON.stringify(inputComponent)};`,
    '',
    'const edits = [];',
    'const App = () => {',
    "  const [rawDraft, setRawDraft] = useState('{\\\"name\\\":');",
    "  const [value, setValue] = useState({ name: 'initial' });",
    "  return <><McpJsonInput id=\"controlled-input\" label=\"Controlled input\" onChange={setValue} onRawDraftChange={(draft) => { edits.push(draft); setRawDraft(draft); }} onSubmit={() => undefined} rawDraft={rawDraft} value={value} /><button onClick={() => setValue({ name: 'canonical replacement' })} type=\"button\">Replace canonical</button><button onClick={() => setRawDraft('{\\\"intentional\\\":true}')} type=\"button\">Replace draft</button></>;",
    '};',
    "createRoot(document.getElementById('root')).render(<App />);",
    'globalThis.__mcpJsonInputFixture = { edits: () => [...edits] };',
]);

describe('MCP JSON input', () => {
  it('falls back to raw input for unsupported schema shapes and keywords', () => {
    expect(formSchemaFromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })).not.toBeNull();
    expect(formSchemaFromJsonSchema({
      additionalProperties: false,
      type: 'object',
      properties: { limit: { maximum: 50, minimum: 1, type: 'integer' } },
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

  it('preserves full JSON values in explicit raw-value mode without coercing them to objects', () => {
    const submitted: JsonValue[] = [];
    const fixture = Object.freeze(['one', Object.freeze({ enabled: true })]) satisfies JsonValue;
    const markup = renderToStaticMarkup(createElement(McpJsonInput, {
      allowNonObjectJson: true,
      id: 'runtime-value',
      label: 'Runtime value',
      onChange: (value) => submitted.push(value),
      onSubmit: (value) => submitted.push(value),
      value: fixture,
    }));

    expect(parseRawJsonValue('["two",false]')).toEqual(['two', false]);
    expect(serializeJsonValue(fixture)).toBe('[\n  "one",\n  {\n    "enabled": true\n  }\n]');
    expect(submitJsonValue(fixture, (value) => submitted.push(value), 'null')).toBe(true);
    expect(submitted).toEqual([null]);
    expect(markup).toContain('Raw JSON is required because this schema cannot be represented without changing it.');
    expect(markup).toContain('[\n  &quot;one&quot;');
    expect(markup).not.toContain('Schema form');
  });

  it('blocks invalid raw JSON from submitting stale canonical input', () => {
    const submitted: Readonly<Record<string, unknown>>[] = [];
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

  it('preserves a controlled invalid raw draft across canonical input changes and rejects half-controlled usage', () => {
    const controlled = renderToStaticMarkup(createElement(McpJsonInput, {
      id: 'controlled-input',
      label: 'Controlled input',
      onChange: () => undefined,
      onRawDraftChange: () => undefined,
      onSubmit: () => undefined,
      rawDraft: '{"name":',
      value: { name: 'canonical replacement' },
    }));

    expect(controlled).toContain('{&quot;name&quot;:');
    expect(controlled).toContain('Enter a valid JSON object.');
    expect(() => renderToStaticMarkup(createElement(McpJsonInput, {
      id: 'half-controlled-input',
      label: 'Half controlled input',
      onChange: () => undefined,
      onSubmit: () => undefined,
      rawDraft: '{"name":',
      value: {},
    }))).toThrow('McpJsonInput rawDraft and onRawDraftChange must be provided together.');
  });

  it('reports each controlled raw edit while canonical replacements leave the repair draft untouched', async () => {
    const fixture = await mountedControlledInputFixture();
    const browser = await chromium.launch(browserLaunchOptions);
    try {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      const raw = page.locator('#controlled-input-raw');
      await raw.fill('{"name":"edited"');
      expect(await raw.inputValue()).toBe('{"name":"edited"');
      expect(await page.getByRole('alert').textContent()).toBe('Enter a valid JSON object.');
      await page.getByRole('button', { name: 'Replace canonical' }).click();
      expect(await raw.inputValue()).toBe('{"name":"edited"');
      expect(await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpJsonInputFixture: { edits(): readonly string[] };
      }).__mcpJsonInputFixture.edits())).toContain('{"name":"edited"');
      await page.getByRole('button', { name: 'Replace draft' }).click();
      expect(await raw.inputValue()).toBe('{"intentional":true}');
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 30_000);

  it('keeps boolean schema controls accessible and wholly inside their 40px Runtime input label target', async () => {
    const fixture = await mountedInputFixture([
      "import React, { useState } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      `import ${JSON.stringify(workbenchStyles)};`,
      `import { McpJsonInput } from ${JSON.stringify(inputComponent)};`,
      '',
      "const schema = { type: 'object', properties: { enabled: { title: 'Enable notifications', type: 'boolean' } } };",
      'const App = () => {',
      '  const [disabled, setDisabled] = useState(false);',
      '  const [value, setValue] = useState({ enabled: false });',
      '  return <main className="runtime-input"><McpJsonInput disabled={disabled} id="boolean-input" label="Boolean input" onChange={setValue} onSubmit={() => undefined} schema={schema} value={value} /><output data-testid="boolean-value">{String(value.enabled)}</output><button onClick={() => setDisabled(true)} type="button">Disable checkbox</button></main>;',
      '};',
      "createRoot(document.getElementById('root')).render(<App />);",
    ]);
    const browser = await chromium.launch(browserLaunchOptions);
    const page = await browser.newPage({ viewport: { height: 844, width: 390 } });
    try {
      await page.goto(fixture.url);
      const checkbox = page.getByRole('checkbox', { name: 'Enable notifications' });
      const label = page.locator('label.mcp-json-input-boolean');
      await checkbox.waitFor({ state: 'visible' });
      await label.waitFor({ state: 'visible' });
      const geometry = await page.evaluate(() => {
        const checkbox = globalThis.document.querySelector('#boolean-input-enabled');
        if (!(checkbox instanceof globalThis.HTMLInputElement)) throw new Error('Boolean input was absent.');
        const label = checkbox.closest('label');
        if (!(label instanceof globalThis.HTMLLabelElement)) throw new Error('Boolean input label was absent.');
        const control = checkbox.getBoundingClientRect();
        const target = label.getBoundingClientRect();
        return Object.freeze({
          associated: [...checkbox.labels ?? []].includes(label),
          controlBottom: control.bottom,
          controlLeft: control.left,
          controlRight: control.right,
          controlTop: control.top,
          label: label.textContent?.trim(),
          targetBottom: target.bottom,
          targetHeight: target.height,
          targetLeft: target.left,
          targetRight: target.right,
          targetTop: target.top,
          viewportWidth: globalThis.innerWidth,
        });
      });

      expect(geometry.associated).toBe(true);
      expect(geometry.label).toBe('Enable notifications');
      expect(geometry.targetHeight).toBeGreaterThanOrEqual(40);
      expect(geometry.targetLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.targetRight).toBeLessThanOrEqual(geometry.viewportWidth);
      expect(geometry.controlLeft).toBeGreaterThanOrEqual(geometry.targetLeft);
      expect(geometry.controlRight).toBeLessThanOrEqual(geometry.targetRight);
      expect(geometry.controlTop).toBeGreaterThanOrEqual(geometry.targetTop);
      expect(geometry.controlBottom).toBeLessThanOrEqual(geometry.targetBottom);

      await label.click();
      expect(await checkbox.isChecked()).toBe(true);
      await checkbox.focus();
      await page.keyboard.press('Space');
      expect(await checkbox.isChecked()).toBe(false);
      await page.getByRole('button', { name: 'Disable checkbox' }).click();
      expect(await checkbox.isDisabled()).toBe(true);
      await label.evaluate((element) => (element as HTMLLabelElement).click());
      expect(await checkbox.isChecked()).toBe(false);
      await page.keyboard.press('Space');
      expect(await checkbox.isChecked()).toBe(false);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 30_000);

  it('renders an accessible mode group and submits equivalent form and raw payloads through one callback', () => {
    const submitted: Readonly<Record<string, unknown>>[] = [];
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
    expect(markup).toContain('aria-required="true"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('value=""');
    expect(markup).not.toContain('value="3"');
    expect(markup).toContain('Unset enabled');
    expect(markup).toContain('Unset name');
    expect(markup).toContain('Unset option');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Call tool');
  });

  it('uses custom required presence validation and disables every mutation control in a browser', async () => {
    const browser = await chromium.launch(browserLaunchOptions);
    const page = await browser.newPage();
    try {
      await page.setContent(renderToStaticMarkup(createElement(McpJsonInput, {
        disabled: true,
        id: 'disabled-input',
        label: 'Disabled input',
        onChange: () => undefined,
        onSubmit: () => undefined,
        schema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            name: { type: 'string' },
            option: { enum: ['', 'named'], type: 'string' },
          },
        },
        value: { enabled: false, name: '', option: '' },
      })));

      expect(await page.locator([
        '#disabled-input-enabled',
        '#disabled-input-name',
        '#disabled-input-option',
        'button[aria-label="Unset enabled"]',
        'button[aria-label="Unset name"]',
      ].join(', ')).evaluateAll((controls) => controls.map((control) => (control as HTMLButtonElement).disabled))).toEqual([true, true, true, true, true]);

      await page.setContent(renderToStaticMarkup(createElement(McpJsonInput, {
        id: 'required-input',
        label: 'Required input',
        onChange: () => undefined,
        onSubmit: () => undefined,
        schema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            name: { type: 'string' },
            option: { enum: ['', 'named'], type: 'string' },
          },
          required: ['enabled', 'name', 'option'],
        },
        value: { enabled: false, name: '', option: '' },
      })));

      expect(await page.evaluate(() => ['enabled', 'name', 'option'].map((name) => {
        const control = document.querySelector(`#required-input-${name}`) as HTMLInputElement;
        return {
          ariaInvalid: control.getAttribute('aria-invalid'),
          ariaRequired: control.getAttribute('aria-required'),
          nativeRequired: control.required,
          valid: control.checkValidity(),
        };
      }))).toEqual([
        { ariaInvalid: null, ariaRequired: 'true', nativeRequired: false, valid: true },
        { ariaInvalid: null, ariaRequired: 'true', nativeRequired: false, valid: true },
        { ariaInvalid: null, ariaRequired: 'true', nativeRequired: false, valid: true },
      ]);
      expect(await page.getByRole('button', { name: 'Call tool' }).isDisabled()).toBe(false);

      await page.setContent(renderToStaticMarkup(createElement(McpJsonInput, {
        id: 'missing-input',
        label: 'Missing input',
        onChange: () => undefined,
        onSubmit: () => undefined,
        schema: { type: 'object', properties: { count: { default: 3, type: 'number' } }, required: ['count'] },
        value: {},
      })));
      expect(await page.evaluate(() => {
        const input = document.querySelector('#missing-input-count') as HTMLInputElement;
        return {
          ariaInvalid: input.getAttribute('aria-invalid'),
          ariaRequired: input.getAttribute('aria-required'),
          nativeRequired: input.required,
          valid: input.checkValidity(),
        };
      })).toEqual({ ariaInvalid: 'true', ariaRequired: 'true', nativeRequired: false, valid: true });
      expect(await page.getByRole('alert').textContent()).toBe('count is required.');
      expect(await page.getByRole('button', { name: 'Call tool' }).isDisabled()).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
