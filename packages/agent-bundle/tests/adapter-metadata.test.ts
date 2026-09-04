import { readFile } from 'node:fs/promises';
import { expect, it } from '@rstest/core';

import codexCapabilityTable from '../src/adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import { TargetRegistry, createDefaultRegistry } from '../src/adapters/registry.ts';
import { createDraft7AdapterValidator } from '../src/adapters/types.ts';
import { sha256Hex } from '../src/core/digest.ts';

const validMetadata = () => ({
  adapterRevision: '1.0.0',
  observedVersion: '1.0.0',
  schemas: [
    { name: 'mcp', revision: '1.0.0', sha256: 'b'.repeat(64) },
    { name: 'plugin', revision: '1.0.0', sha256: 'c'.repeat(64) },
  ],
});

const validArtifactValidation = () => ({
  documents: [
    { path: 'mcp.json', required: false, schema: 'mcp' },
    { path: 'plugin.json', required: true, schema: 'plugin' },
  ],
  schemas: [
    { name: 'mcp', validate: () => [] },
    { name: 'plugin', validate: () => [] },
  ],
});

const adapter = (name: string, metadata: unknown = validMetadata(), extension?: string) => ({
  artifactValidation: validArtifactValidation(),
  capabilities: {},
  ...(extension === undefined ? {} : { configExtension: { key: extension } }),
  metadata: metadata as never,
  name,
  plan: () => ({ diagnostics: [], entries: [] }),
});

const registryMetadata = (registry: TargetRegistry, name: string) =>
  (registry as unknown as {
    metadata(target: string): {
      readonly adapterRevision: string;
      readonly observedVersion: string;
      readonly schemas: readonly {
        readonly name: string;
        readonly revision: string;
        readonly sha256: string;
      }[];
    };
  }).metadata(name);

