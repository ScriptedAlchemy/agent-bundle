import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build, validate } from '../src/api.ts';
import { definePrebuilt as definePrebuiltFromConfig } from '../src/config/index.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { definePrebuilt as definePrebuiltFromIndex } from '../src/index.ts';
import { parseArtifactManifest } from '../src/build/manifest.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';

const configSource = (options: { readonly payload?: string; readonly hooks?: string; readonly mcp?: string }): string => [
  'export default {',
  "  plugin: { name: 'prebuilt-fixture', version: '1.0.0', description: 'Prebuilt payload fixture.' },",
  "  targets: ['claude', 'codex', 'portable'],",
  ...(options.payload === undefined ? [] : [options.payload]),
  ...(options.hooks === undefined ? [] : [options.hooks]),
  ...(options.mcp === undefined ? [] : [options.mcp]),
  '};',
  '',
].join('\n');

const standardPayloadBlock = "  payload: { app: './built/app', runtime: './built/runtime' },";
const standardMcpBlock = [
  '  mcp: { servers: { timeline: {',
  "    entry: { prebuilt: './built/runtime/mcp/server.js' },",
  "    transport: 'stdio',",
  '  } } },',
].join('\n');
const standardHooksBlock = [
  '  hooks: { afterTool: [',
  "    { args: ['--host', 'claude'], handler: { prebuilt: './built/runtime/hook.js' }, targets: ['claude'], timeout: 30, tools: ['file.write'] },",
  "    { args: ['--host', 'codex'], handler: { prebuilt: './built/runtime/hook.js' }, targets: ['codex'], timeout: 30, tools: ['file.write'] },",
  '  ] },',
].join('\n');

/** A payload fixture whose runtime tree is deliberately not framework-shaped. */
const payloadFiles: Readonly<Record<string, string>> = {
  'built/app/index.html': '<html><body>widget</body></html>\n',
  'built/runtime/chunks/417.js': 'module.exports = require("./418.js");\n',
  'built/runtime/hook.js': 'process.stdout.write("{}");\n',
  // A bare-specifier import would fail the generated-module graph
  // validation (AB6005); prebuilt payloads are exempt by design.
  'built/runtime/mcp/server.js': 'import express from "express";\nexport default express;\n',
};

const createProject = async (options: {
  readonly payload?: string;
  readonly hooks?: string;
  readonly mcp?: string;
  readonly withPayloadFiles?: boolean;
  readonly files?: Readonly<Record<string, string>>;
} = {}): Promise<string> => {
  const { root } = await createProjectFixture({
    config: configSource(options),
    files: {
      ...(options.withPayloadFiles !== false ? payloadFiles : {}),
      ...options.files,
    },
    prefix: 'agent-bundle-prebuilt-',
  });
  return root;
};

const readJson = async <Document>(path: string): Promise<Document> =>
  JSON.parse(await readFile(path, 'utf8')) as Document;

it('exports definePrebuilt from the package and config entry points as an identity helper', () => {
  const entry = { runtimeDependencies: ['sharp'], source: './built/runtime' } as const;
  expect(definePrebuiltFromIndex(entry)).toBe(entry);
  expect(definePrebuiltFromConfig(entry)).toBe(entry);
});

