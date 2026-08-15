import { expect, it } from '@rstest/core';

import {
  cloneMcpAppFiniteJson,
  inspectMcpAppMetadata,
  isMcpAppToolVisible,
  mergeMcpAppResourceMetadata,
  projectMcpAppResult,
  selectMcpAppResourceReference,
} from '../src/dev/mcp-app-metadata.ts';

it('keeps a validated CallToolResult whole for the App while projecting only content and structuredContent to the model', () => {
  const result = {
    _meta: { privateToken: 'do-not-transcribe' },
    content: [
      { text: 'Timeline updated.', type: 'text' },
      { data: 'AA==', mimeType: 'image/png', type: 'image' },
      { data: 'AA==', mimeType: 'audio/mpeg', type: 'audio' },
      { name: 'timeline.json', type: 'resource_link', uri: 'ui://rsc-agent-runtime/timeline.json' },
    ],
    isError: true,
    structuredContent: { changed: true, revision: 8 },
    vendorPrivate: { executable: 'do-not-transcribe' },
  };

  const inspection = projectMcpAppResult(result);
  result.content[0]!.text = 'mutated';
  result.structuredContent.changed = false;

  expect(inspection.isError).toBe(true);
  expect(inspection.appVisible).toEqual({
    _meta: { privateToken: 'do-not-transcribe' },
    content: [
      { text: 'Timeline updated.', type: 'text' },
      { data: 'AA==', mimeType: 'image/png', type: 'image' },
      { data: 'AA==', mimeType: 'audio/mpeg', type: 'audio' },
      { name: 'timeline.json', type: 'resource_link', uri: 'ui://rsc-agent-runtime/timeline.json' },
    ],
    isError: true,
    structuredContent: { changed: true, revision: 8 },
    vendorPrivate: { executable: 'do-not-transcribe' },
  });
  expect(inspection.modelVisible).toEqual({
    content: [
      { text: 'Timeline updated.', type: 'text' },
      { data: 'AA==', mimeType: 'image/png', type: 'image' },
      { data: 'AA==', mimeType: 'audio/mpeg', type: 'audio' },
      { name: 'timeline.json', type: 'resource_link', uri: 'ui://rsc-agent-runtime/timeline.json' },
    ],
    structuredContent: { changed: true, revision: 8 },
  });
  expect(JSON.stringify(inspection.modelVisible)).not.toContain('_meta');
  expect(JSON.stringify(inspection.modelVisible)).not.toContain('vendorPrivate');
  expect(JSON.stringify(inspection.modelVisible)).not.toContain('isError');
  expect(Object.isFrozen(inspection.appVisible)).toBe(true);
  expect(Object.isFrozen(inspection.modelVisible)).toBe(true);
});

it('rejects malformed or non-finite tool results before projection', () => {
  expect(() => projectMcpAppResult({ content: 'not-an-array' })).toThrow('CallToolResult');
  expect(() => projectMcpAppResult({ content: [{ type: 'text', text: Number.NaN }] })).toThrow('finite JSON');
  const cyclic: { content: unknown[]; self?: unknown } = { content: [] };
  cyclic.self = cyclic;
  expect(() => projectMcpAppResult(cyclic)).toThrow('finite JSON');
});

it('accepts only the MCP content-block union and object-shaped structuredContent', () => {
  const inspection = projectMcpAppResult({
    _meta: { private: true },
    content: [
      { text: 'text', type: 'text' },
      { data: 'AA==', mimeType: 'image/png', type: 'image' },
      { data: 'AA==', mimeType: 'audio/mpeg', type: 'audio' },
      { name: 'timeline', type: 'resource_link', uri: 'ui://rsc-agent-runtime/timeline.json' },
      { resource: { mimeType: 'application/json', text: '{}', uri: 'ui://rsc-agent-runtime/timeline.json' }, type: 'resource' },
    ],
    structuredContent: { revisions: 8 },
    unknownRoot: { retainedForApp: true },
  });

  expect(inspection.appVisible).toMatchObject({ _meta: { private: true }, unknownRoot: { retainedForApp: true } });
  expect(inspection.modelVisible).toEqual({
    content: [
      { text: 'text', type: 'text' },
      { data: 'AA==', mimeType: 'image/png', type: 'image' },
      { data: 'AA==', mimeType: 'audio/mpeg', type: 'audio' },
      { name: 'timeline', type: 'resource_link', uri: 'ui://rsc-agent-runtime/timeline.json' },
      { resource: { mimeType: 'application/json', text: '{}', uri: 'ui://rsc-agent-runtime/timeline.json' }, type: 'resource' },
    ],
    structuredContent: { revisions: 8 },
  });
  expect(() => projectMcpAppResult({ content: [{ type: 'image' }] })).toThrow('content');
  expect(() => projectMcpAppResult({ content: [{ text: 'unknown', type: 'vendor' }] })).toThrow('content');
  expect(() => projectMcpAppResult({ content: [], structuredContent: [] })).toThrow('structuredContent');
});

it('accepts empty protocol strings and sanctioned _meta while rejecting malformed optional content fields', () => {
  expect(projectMcpAppResult({
    _meta: { 'com.example/result': { retained: true } },
    content: [{ _meta: { 'com.example/content': { retained: true } }, text: '', type: 'text' }],
  })).toMatchObject({
    appVisible: { content: [{ text: '', type: 'text' }] },
    modelVisible: { content: [{ text: '', type: 'text' }] },
  });
  expect(() => projectMcpAppResult({ content: [{ name: '', size: 'wrong', type: 'resource_link', uri: '' }] })).toThrow('content');
  expect(() => projectMcpAppResult({ content: [{ icons: [{ src: 1 }], name: '', type: 'resource_link', uri: '' }] })).toThrow('content');
  expect(() => projectMcpAppResult({ content: [{ annotations: { audience: [1] }, data: '', mimeType: '', type: 'image' }] })).toThrow('content');
  expect(() => projectMcpAppResult({ content: [{ resource: { text: '', title: 1, uri: '' }, type: 'resource' }] })).toThrow('content');
});