it('records exact immutable metadata for every built-in target', () => {
  const registry = createDefaultRegistry();

  expect(registryMetadata(registry, 'portable')).toEqual({
    adapterRevision: '1.10.0',
    observedVersion: '1.0.0',
    schemas: [
      {
        name: 'mcp',
        revision: '1.0.0',
        sha256: '6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb',
      },
      {
        name: 'plugin',
        revision: '1.0.0',
        sha256: '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883',
      },
    ],
  });
  expect(registryMetadata(registry, 'codex')).toEqual({
    adapterRevision: '1.13.0',
    observedVersion: '0.147.0',
    schemas: [
      {
        name: 'app',
        revision: '0.147.0',
        sha256: '01c720a645e437bf0c4f8c26fd4cb5a13988e5649e4a8562ee23a1d4b7355c6a',
      },
      {
        name: 'hooks',
        revision: '0.147.0',
        sha256: '175b859eb8e85bd287d85ee840d97c3f5c2d0dda3223507a796d158e3770eeba',
      },
      {
        name: 'marketplace',
        revision: '0.147.0',
        sha256: 'fbccce3ade39e1b077fcb440e60260de6e811e8c2d222b2ae0fe8fe47706b470',
      },
      {
        name: 'mcp',
        revision: '0.147.0',
        sha256: '75bd50f9fcb85c2e8d43bc132d61c172a02f28ea8bb77389816ae77b14a4257e',
      },
      {
        name: 'plugin',
        revision: '0.147.0',
        sha256: '074c6c71966a3e6560ccbceb8d82ec6a40cb1eccee2f2d863fb4ef1e2276a814',
      },
    ],
  });
  expect(registryMetadata(registry, 'claude')).toEqual({
    adapterRevision: '1.28.0',
    observedVersion: '2.1.260',
    schemas: [
      {
        name: 'hooks',
        revision: '2.1.260',
        sha256: '0cdfc5eb5201f2c3091768559ac82f4c563ccb1b7bce7a39d5f99e5f404654cb',
      },
      {
        name: 'lsp',
        revision: '2.1.260',
        sha256: 'b4419c5d857267c7e2b21e3e1eb98b4fdc302c87109007190d3258e6ba7096e4',
      },
      {
        name: 'marketplace',
        revision: '2.1.260',
        sha256: '31ee4cc43ba5ce2be248030a69da2d31171550b2cc51c1fcb9f788a8ab92783d',
      },
      {
        name: 'mcp',
        revision: '2.1.260',
        sha256: 'edd4770e41d6aee5beae1ff918d33139613a243e454ecbd52b72fa824be4a662',
      },
      {
        name: 'monitors',
        revision: '2.1.260',
        sha256: '6378d94b51fb7c784eaee178237008a03da0f889d0520d57486784954a1d484c',
      },
      {
        name: 'plugin',
        revision: '2.1.260',
        sha256: '2a976091b81ad07ae8eca57f6f9c5749efeba17fa089a0c12b6ca84d6e70f118',
      },
      {
        name: 'settings',
        revision: '2.1.260',
        sha256: '2bbca553621dbf9433a9b7d1ff7952543a368434f2d999a4e4e360b95b6d4c3d',
      },
      {
        name: 'theme',
        revision: '2.1.260',
        sha256: '9931264e6f5a1d4b3b854ce7a17d602c9ba1b57cc1991f1d3991b316eaa81ac2',
      },
    ],
  });
  expect(registryMetadata(registry, 'cursor')).toEqual({
    adapterRevision: '1.13.0',
    observedVersion: '2026-08-28',
    schemas: [
      {
        name: 'hooks',
        revision: '2026-08-28',
        sha256: '06154b7afa0861df462130b988912b897e7ccf962b8dd20c09193100bcde5d81',
      },
      {
        name: 'marketplace',
        revision: '2026-08-28',
        sha256: '1aae96a24c2796419933bc8bfe3a1255394e7199c35740b36325e0ce6dbc253d',
      },
      {
        name: 'mcp',
        revision: '2026-08-28',
        sha256: 'f3fa4615afefe004c4fbcc09e635d890df0f1ec0cb39540feab72cbd3a31d844',
      },
      {
        name: 'plugin',
        revision: '2026-08-28',
        sha256: 'a393b758901803fcf5cfe0d77bda8a83e987d32c3377dfce2d9edf445af884ed',
      },
    ],
  });
  expect(registryMetadata(registry, 'plugin').adapterRevision).toBe('1.29.0');
});

