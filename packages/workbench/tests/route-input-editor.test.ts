import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from '@rstest/core';

import {
  cliCommandArgv,
  defaultRouteInputValue,
  RouteInputEditor,
  routeInputJson,
  routeInputSubmission,
  routeInputValueFromJson,
} from '../src/application/route-input-editor.tsx';
import { cliLeaf, toolLeaf } from './support/workspace-fixtures.ts';

const noop = (): void => undefined;

describe('route input value', () => {
  it('opens a schema leaf on the form with schema defaults and a schema-less leaf on raw JSON', () => {
    const tool = defaultRouteInputValue(toolLeaf);
    expect(tool.mode).toBe('form');
    expect(tool.draft).toEqual({ author: '', limit: '5', regions: [], title: '' });
    expect(tool.attempted).toBe(false);

    const raw = defaultRouteInputValue({ ...toolLeaf, inputSchema: undefined });
    expect(raw.mode).toBe('raw');
    expect(raw.raw).toBe('{}');
  });

  it('seeds the form from JSON that fits the schema and falls back to raw JSON when it does not', () => {
    const fits = routeInputValueFromJson(toolLeaf, { limit: 3, regions: ['us', 'uk'], title: 'Dune' }, 'fixture-1');
    expect(fits.mode).toBe('form');
    expect(fits.draft).toEqual({ limit: '3', regions: ['us', 'uk'], title: 'Dune' });
    expect(fits.fixtureId).toBe('fixture-1');

    const unknownKey = routeInputValueFromJson(toolLeaf, { narrator: 'x', title: 'Dune' });
    expect(unknownKey.mode).toBe('raw');
    expect(unknownKey.raw).toContain('"narrator"');

    const nested = routeInputValueFromJson(toolLeaf, { title: { nested: true } });
    expect(nested.mode).toBe('raw');
  });
});

describe('route input submission', () => {
  it('validates the form against the static grammar and submits typed arguments', () => {
    const missing = routeInputSubmission(toolLeaf, defaultRouteInputValue(toolLeaf));
    expect(missing.draft).toBeUndefined();
    expect(missing.fieldErrors).toEqual({ title: 'Title is required.' });

    const value = routeInputValueFromJson(toolLeaf, { limit: 3, title: 'Dune' });
    const ok = routeInputSubmission(toolLeaf, value);
    expect(ok.draft).toEqual({ input: { limit: 3, title: 'Dune' } });
    expect(routeInputJson(toolLeaf, value)).toEqual({ limit: 3, title: 'Dune' });
  });

  it('rejects invalid raw JSON and non-object raw input for non-CLI leaves', () => {
    const base = defaultRouteInputValue(toolLeaf);
    expect(routeInputSubmission(toolLeaf, { ...base, mode: 'raw', raw: '{"title":' }).error).toBe('Enter a valid JSON object.');
    expect(routeInputSubmission(toolLeaf, { ...base, mode: 'raw', raw: '["Dune"]' }).error).toBe('Arguments must be a JSON object.');
    expect(routeInputSubmission(toolLeaf, { ...base, mode: 'raw', raw: '{"title":"Dune"}' }).draft).toEqual({ input: { title: 'Dune' } });
  });

  it('projects CLI form input through the command grammar into argv, positionals first then flags', () => {
    expect(cliCommandArgv(cliLeaf.command!, { region: ['us', 'uk'], title: 'Dune', verbose: true })).toEqual([
      'Dune', '--region', 'us', '--region', 'uk', '--verbose',
    ]);
    expect(cliCommandArgv(cliLeaf.command!, { verbose: false })).toBeUndefined();

    const value = routeInputValueFromJson(cliLeaf, { region: ['us'], title: 'Dune' });
    const submission = routeInputSubmission(cliLeaf, value);
    expect(submission.draft).toEqual({
      surface: {
        args: ['Dune', '--region', 'us'],
        command: 'audible search',
        kind: 'cli',
      },
    });
    expect(routeInputJson(cliLeaf, value)).toEqual(['Dune', '--region', 'us']);
  });

  it('accepts raw argv arrays and raw option objects for CLI leaves', () => {
    const base = defaultRouteInputValue(cliLeaf);
    expect(routeInputSubmission(cliLeaf, { ...base, mode: 'raw', raw: '["Dune", "--verbose"]' }).draft).toEqual({
      surface: { args: ['Dune', '--verbose'], command: 'audible search', kind: 'cli' },
    });
    expect(routeInputSubmission(cliLeaf, { ...base, mode: 'raw', raw: '{"title":"Dune","verbose":true}' }).draft).toEqual({
      surface: { args: ['Dune', '--verbose'], command: 'audible search', kind: 'cli' },
    });
    expect(routeInputSubmission(cliLeaf, { ...base, mode: 'raw', raw: '[1, 2]' }).error).toContain('JSON array of argv strings');
    // A restored argv array re-opens the CLI leaf in raw mode with the array intact.
    const restored = routeInputValueFromJson(cliLeaf, ['Dune', '--verbose']);
    expect(restored.mode).toBe('raw');
    expect(routeInputSubmission(cliLeaf, restored).draft).toEqual({
      surface: { args: ['Dune', '--verbose'], command: 'audible search', kind: 'cli' },
    });
  });
});