it('validates declared payload runtime dependencies and normalizes them sorted and unique', async () => {
  const root = await createProject({
    files: {
      'package.json': `${JSON.stringify({
        dependencies: { sharp: '^0.33.0', zod: '^4.0.0' },
        name: 'prebuilt-fixture',
        version: '1.0.0',
      }, null, 2)}\n`,
    },
    payload: "  payload: { runtime: { source: './built/runtime', runtimeDependencies: ['zod', 'sharp', 'sharp'] } },",
  });
  try {
    const validated = await validate({ root });
    expect(validated.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4751')).toEqual([]);

    const built = await build({ output: join(root, 'out'), root });
    expect(built.model.payloads).toMatchObject([
      { name: 'runtime', runtimeDependencies: ['sharp', 'zod'] },
    ]);
  } finally {
    await removeProjectFixture(root);
  }
});

it('reports a payload runtime dependency that is not a bare package name', async () => {
  const root = await createProject({
    payload: "  payload: { runtime: { source: './built/runtime', runtimeDependencies: ['sharp/lib'] } },",
  });
  try {
    expect((await validate({ root })).diagnostics).toContainEqual(expect.objectContaining({
      code: 'AB4751',
      message: 'Payload "runtime" runtimeDependencies entry "sharp/lib" is not a bare package name.',
    }));
  } finally {
    await removeProjectFixture(root);
  }
});

const undeclaredMessage = 'Payload "runtime" runtimeDependencies names "sharp", which package.json does not declare as a dependency a consumer installs (dependencies, optionalDependencies, or a peer not marked optional).';

it.each([
  ['nothing', '{"name":"prebuilt-fixture","version":"1.0.0"}'],
  // npm never installs an optional peer, so no packed file can rely on it.
  ['an optional peer', '{"name":"prebuilt-fixture","version":"1.0.0","peerDependencies":{"sharp":"^0.33.0"},"peerDependenciesMeta":{"sharp":{"optional":true}}}'],
])('reports a payload runtime dependency package.json installs as %s', async (_declared, packageJson) => {
  const root = await createProject({
    files: { 'package.json': `${packageJson}\n` },
    payload: "  payload: { runtime: { source: './built/runtime', runtimeDependencies: ['sharp'] } },",
  });
  try {
    expect((await validate({ root })).diagnostics).toContainEqual(expect.objectContaining({ code: 'AB4751', message: undeclaredMessage }));
  } finally {
    await removeProjectFixture(root);
  }
});

it.each([
  ['optionalDependencies', '{"name":"prebuilt-fixture","version":"1.0.0","optionalDependencies":{"sharp":"^0.33.0"}}'],
  // npm 7+ installs a required peer for every consumer, the same reading AB7014 applies.
  ['a required peer', '{"name":"prebuilt-fixture","version":"1.0.0","peerDependencies":{"sharp":"^0.33.0"}}'],
])('accepts a payload runtime dependency package.json installs through %s', async (_declared, packageJson) => {
  const root = await createProject({
    files: { 'package.json': `${packageJson}\n` },
    payload: "  payload: { runtime: { source: './built/runtime', runtimeDependencies: ['sharp'] } },",
  });
  try {
    // No payload diagnostic at all: an earlier AB474x would have skipped the runtime-dependency check.
    expect((await validate({ root })).diagnostics.filter((diagnostic) => /^AB47[45]\d$/u.test(diagnostic.code))).toEqual([]);
  } finally {
    await removeProjectFixture(root);
  }
});

it.each([
  "'sharp'",
  "['']",
])('reports runtimeDependencies with %s as AB4740', async (runtimeDependencies) => {
  const root = await createProject({
    payload: `  payload: { runtime: { source: './built/runtime', runtimeDependencies: ${runtimeDependencies} } },`,
  });
  try {
    expect((await validate({ root })).diagnostics).toContainEqual(expect.objectContaining({
      code: 'AB4740',
      message: 'Payload "runtime" runtimeDependencies must be an array of package names.',
    }));
  } finally {
    await removeProjectFixture(root);
  }
});

it('normalizes string-form payload declarations with no runtime dependencies', async () => {
  const root = await createProject({
    payload: "  payload: { app: './built/app' },",
  });
  try {
    const built = await build({ output: join(root, 'out'), root });
    expect(built.model.payloads).toMatchObject([
      { name: 'app', runtimeDependencies: [] },
    ]);
  } finally {
    await removeProjectFixture(root);
  }
});

it('packages prebuilt payloads at stable paths and lowers prebuilt entries through every adapter', async () => {
  const root = await createProject({
    hooks: standardHooksBlock,
    mcp: standardMcpBlock,
    payload: standardPayloadBlock,
  });
  try {
    const result = await build({ output: join(root, 'out'), root });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);

    // The declaration provenance records the prebuilt kind.
    const timeline = result.model.mcpServers.find((server) => server.name === 'timeline');
    expect(timeline).toMatchObject({ command: 'node', provenance: { kind: 'prebuilt' } });
    expect(timeline?.source).toBeUndefined();
    expect(result.model.hooks.map((hook) => hook.provenance.kind)).toEqual(['prebuilt', 'prebuilt']);
    expect(result.model.payloads?.map((payload) => payload.name)).toEqual(['app', 'runtime']);

    // Payload bytes land verbatim, once, at their stable paths in the composite root.
    expect(await readFile(join(root, 'out', 'runtime', 'chunks', '417.js'), 'utf8'))
      .toBe('module.exports = require("./418.js");\n');
    expect(await readFile(join(root, 'out', 'app', 'index.html'), 'utf8'))
      .toBe('<html><body>widget</body></html>\n');

    // Adapter lowering: the same token expansion as compiled entries.
    const claudeMcp = await readJson<{ mcpServers: Record<string, { args: string[]; env: Record<string, string> }> }>(
      join(root, 'out', '.mcp.json'),
    );
    expect(claudeMcp.mcpServers['timeline']).toMatchObject({
      args: ['${CLAUDE_PLUGIN_ROOT}/runtime/mcp/server.js'],
      command: 'node',
      env: { AGENT_BUNDLE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}' },
    });
    const codexMcp = await readJson<{ mcpServers: Record<string, unknown> }>(join(root, 'out', '.codex-plugin', 'mcp.json'));
    expect(codexMcp.mcpServers['timeline']).toMatchObject({
      args: ['./runtime/mcp/server.js'],
      command: 'node',
      cwd: './',
      env: { AGENT_BUNDLE_PLUGIN_ROOT: './' },
    });
    const portableMcp = await readJson<{ mcpServers: Record<string, unknown> }>(join(root, 'out', 'mcp.json'));
    expect(portableMcp.mcpServers['timeline']).toMatchObject({
      args: ['${PLUGIN_ROOT}/runtime/mcp/server.js'],
      command: 'node',
      cwd: '${PLUGIN_ROOT}',
    });

    // Prebuilt hooks emit native commands at the payload path with their
    // declared arguments; nothing is compiled or indexed for them.
    const claudeHooks = await readJson<{ hooks: { PostToolUse: { hooks: { command: string; timeout: number }[]; matcher: string }[] } }>(
      join(root, 'out', 'hooks', 'hooks.json'),
    );
    expect(claudeHooks.hooks.PostToolUse[0]).toMatchObject({ matcher: '^(?:Write|Edit)$' });
    expect(claudeHooks.hooks.PostToolUse[0]?.hooks[0]).toMatchObject({
      command: 'node "${CLAUDE_PLUGIN_ROOT}/runtime/hook.js" --host claude',
      timeout: 30,
    });
    const codexHooks = await readJson<{ hooks: { PostToolUse: { hooks: { command: string }[]; matcher: string }[] } }>(
      join(root, 'out', '.codex-plugin', 'hooks.json'),
    );
    expect(codexHooks.hooks.PostToolUse[0]).toMatchObject({ matcher: '^(?:apply_patch|Edit|Write)$' });
    expect(codexHooks.hooks.PostToolUse[0]?.hooks[0]).toMatchObject({
      command: 'node "${PLUGIN_ROOT}/runtime/hook.js" --host codex',
    });
    expect(result.build.compiledHooks).toEqual([]);
    expect(await readJson<{ hooks: unknown[] }>(join(root, 'out', 'agent-bundle.hooks.json'))).toEqual({ hooks: [] });

    // Manifest provenance: payload files carry the prebuilt kind and their
    // own bytes as source inputs; the revision hashes the payload files.
    const manifest = parseArtifactManifest(await readFile(join(root, 'out', 'agent-bundle.manifest.json'), 'utf8'));
    const chunk = manifest.files.find((file) => file.path === 'runtime/chunks/417.js');
    expect(chunk).toMatchObject({ kind: 'prebuilt', sourceInputs: ['agent-bundle.config.ts', 'built/runtime/chunks/417.js'] });
    expect(manifest.project.sourceInputs.some((input) => input.path === 'built/runtime/mcp/server.js')).toBe(true);

    // The published artifact revalidates cleanly from disk alone.
    const revalidated = await validate({ artifact: join(root, 'out'), root });
    expect(revalidated.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  } finally {
    await removeProjectFixture(root);
  }
});

// An argument-less prebuilt hook emits `node "<root>/<payload path>"`, the
// exact shape of a compiler wrapper command. Hook coherence must recognize it
// by its payload location instead of misreporting AB6018 (not indexed).
it('validates an argument-less prebuilt hook without demanding a wrapper index entry', async () => {
  const root = await createProject({
    hooks: [
      '  hooks: { afterTool: [',
      "    { handler: { prebuilt: './built/runtime/hook.js' }, targets: ['claude'], tools: ['file.write'] },",
      '  ] },',
    ].join('\n'),
    payload: standardPayloadBlock,
  });
  try {
    const result = await build({ output: join(root, 'out'), root });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const claudeHooks = await readJson<{ hooks: { PostToolUse: { hooks: { command: string }[] }[] } }>(
      join(root, 'out', 'hooks', 'hooks.json'),
    );
    expect(claudeHooks.hooks.PostToolUse[0]?.hooks[0]).toMatchObject({
      command: 'node "${CLAUDE_PLUGIN_ROOT}/runtime/hook.js"',
    });

    const revalidated = await validate({ artifact: join(root, 'out'), root });
    expect(revalidated.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  } finally {
    await removeProjectFixture(root);
  }
});

it('reports the prebuilt payload source diagnostics', async () => {
  const root = await createProject({
    hooks: [
      '  hooks: { afterTool: [',
      "    { args: ['--host', 'claude'], handler: './src/hook.ts', targets: ['claude'], tools: ['file.write'] },",
      "    { args: ['not safe;rm -rf'], handler: { prebuilt: './built/runtime/hook.js' }, targets: ['codex'], tools: ['file.write'] },",
      '  ] },',
    ].join('\n'),
    mcp: [
      '  mcp: { servers: {',
      "    escaped: { entry: { prebuilt: './built/elsewhere/server.js' }, transport: 'stdio' },",
      "    missing: { entry: { prebuilt: './built/runtime/mcp/absent.js' }, transport: 'stdio' },",
      "    narrow: { entry: { prebuilt: './built/runtime/mcp/server.js' }, transport: 'stdio' },",
      '  } },',
    ].join('\n'),
    payload: [
      '  payload: {',
      "    bin: './built/app',",
      "    'mcp-apps': './built/app',",
      "    'output-styles': './built/app',",
      "    workflows: './built/app',",
      "    absent: './built/never-built',",
      "    runtime: { source: './built/runtime', targets: ['claude'] },",
      '  },',
    ].join('\n'),
    files: { 'src/hook.ts': 'export default () => undefined;\n' },
  });
  try {
    const result = await validate({ root });
    const codes = result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity] as const);
    // The reserved destination name.
    expect(codes.filter(([code]) => code === 'AB4741')).toHaveLength(4);
    expect(result.diagnostics.find((diagnostic) =>
      diagnostic.code === 'AB4741' && diagnostic.message.includes('"bin"'))?.recovery).toContain('claude.bin');
    // The not-yet-built payload directory warns instead of failing validation.
    expect(codes).toContainEqual(['AB4743', 'warning']);
    // A prebuilt entry outside every declared payload, and one whose payload
    // does not cover the component's targets.
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4744').length).toBeGreaterThanOrEqual(2);
    // The declared-but-absent prebuilt file warns.
    expect(codes).toContainEqual(['AB4745', 'warning']);
    // Hook arguments: rejected on compiled handlers and on unsafe values.
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4746').length).toBe(2);
  } finally {
    await removeProjectFixture(root);
  }
});