it('records observed capability versions and rehashes schema snapshots against pinned provenance', async () => {
  const registry = createDefaultRegistry();
  const targets = [
    { capabilityFile: 'portable-1.0.0.json', provenanceFile: 'portable/PROVENANCE.json', target: 'portable', versionKey: 'version' },
    { capabilityFile: 'codex-0.147.0.json', provenanceFile: 'codex/PROVENANCE.json', target: 'codex', versionKey: 'observedCliVersion' },
    { capabilityFile: 'claude-2.1.260.json', provenanceFile: 'claude/PROVENANCE.json', target: 'claude', versionKey: 'observedCliVersion' },
    { capabilityFile: 'cursor-2026-08-28.json', provenanceFile: 'cursor/PROVENANCE.json', target: 'cursor', versionKey: 'observedCliVersion' },
  ] as const;

  for (const { capabilityFile, provenanceFile, target, versionKey } of targets) {
    const metadata = registryMetadata(registry, target);
    const [capability, provenanceText] = await Promise.all([
      readFile(new URL(`../src/adapters/capabilities/${capabilityFile}`, import.meta.url)),
      readFile(new URL(`../src/adapters/schemas/${provenanceFile}`, import.meta.url), 'utf8'),
    ]);
    const capabilityTable = JSON.parse(capability.toString()) as Record<string, unknown>;
    expect((capabilityTable.mcp as Record<string, unknown>).sse).toBeUndefined();
    const provenance = JSON.parse(provenanceText) as {
      readonly schemas: Record<string, { readonly bytes: number; readonly sha256: string }>;
      readonly [key: string]: unknown;
    };

    expect(metadata.observedVersion).toBe(capabilityTable.observedCliVersion ?? capabilityTable.observedSpecificationVersion);
    expect(metadata.observedVersion).toBe(provenance[versionKey]);
    expect(metadata.schemas.map((schema) => schema.name)).toEqual(
      [...metadata.schemas].map((schema) => schema.name).sort(),
    );

    for (const schema of metadata.schemas) {
      const fileName = `${schema.name}.schema.json`;
      const content = await readFile(new URL(`../src/adapters/schemas/${target}/${fileName}`, import.meta.url));
      expect(schema.sha256).toBe(sha256Hex(content));
      expect(schema.sha256).toBe(provenance.schemas[fileName]?.sha256);
      expect(content.byteLength).toBe(provenance.schemas[fileName]?.bytes);
      expect(schema.revision).toBe(metadata.observedVersion);
    }

    // Repository-owned capability tables are deliberately NOT hash-pinned:
    // Git and adapterRevision version them (README "What gets hashed"), and a
    // byte pin here forced a digest re-pin on every evidence edit.
    if (target === 'cursor') {
      const pluginSchema = JSON.parse(await readFile(
        new URL('../src/adapters/schemas/cursor/plugin.schema.json', import.meta.url),
        'utf8',
      )) as { readonly properties: { readonly logo?: unknown } };
      expect(pluginSchema.properties.logo).toEqual({
        description: 'Path to a logo image (relative to the plugin root) or an absolute URL.',
        type: 'string',
      });
    }
    if (target === 'portable') {
      expect(capabilityTable.install).toMatchObject({
        evidence: [
          expect.stringContaining('Cursor loads Agent Plugins natively'),
          expect.stringContaining('ChatGPT, Codex, Cursor, GitHub Copilot, Kiro, and VS Code'),
          expect.stringContaining('Claude Code is not a native client'),
        ],
        state: 'unavailable',
      });
      expect(provenance.specRepository).toEqual({
        commit: 'ff8ab5e392cc87bd88d87c060815a87490e51003',
        committedAt: '2026-08-19T16:34:23Z',
        url: 'https://github.com/agentplugins/agent-plugins-spec',
      });
      expect(provenance.reverifiedAt).toBe('2026-09-03');
      expect(provenance.reverification).toEqual(expect.stringContaining('a2afd7ec7edb916da638fc5c94640d4a7ba4480f'));
      // Every Agent Plugins 1.0.0 feature carries an honest, dated capability row.
      const plugin = capabilityTable.plugin as Record<string, unknown>;
      const mcp = capabilityTable.mcp as Record<string, unknown>;
      expect(plugin.manifestMetadata).toMatchObject({
        fields: ['author', 'homepage', 'keywords', 'license', 'repository'],
        state: 'supported',
      });
      expect(plugin.extensions).toMatchObject({ configKey: 'portable.extensions', state: 'supported' });
      expect(plugin.extensionDirectories).toMatchObject({
        reason: expect.stringContaining('2026-09-02'),
        state: 'unavailable',
      });
      expect(mcp.legacySse).toMatchObject({ reason: expect.stringContaining('AB4339'), state: 'unavailable' });
    }
  }
});