it('preserves own __proto__ JSON properties without prototype mutation', () => {
  const source = JSON.parse('{"__proto__":{"root":true},"nested":{"__proto__":{"nested":true}}}') as unknown;
  const cloned = cloneMcpAppFiniteJson(source) as Record<string, unknown>;

  expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
  expect(Object.hasOwn(cloned, '__proto__')).toBe(true);
  expect(cloned.__proto__).toEqual({ root: true });
  expect(Object.getPrototypeOf(cloned.nested as object)).toBe(Object.prototype);
  expect(Object.hasOwn(cloned.nested as object, '__proto__')).toBe(true);
  expect(JSON.stringify(cloned)).toBe('{"__proto__":{"root":true},"nested":{"__proto__":{"nested":true}}}');
});

it('partitions standard, vendor, and unclassified metadata without rewriting it', () => {
  const metadata = inspectMcpAppMetadata({
    'claude/foo': { declaredDomain: 'example.claudemcpcontent.com' },
    'openai/outputTemplate': 'ui://ignored/vendor.html',
    claude: { extension: true },
    openai: { extension: true },
    ui: { resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' },
    vendorPrivate: { retained: true },
  });

  expect(metadata.standard).toEqual({ ui: { resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' } });
  expect(metadata.extensions.openai).toEqual({
    'openai/outputTemplate': 'ui://ignored/vendor.html',
    openai: { extension: true },
  });
  expect(metadata.extensions.claude).toEqual({
    'claude/foo': { declaredDomain: 'example.claudemcpcontent.com' },
    claude: { extension: true },
  });
  expect(metadata.raw.vendorPrivate).toEqual({ retained: true });
  expect(metadata.provenance).toEqual({
    'claude/foo': 'claude-extension',
    'openai/outputTemplate': 'openai-extension',
    claude: 'claude-extension',
    openai: 'openai-extension',
    ui: 'standard',
    vendorPrivate: 'unclassified',
  });
});

it('selects nested standard resource metadata over legacy metadata and never vendor metadata', () => {
  expect(selectMcpAppResourceReference({ ui: { resourceUri: 'ui://rsc-agent-runtime/modern.html' } })).toEqual({
    provenance: 'modern',
    uri: 'ui://rsc-agent-runtime/modern.html',
    warnings: [],
  });
  expect(selectMcpAppResourceReference({ 'ui/resourceUri': 'ui://rsc-agent-runtime/legacy.html' })).toEqual({
    provenance: 'legacy',
    uri: 'ui://rsc-agent-runtime/legacy.html',
    warnings: [],
  });
  expect(selectMcpAppResourceReference({
    'ui/resourceUri': 'ui://rsc-agent-runtime/same.html',
    ui: { resourceUri: 'ui://rsc-agent-runtime/same.html' },
  })).toEqual({
    provenance: 'modern',
    uri: 'ui://rsc-agent-runtime/same.html',
    warnings: [],
  });
  const conflict = selectMcpAppResourceReference({
    'ui/resourceUri': 'ui://rsc-agent-runtime/legacy-secret.html',
    ui: { resourceUri: 'ui://rsc-agent-runtime/modern.html' },
  });
  expect(conflict).toMatchObject({ provenance: 'modern-overrode-legacy', uri: 'ui://rsc-agent-runtime/modern.html' });
  expect(conflict?.warnings).toHaveLength(1);
  expect(conflict?.warnings.join(' ')).not.toContain('secret');
  expect(selectMcpAppResourceReference({ 'openai/outputTemplate': 'ui://rsc-agent-runtime/vendor.html' })).toBeUndefined();
});

it('uses resource read metadata per field while preserving listed/read provenance', () => {
  const metadata = mergeMcpAppResourceMetadata(
    { _meta: { ui: { csp: { connectDomains: ['https://listed.example'] }, visibility: ['model'] }, listedOnly: true } },
    { _meta: { ui: { csp: { connectDomains: ['https://read.example'] }, permissions: { camera: {} }, visibility: ['app'] }, readOnly: true } },
  );

  expect(metadata.merged.raw).toEqual({
    listedOnly: true,
    readOnly: true,
    ui: {
      csp: { connectDomains: ['https://read.example'] },
      permissions: { camera: {} },
      visibility: ['app'],
    },
  });
  expect(metadata.provenance).toEqual({ listedOnly: 'listed', readOnly: 'read', ui: 'read-overrode-listed' });
  expect(metadata.warnings).toEqual([]);
});

it('evaluates ui.visibility only on tool definitions', () => {
  expect(isMcpAppToolVisible({ _meta: { ui: { visibility: ['app'] } }, name: 'render_edit_timeline' })).toBe(true);
  expect(isMcpAppToolVisible({ _meta: { ui: { visibility: ['model'] } }, name: 'model_only' })).toBe(false);
  expect(isMcpAppToolVisible({ _meta: { ui: { visibility: ['app'] } }, uri: 'ui://rsc-agent-runtime/resource.html' })).toBe(false);
  expect(mergeMcpAppResourceMetadata({}, { _meta: { ui: { visibility: ['model'] } } }).merged.raw).toEqual({
    ui: { visibility: ['model'] },
  });
});
