import { expect, test } from '@rstest/core';
import React from 'react';

import { runtimeDefinition } from '../src/definition.js';
import {
  claudeStableAppDomain,
  mergeSerializableMetadata,
  resourceMetadata,
} from '../src/mcp/host-metadata.js';
import {
  createWidgetStateAdapter,
  safeAreaCustomProperties,
} from '../src/widget/host-adapters.js';

test('keeps the MCP Apps widget portable when no vendor capability exists', () => {
  const adapter = createWidgetStateAdapter(undefined);
  const metadata = resourceMetadata(runtimeDefinition.resources[0]);

  expect(adapter.kind).toBe('portable');
  expect(adapter.restore(['concept-1', 'concept-2'])).toBeUndefined();
  adapter.persist('concept-2');
  expect(adapter.restore(['concept-1', 'concept-2'])).toBeUndefined();
  expect(metadata.ui).not.toHaveProperty('domain');
  expect(JSON.stringify(metadata)).not.toContain('claudemcpcontent.com');
});

test('restores and synchronously persists only valid documented widget state', () => {
  const writes: unknown[] = [];
  const adapter = createWidgetStateAdapter({
    openai: {
      setWidgetState: (value: unknown) => {
        writes.push(value);
      },
      widgetState: { selectedEventId: 'concept-2' },
    },
  });

  expect(adapter.kind).toBe('openai');
  expect(adapter.restore(['concept-1', 'concept-2'])).toBe('concept-2');
  adapter.persist('concept-1');
  expect(writes).toEqual([{ selectedEventId: 'concept-1' }]);

  const malformed = createWidgetStateAdapter({
    openai: { setWidgetState: () => undefined, widgetState: { selectedEventId: 12 } },
  });
  expect(malformed.restore(['concept-1', 'concept-2'])).toBeUndefined();
});

test('derives the optional Claude resource domain only from a supplied public URL', () => {
  expect(claudeStableAppDomain('https://example.com/mcp')).toBe('c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com');
  expect(resourceMetadata(runtimeDefinition.resources[0], 'https://example.com/mcp')).toMatchObject({
    ui: { domain: 'c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com' },
  });
});

test('preserves arbitrary serializable extension metadata without changing complete portable data', () => {
  const extension = { 'example.acme/trace': { requestId: 'trace-7', retry: false } };
  const merged = mergeSerializableMetadata({ 'openai/outputTemplate': 'ui://timeline' }, extension);
  const resource = resourceMetadata({
    ...runtimeDefinition.resources[0],
    _meta: { ...runtimeDefinition.resources[0]._meta, ...extension },
  });

  expect(merged).toEqual({
    'example.acme/trace': { requestId: 'trace-7', retry: false },
    'openai/outputTemplate': 'ui://timeline',
  });
  expect(resource).toMatchObject(extension);
  expect(resource).not.toHaveProperty('ui.domain');
});

test('exposes standard safe-area values without choosing a host product', () => {
  expect(
    safeAreaCustomProperties({
      platform: 'mobile',
      safeAreaInsets: { bottom: 34, left: 11, right: 13, top: 47 },
      styles: { variables: { '--color-background-primary': '#10162a', '--font-mono': 'Fira Code' } },
      theme: 'dark',
    }),
  ).toEqual({
    '--timeline-safe-area-bottom': '34px',
    '--timeline-safe-area-left': '11px',
    '--timeline-safe-area-right': '13px',
    '--timeline-safe-area-top': '47px',
  });
});