it('pins and validates the Codex 0.147.0 event wire schemas', async () => {
  const schemas = [
    {
      fixture: 'codex-subagent-start.json',
      name: 'subagent-start.command.input.schema.json',
      sha256: 'ce7dc9b5ae8826d1e0c59ffcea793e558aebceb7917a2eb9bb2edd8a7ac37aa9',
    },
    {
      name: 'subagent-start.command.output.schema.json',
      output: {
        hookSpecificOutput: {
          additionalContext: 'Review the repository test conventions first.',
          hookEventName: 'SubagentStart',
        },
      },
      sha256: '34e8ec95393d2aa930d7932a34c3fb29a5e5f90c264fdbcc581393c5838b4660',
    },
    {
      fixture: 'codex-subagent-stop.json',
      name: 'subagent-stop.command.input.schema.json',
      sha256: '94dc8df29f4691195ac2338ae6de876230e5100a10b94ef48df4e732424b5df5',
    },
    {
      name: 'subagent-stop.command.output.schema.json',
      output: { decision: 'block', reason: 'Run one more focused pass.' },
      sha256: '8ba2cd7899ae4544193764e67e988235edebe984abe5788634d123bbf13e3e3a',
    },
    {
      fixture: 'codex-user-prompt-submit.json',
      name: 'user-prompt-submit.command.input.schema.json',
      sha256: 'e6b923bc519896197c44c4fc267a9d115cef24ac418dde9c27db699f4e3b65fd',
    },
    {
      name: 'user-prompt-submit.command.output.schema.json',
      output: {
        decision: 'block',
        hookSpecificOutput: {
          additionalContext: 'Repository policy context.',
          hookEventName: 'UserPromptSubmit',
        },
        reason: 'Prompt rejected.',
      },
      sha256: '5e290303db710f3ccc12f4a2744e8586e7749b3ca2b6bf9f57781ed75bf17b2b',
    },
    {
      fixture: 'codex-session-end.json',
      name: 'session-end.command.input.schema.json',
      sha256: '23b1b69f92fa8ac29f8319478984b5aa5aaf09e5ca355ce90aa010452937e41c',
    },
    {
      input: {
        cwd: '/workspace',
        hook_event_name: 'PreCompact',
        model: 'gpt-5.6-sol',
        session_id: 'session-codex-1',
        transcript_path: null,
        trigger: 'manual',
        turn_id: 'turn-codex-1',
      },
      name: 'pre-compact.command.input.schema.json',
      sha256: '065f0ae3cd628ac9af8c0cf9bd1d5a673bcbd5ea1d7dcdc0c6437f34dd0189d9',
    },
    {
      name: 'pre-compact.command.output.schema.json',
      output: { continue: true },
      sha256: 'c392f3054ae6750f427d4dec07380fd67e8c58a7939a35d5c69bfa070c7ca032',
    },
    {
      input: {
        cwd: '/workspace',
        hook_event_name: 'PostCompact',
        model: 'gpt-5.6-sol',
        session_id: 'session-codex-1',
        transcript_path: null,
        trigger: 'manual',
        turn_id: 'turn-codex-1',
      },
      name: 'post-compact.command.input.schema.json',
      sha256: '4a4b3f3022c939a15ab12e95f5c5c17b18bb20f74fe962ae0a51b2a3e76e63f9',
    },
    {
      name: 'post-compact.command.output.schema.json',
      output: {},
      sha256: '48355bfcb568259cf396beb6ade2ac32827f50bf6a3c20b395c337dce184cbed',
    },
    {
      input: {
        cwd: '/workspace',
        hook_event_name: 'PermissionRequest',
        model: 'gpt-5.6-sol',
        permission_mode: 'default',
        session_id: 'session-codex-1',
        tool_input: { command: 'rm -rf build', description: null },
        tool_name: 'Bash',
        transcript_path: null,
        turn_id: 'turn-codex-1',
      },
      name: 'permission-request.command.input.schema.json',
      sha256: '75c73d7a38cfc0e73ef06bd1fc506a44d25874522069ec4fb85e0bf1e7d6b8fb',
    },
    {
      name: 'permission-request.command.output.schema.json',
      output: {
        hookSpecificOutput: {
          decision: { behavior: 'deny', message: 'Blocked by repository policy.' },
          hookEventName: 'PermissionRequest',
        },
      },
      sha256: '749c73245b4b6d43537c3049f76720ab1c2bd48d7e4752b744b376925b9d57a1',
    },
    {
      input: {
        cwd: '/workspace',
        hook_event_name: 'SessionStart',
        model: 'gpt-5.6-sol',
        permission_mode: 'default',
        session_id: 'session-codex-1',
        source: 'startup',
        transcript_path: null,
      },
      name: 'session-start.command.input.schema.json',
      sha256: '690c0eef7c9f3ddcd41e24207b81b362101a300b4abec076b990a1cd79a66e20',
    },
    {
      name: 'session-start.command.output.schema.json',
      output: {
        hookSpecificOutput: {
          additionalContext: 'Load the workspace conventions before editing.',
          hookEventName: 'SessionStart',
        },
      },
      sha256: 'f375e6de1c59ecbabd8c1aff05a67976d0f3aa2ef061808838de4c7c20be1c71',
    },
    {
      input: {
        cwd: '/workspace',
        hook_event_name: 'PreToolUse',
        model: 'gpt-5.6-sol',
        permission_mode: 'default',
        session_id: 'session-codex-1',
        tool_input: { command: 'git status' },
        tool_name: 'Bash',
        tool_use_id: 'call-codex-1',
        transcript_path: null,
        turn_id: 'turn-codex-1',
      },
      name: 'pre-tool-use.command.input.schema.json',
      sha256: 'fabed428f0fe75767c5700208b166da5faef4e031d601dfc8bff2f96d340c682',
    },
    {
      name: 'pre-tool-use.command.output.schema.json',
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: 'echo rewritten' },
        },
      },
      sha256: 'e684f81c63fbb5972892f6a848b49fec68c8ce137931651093d2dd1da56a1dd6',
    },
    {
      input: {
        cwd: '/workspace',
        hook_event_name: 'PostToolUse',
        model: 'gpt-5.6-sol',
        permission_mode: 'default',
        session_id: 'session-codex-1',
        tool_input: { command: 'git status' },
        tool_name: 'Bash',
        tool_response: 'On branch main',
        tool_use_id: 'call-codex-1',
        transcript_path: null,
        turn_id: 'turn-codex-1',
      },
      name: 'post-tool-use.command.input.schema.json',
      sha256: '8ea1e4bccb262fad05b85c300d562d2653c5a64118d6a2c5704468fc4ea836a9',
    },
    {
      name: 'post-tool-use.command.output.schema.json',
      output: {
        decision: 'block',
        hookSpecificOutput: {
          additionalContext: 'The command updated generated files.',
          hookEventName: 'PostToolUse',
        },
        reason: 'The Bash output needs review before continuing.',
      },
      sha256: 'a823d0e2c941e98d7d3af825dfdb0b1dfa6a935696ff8b8529e8e83232a1b0c8',
    },
    {
      input: {
        cwd: '/workspace',
        hook_event_name: 'Stop',
        last_assistant_message: null,
        model: 'gpt-5.6-sol',
        permission_mode: 'default',
        session_id: 'session-codex-1',
        stop_hook_active: false,
        transcript_path: null,
        turn_id: 'turn-codex-1',
      },
      name: 'stop.command.input.schema.json',
      sha256: '7db4793c404b5c46b230c27b9507eb1a558fd958689d8715221c5dd81351a06a',
    },
    {
      name: 'stop.command.output.schema.json',
      output: { decision: 'block', reason: 'Run one more pass over the failing tests.' },
      sha256: 'dc2b30e84c97beca5825aa64ca46e1337e402781dc5a9142b67111d10523f15c',
    },
  ] as const;
  expect(schemas.map((schema) => schema.name).sort()).toEqual(
    Object.keys(codexCapabilityTable.validation.pinnedGeneratedComparison.pinnedRepositorySha256).sort(),
  );
  const validator = createDraft7AdapterValidator();

  for (const schema of schemas) {
    const bytes = await readFile(new URL(`../src/adapters/schemas/codex/generated/${schema.name}`, import.meta.url));
    // Repository text files carry one POSIX trailing newline; the pinned
    // upstream generated files do not. Hash the byte-identical upstream body.
    expect(bytes.at(-1)).toBe(10);
    expect(sha256Hex(bytes.subarray(0, -1))).toBe(schema.sha256);
    const validate = validator.compile(JSON.parse(bytes.toString()));
    const value = 'fixture' in schema
      ? JSON.parse(await readFile(new URL(`./fixtures/events/${schema.fixture}`, import.meta.url), 'utf8'))
      : 'input' in schema
        ? schema.input
        : schema.output;
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  }
});