it('refuses to build while a payload is empty, a prebuilt entry is absent, or the output overlaps a payload', async () => {
  const emptyPayloadRoot = await createProject({
    payload: "  payload: { runtime: './built/never-built' },",
  });
  try {
    await expect(build({ output: join(emptyPayloadRoot, 'out'), root: emptyPayloadRoot })).rejects.toThrow(DiagnosticError);
    await expect(build({ output: join(emptyPayloadRoot, 'out'), root: emptyPayloadRoot })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB4747' })],
    });
  } finally {
    await removeProjectFixture(emptyPayloadRoot);
  }

  const missingEntryRoot = await createProject({
    mcp: [
      '  mcp: { servers: {',
      "    timeline: { entry: { prebuilt: './built/runtime/mcp/absent.js' }, transport: 'stdio' },",
      '  } },',
    ].join('\n'),
    payload: standardPayloadBlock,
  });
  try {
    await expect(build({ output: join(missingEntryRoot, 'out'), root: missingEntryRoot })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB4748' })],
    });
  } finally {
    await removeProjectFixture(missingEntryRoot);
  }

  const overlapRoot = await createProject({ payload: standardPayloadBlock });
  try {
    await expect(build({ output: join(overlapRoot, 'built', 'runtime'), root: overlapRoot })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'AB4749' })]),
    });
  } finally {
    await removeProjectFixture(overlapRoot);
  }
});
