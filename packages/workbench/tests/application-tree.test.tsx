import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { ApplicationTree } from '../src/application/application-tree-model.ts';
import { ApplicationTreeView } from '../src/application/application-tree.tsx';

const tree: ApplicationTree = {
  diagnostics: [],
  groups: [{
    key: 'mcp',
    kind: 'mcp',
    label: 'MCP',
    servers: [{
      key: 'mcp:library',
      label: 'library',
      mode: 'generated',
      server: 'library',
      subgroups: [{
        key: 'mcp:library:tools',
        label: 'Tools',
        leaves: [{
          config: [],
          execution: 'invoke',
          key: '/routes/mcp/library/tool/search',
          label: 'search',
          ref: { kind: 'tool', name: 'search', server: 'library' },
          routeId: 'tool:library/search',
          source: 'src/mcp/library/tools/search.ts',
        }],
      }],
    }],
  }, {
    key: 'skills',
    kind: 'skills',
    label: 'Skills',
    leaves: [{
      config: [],
      execution: 'document',
      key: '/routes/skills/review',
      label: 'Review',
      ref: { id: 'review', kind: 'skill' },
      source: 'skills/review/SKILL.md',
    }],
  }],
  leafCount: 2,
  state: 'fresh',
};

const render = (
  value: ApplicationTree = tree,
  selected = tree.groups[0]!.kind === 'mcp'
    ? tree.groups[0]!.servers[0]!.subgroups[0]!.leaves[0]!.ref
    : undefined,
): string => renderToStaticMarkup(createElement(ApplicationTreeView, {
  onQueryChange: () => undefined,
  onSelect: () => undefined,
  query: '',
  selected,
  tree: value,
}));

it('renders an accessible expanded application tree with counts and selection', () => {
  const markup = render();

  expect(markup).toContain('>Filter application</span>');
  expect(markup).toMatch(/<label[^>]*for="([^"]+)"[^>]*>.*<input id="\1"/u);
  expect(markup).toContain('data-testid="application-tree"');
  expect(markup).toContain('role="tree"');
  expect(markup.match(/role="treeitem"/gu)).toHaveLength(6);
  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain('MCP');
  expect(markup).toContain('library');
  expect(markup).toContain('Tools');
  expect(markup).toContain('Skills');
  expect(markup.match(/aria-label="1 item"/gu)).toHaveLength(4);
});

it('shows stale and unavailable banners with the supplied message', () => {
  const stale = render({ ...tree, message: 'Rebuild to publish these routes.', state: 'stale' });
  const unavailable = render({ ...tree, message: 'Manifest unavailable.', state: 'unavailable' });

  expect(stale).toContain('role="status"');
  expect(stale).toContain('Rebuild to publish these routes.');
  expect(unavailable).toContain('role="alert"');
  expect(unavailable).toContain('Manifest unavailable.');
});

it('renders a clear empty state and preserves the controlled filter value', () => {
  const markup = renderToStaticMarkup(createElement(ApplicationTreeView, {
    onQueryChange: () => undefined,
    onSelect: () => undefined,
    query: 'missing',
    tree: { ...tree, groups: [], leafCount: 0 },
  }));

  expect(markup).toContain('value="missing"');
  expect(markup).toContain('No application surfaces match this filter.');
});