it('returns frozen, detached metadata snapshots while retaining the original adapter methods', () => {
  const metadata = validMetadata();
  const registered = adapter('custom', metadata);
  const registry = new TargetRegistry().register(registered);
  const snapshot = registryMetadata(registry, 'custom');

  metadata.adapterRevision = 'changed';
  metadata.schemas[0]!.name = 'changed';
  expect(snapshot).toEqual(validMetadata());
  expect(registry.get('custom')).toBe(registered);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.schemas)).toBe(true);
  expect(Object.isFrozen(snapshot.schemas[0])).toBe(true);
  expect(() => (snapshot as { adapterRevision: string }).adapterRevision = 'changed').toThrow();
  expect(() => (snapshot.schemas as unknown as { push(value: unknown): number }).push({})).toThrow();
  expect(() => (snapshot.schemas[0] as { name: string }).name = 'changed').toThrow();
});

it('snapshots canonical immutable artifact output suffixes and recursive namespaces and rejects malformed layouts', () => {
  const allowedSuffixes = ['.mjs', '.sh'];
  const registered = adapter('custom');
  const registry = new TargetRegistry().register({
    ...registered,
    artifactLayout: { bin: 'bin', scripts: { allowedSuffixes, directory: 'scripts' } },
  });
  const layout = registry.artifactLayout('custom');

  allowedSuffixes.push('.py');
  expect(layout).toEqual({
    bin: 'bin',
    scripts: { allowedSuffixes: ['.mjs', '.sh'], directory: 'scripts' },
  });
  expect(Object.isFrozen(layout)).toBe(true);
  expect(Object.isFrozen(layout.scripts)).toBe(true);
  expect(Object.isFrozen(layout.scripts?.allowedSuffixes)).toBe(true);

  const accessorSuffixes = ['.mjs'];
  Object.defineProperty(accessorSuffixes, '0', {
    enumerable: true,
    get: () => {
      throw new Error('suffix accessor must not be read');
    },
  });
  const malformedLayouts = [
    { scripts: { allowedSuffixes: [], directory: 'scripts' } },
    { scripts: { allowedSuffixes: ['mjs'], directory: 'scripts' } },
    { scripts: { allowedSuffixes: ['.sh', '.mjs'], directory: 'scripts' } },
    { scripts: { allowedSuffixes: ['.mjs', '.mjs'], directory: 'scripts' } },
    { scripts: { allowedSuffixes: accessorSuffixes, directory: 'scripts' } },
    { scripts: { allowedSuffixes: Object.setPrototypeOf(['.mjs'], null), directory: 'scripts' } },
  ];
  for (const [index, artifactLayout] of malformedLayouts.entries()) {
    expect(() => registry.register({
      ...adapter(`invalid-layout-${index}`),
      artifactLayout,
    })).toThrow(/allowed suffixes/i);
    expect(registry.names()).toEqual(['custom']);
  }
});