describe('RouteInputEditor', () => {
  it('renders the generated form, the mode switch, fixtures, and the Run control', () => {
    const markup = renderToStaticMarkup(createElement(RouteInputEditor, {
      fixtures: [{ id: 'dune', input: { title: 'Dune' }, label: 'Dune (fixture)' }],
      leaf: toolLeaf,
      onChange: noop,
      onRun: noop,
      running: false,
      value: routeInputValueFromJson(toolLeaf, { title: 'Dune' }, 'dune'),
    }));

    expect(markup).toContain('data-testid="route-input-editor"');
    expect(markup).toContain('data-testid="route-run"');
    expect(markup).toContain('>Run</button>');
    expect(markup).toContain('Ctrl/⌘ + Enter');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('>Form</button>');
    expect(markup).toContain('>Raw JSON</button>');
    expect(markup).toContain('<option value="dune" selected="">Dune (fixture)</option>');
    expect(markup).toContain('Title (required)');
    expect(markup).toContain('The title to search for.');
    expect(markup).toContain('value="Dune"');
    expect(markup).toContain('Add Regions item');
    expect(markup).not.toContain('role="alert"');
  });

  it('shows field errors only after an attempted run and disables controls while running', () => {
    const attempted = renderToStaticMarkup(createElement(RouteInputEditor, {
      leaf: toolLeaf,
      onChange: noop,
      onRun: noop,
      running: false,
      value: { ...defaultRouteInputValue(toolLeaf), attempted: true },
    }));
    expect(attempted).toContain('Title is required.');
    expect(attempted).toContain('Fix the highlighted fields before running.');

    const running = renderToStaticMarkup(createElement(RouteInputEditor, {
      leaf: toolLeaf,
      onChange: noop,
      onRun: noop,
      running: true,
      value: defaultRouteInputValue(toolLeaf),
    }));
    expect(running).toContain('>Running…</button>');
    expect(running).toContain('data-testid="route-run" disabled=""');
  });

  it('previews the argv a CLI leaf submits and falls back to raw JSON for schema-less leaves', () => {
    const cli = renderToStaticMarkup(createElement(RouteInputEditor, {
      leaf: cliLeaf,
      onChange: noop,
      onRun: noop,
      running: false,
      value: routeInputValueFromJson(cliLeaf, { region: ['us'], title: 'Dune', verbose: true }),
    }));
    expect(cli).toContain('Usage: <code>audible search &lt;title&gt; [--region &lt;string&gt; ...] [--verbose]</code>');
    expect(cli).toContain('value="audible search Dune --region us --verbose"');
    expect(cli).toContain('Copy argv');

    const raw = renderToStaticMarkup(createElement(RouteInputEditor, {
      leaf: { ...toolLeaf, inputSchema: undefined },
      onChange: noop,
      onRun: noop,
      running: false,
      value: defaultRouteInputValue({ ...toolLeaf, inputSchema: undefined }),
    }));
    expect(raw).toContain('Input as a JSON object');
    expect(raw).toContain('<textarea');
    expect(raw).toContain('richer than the static grammar');
  });
});