it('rejects malformed metadata atomically and preserves existing collision behavior', () => {
  const malformed = [
    { ...validMetadata(), adapterRevision: '' },
    { ...validMetadata(), observedVersion: '' },
    { ...validMetadata(), schemas: [{ ...validMetadata().schemas[0]!, sha256: 'not-a-hash' }] },
    { ...validMetadata(), schemas: [{ ...validMetadata().schemas[0]!, name: '' }] },
    { ...validMetadata(), schemas: [{ ...validMetadata().schemas[0]!, revision: '' }] },
    { ...validMetadata(), schemas: [validMetadata().schemas[0]!, validMetadata().schemas[0]!] },
    null,
  ];
  const registry = new TargetRegistry().register(adapter('existing', validMetadata(), 'example'));

  for (const [index, metadata] of malformed.entries()) {
    expect(() => registry.register(adapter(`invalid-${index}`, metadata))).toThrow();
    expect(registry.names()).toEqual(['existing']);
    expect(registryMetadata(registry, 'existing')).toEqual(validMetadata());
  }
  expect(() => registry.register({
    capabilities: {},
    name: 'missing-metadata',
    plan: () => ({ diagnostics: [], entries: [] }),
  } as never)).toThrow();
  expect(registry.names()).toEqual(['existing']);
  expect(() => registryMetadata(registry, 'missing')).toThrow('Unknown target adapter "missing"');
  expect(() => registry.register(adapter('other', validMetadata(), 'example'))).toThrow('example');
  expect(() => registry.register(adapter('existing', validMetadata()))).toThrow('already registered');
});

it('requires a complete, uniquely owned artifact schema and document contract atomically', () => {
  const registry = new TargetRegistry().register(adapter('existing'));

  expect(() => registry.register({
    ...adapter('missing-schema'),
    artifactValidation: {
      ...validArtifactValidation(),
      schemas: [{ name: 'plugin', validate: () => [] }],
    },
  })).toThrow(/schema.*metadata|metadata.*schema/i);
  expect(registry.names()).toEqual(['existing']);

  expect(() => registry.register({
    ...adapter('duplicate-path'),
    artifactValidation: {
      ...validArtifactValidation(),
      documents: [
        { path: 'plugin.json', required: true, schema: 'mcp' },
        { path: 'plugin.json', required: true, schema: 'plugin' },
      ],
    },
  })).toThrow(/document path.*already declared/i);
  expect(registry.names()).toEqual(['existing']);
});

it('rejects accessor, inherited, and prototype-backed artifact contract records atomically', () => {
  const registry = new TargetRegistry().register(adapter('existing'));
  const prototypeBackedSchema = Object.assign(Object.create({}), {
    name: 'mcp',
    validate: () => [],
  });
  const accessorSchema = Object.defineProperties({ validate: () => [] }, {
    name: {
      enumerable: true,
      get: () => {
        throw new Error('schema accessor must not be read');
      },
    },
  });
  const accessorDocument = Object.defineProperties({ path: 'mcp.json', schema: 'mcp' }, {
    required: {
      enumerable: true,
      get: () => {
        throw new Error('document accessor must not be read');
      },
    },
  });
  const inheritedRequiredDocument = Object.assign(Object.create({ required: true }), {
    path: 'mcp.json',
    schema: 'mcp',
  });
  const contract = (schemas: readonly unknown[], documents: readonly unknown[]) => ({
    documents: documents as never,
    schemas: schemas as never,
  });

  for (const [name, artifactValidation] of [
    ['prototype-schema', contract([prototypeBackedSchema, validArtifactValidation().schemas[1]!], validArtifactValidation().documents)],
    ['accessor-schema', contract([accessorSchema, validArtifactValidation().schemas[1]!], validArtifactValidation().documents)],
    ['accessor-document', contract(validArtifactValidation().schemas, [accessorDocument, validArtifactValidation().documents[1]!])],
    ['inherited-required-document', contract(validArtifactValidation().schemas, [inheritedRequiredDocument, validArtifactValidation().documents[1]!])],
  ] as const) {
    expect(() => registry.register({ ...adapter(name), artifactValidation })).toThrow(/artifact (schema contracts|documents) must contain records/i);
    expect(registry.names()).toEqual(['existing']);
  }
});
