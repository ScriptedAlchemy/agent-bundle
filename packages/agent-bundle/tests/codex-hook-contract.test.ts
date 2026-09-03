import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

import codexCapabilityTable from '../src/adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import { codexAdapter } from '../src/adapters/codex.ts';
import { encodeNativeHookPlaygroundOutput } from '../src/adapters/hook-contract.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import hooksSchema from '../src/adapters/schemas/codex/hooks.schema.json' with { type: 'json' };
import { createAdapterValidator, createDraft7AdapterValidator } from '../src/adapters/types.ts';
import { validateNativeEventEnvelope } from '../src/events/projection.ts';
import type { CanonicalAgentEvent } from '../src/routes/public.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

const contractRows = {
  additionalContextLimit: 'hookAdditionalContextLimit',
  asyncCommandHooks: 'hookAsyncCommands',
  commandWindows: 'hookCommandWindows',
  generatedSchemaValidation: 'hookGeneratedSchemas',
  handlerCommand: 'hookHandlerCommand',
  handlerMcpTool: 'hookHandlerMcpTool',
  handlerPromptAgent: 'hookHandlerPromptAgent',
  matcherSemantics: 'hookMatcherSemantics',
  mcpToolExecution: 'hookMcpToolExecution',
  releaseEvents: 'hookReleaseEvents',
  statusMessage: 'hookStatusMessage',
  timeoutRules: 'hookTimeoutRules',
  trustReview: 'hookTrustReview',
} as const;

const expectedStates: Readonly<Record<keyof typeof contractRows, 'degraded' | 'supported' | 'unavailable'>> = {
  additionalContextLimit: 'degraded',
  asyncCommandHooks: 'degraded',
  commandWindows: 'degraded',
  generatedSchemaValidation: 'supported',
  handlerCommand: 'supported',
  handlerMcpTool: 'degraded',
  handlerPromptAgent: 'unavailable',
  matcherSemantics: 'supported',
  mcpToolExecution: 'unavailable',
  releaseEvents: 'supported',
  statusMessage: 'degraded',
  timeoutRules: 'supported',
  trustReview: 'unavailable',
};

const releaseEvents = [
  'PermissionRequest',
  'PostCompact',
  'PostToolUse',
  'PreCompact',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
];

const plugin: NormalizedPlugin = Object.freeze({
  extensions: Object.freeze({}),
  hooks: Object.freeze([]),
  marketplace: true as const,
  mcpServers: Object.freeze([]),
  metadata: Object.freeze({
    description: 'Review code and explain findings.',
    id: 'plugin:review-tools',
    name: 'review-tools',
    provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }),
    version: '1.2.3',
  }),
  runtime: Object.freeze({ node: '22.12.0' }),
  scripts: Object.freeze([]),
  skills: Object.freeze([]),
  targets: Object.freeze([
    Object.freeze({ id: 'target:codex', name: 'codex', provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }) }),
  ]),
});

const nativeSource = '/workspace/codex-hooks.json';

const withNativeHooks = (document: unknown): NormalizedPlugin => ({
  ...plugin,
  nativeHooks: [{
    document: document as Record<string, unknown>,
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    source: nativeSource,
    target: 'codex',
  }],
});

const commandGroup = (handler: Readonly<Record<string, unknown>> = {}, matcher?: string) => ({
  hooks: [{ command: 'echo codex', type: 'command', ...handler }],
  ...(matcher === undefined ? {} : { matcher }),
});

const planCodes = (model: NormalizedPlugin): readonly string[] =>
  codexAdapter.plan(model).diagnostics.map((diagnostic) => diagnostic.code);

const emittedHooks = (model: NormalizedPlugin): unknown => {
  const entry = codexAdapter.plan(model).entries.find((candidate) => candidate.relativePath === 'hooks/hooks.json');
  if (entry?.kind !== 'write') return undefined;
  return JSON.parse(entry.content);
};

it('records dated four-state Codex hook-contract rows mirrored by the adapter and intersected by the unified bundle', () => {
  const registry = createDefaultRegistry();
  const unified = registry.get('plugin');
  const contract = codexCapabilityTable.hooks.contract as Readonly<Record<string, {
    readonly evidence: readonly string[];
    readonly reason?: string;
    readonly state: string;
  }>>;

  expect(Object.keys(contract).sort()).toEqual(Object.keys(contractRows).sort());
  for (const [rowName, capability] of Object.entries(contractRows)) {
    const row = contract[rowName]!;
    const expectedState = expectedStates[rowName as keyof typeof contractRows];
    expect(row.state, rowName).toBe(expectedState);
    expect(row.evidence.length, rowName).toBeGreaterThan(0);
    expect(row.evidence.every((line) => line.startsWith('retrieved 2026-09-02:')), rowName).toBe(true);
    if (expectedState === 'supported') {
      expect(row.reason).toBeUndefined();
      expect(codexAdapter.capabilities[capability]).toEqual({
        evidence: { observedVersion: '0.147.0', target: 'codex' },
        state: 'supported',
      });
    } else {
      expect(row.reason, rowName).toMatch(/\S/u);
      expect(codexAdapter.capabilities[capability]).toMatchObject({
        reason: row.reason,
        state: expectedState,
        ...(expectedState === 'degraded' ? { evidence: { observedVersion: '0.147.0', target: 'codex' } } : {}),
      });
    }
    expect(registry.supports('codex', capability)).toBe(expectedState === 'supported');
    expect(unified.capabilities[capability]).toMatchObject({ state: 'unavailable' });
    expect(registry.supports('plugin', capability)).toBe(false);
  }
});

it('pins the eleven release events, keeps Interrupt deferred, and closes the hooks schema to those events', () => {
  expect(codexCapabilityTable.hooks.releaseEvents).toEqual(releaseEvents);
  expect(Object.keys(hooksSchema.properties.hooks.properties).sort()).toEqual([...releaseEvents].sort());
  expect(hooksSchema.properties.hooks.additionalProperties).toBe(false);
  for (const route of Object.values(codexCapabilityTable.hooks.eventRoutes)) {
    if (route.state !== 'supported') continue;
    expect(releaseEvents).toContain((route as { readonly nativeEvent: string }).nativeEvent);
  }
  for (const nativeEvent of Object.values(codexCapabilityTable.hooks.events)) {
    expect(releaseEvents).toContain(nativeEvent);
  }
  expect(codexCapabilityTable.deferredNativeEvents.Interrupt).toMatchObject({
    reason: expect.stringMatching(/2026-09-02.*rust-v0\.147\.0.*no interrupt/su),
    state: 'unavailable',
  });
  expect(releaseEvents).not.toContain('Interrupt');
  expect(Object.keys(codexCapabilityTable.hooks.contract.generatedSchemaValidation.schemas).sort()).toEqual([...releaseEvents].sort());
});

it('admits every documented command and mcp_tool handler field and rejects skipped handler types in the pinned hooks schema', () => {
  const validate = createAdapterValidator().compile(hooksSchema);
  const full = {
    description: 'Documented handler surface.',
    hooks: {
      PostToolUse: [{
        hooks: [
          {
            additionalContextLimit: 5000,
            async: true,
            command: 'python3 ${PLUGIN_ROOT}/hooks/post.py',
            commandWindows: 'py -3 %PLUGIN_ROOT%\\hooks\\post.py',
            statusMessage: 'Reviewing Bash output',
            timeout: 120,
            type: 'command',
          },
          {
            input: { patch: '${tool_input.command}' },
            server: 'scanner',
            statusMessage: 'Scanning edited files',
            timeout: 30,
            tool: 'scan_patch',
            type: 'mcp_tool',
          },
        ],
        matcher: 'Write|Edit',
      }],
      SessionStart: [{ hooks: [{ additionalContextLimit: 0, command: 'echo start', type: 'command' }], matcher: 'startup|resume' }],
    },
  };
  expect(validate(full), JSON.stringify(validate.errors)).toBe(true);

  const rejected = [
    { hooks: { Stop: [{ hooks: [{ prompt: 'Summarize.', type: 'prompt' }] }] } },
    { hooks: { Stop: [{ hooks: [{ agent: 'reviewer', type: 'agent' }] }] } },
    { hooks: { Interrupt: [{ hooks: [{ command: 'echo interrupted', type: 'command' }] }] } },
    { hooks: { Notification: [{ hooks: [{ command: 'echo notify', type: 'command' }] }] } },
    { hooks: { Stop: [{ hooks: [{ server: 'scanner', type: 'mcp_tool' }] }] } },
    { hooks: { Stop: [{ hooks: [{ command: 'echo', type: 'command', unknown: true }] }] } },
    { hooks: { Stop: [{ hooks: [{ command: 'echo', type: 'command', additionalContextLimit: -1 }] }] } },
    { hooks: { Stop: [{ hooks: [{ async: true, server: 'scanner', tool: 'scan', type: 'mcp_tool' }] }] } },
  ];
  for (const document of rejected) {
    expect(validate(document), JSON.stringify(document)).toBe(false);
  }
});

it('names deferred, unknown, and skipped native hook surfaces before schema validation', () => {
  expect(planCodes(withNativeHooks({
    hooks: { Interrupt: [commandGroup()] },
  }))).toEqual(['codex.native-hooks.event.deferred']);
  expect(planCodes(withNativeHooks({
    hooks: { Notification: [commandGroup()] },
  }))).toEqual(['codex.native-hooks.event.unknown']);
  expect(planCodes(withNativeHooks({
    hooks: {
      Stop: [{ hooks: [{ prompt: 'Summarize the turn.', type: 'prompt' }, { agent: 'reviewer', type: 'agent' }] }],
    },
  }))).toEqual(['codex.native-hooks.handler.skipped', 'codex.native-hooks.handler.skipped']);
  const plan = codexAdapter.plan(withNativeHooks({ hooks: { Interrupt: [commandGroup()] } }));
  expect(plan.diagnostics[0]).toMatchObject({
    message: expect.stringContaining('rust-v0.147.0'),
    recovery: expect.stringContaining('Remove the Interrupt group'),
    severity: 'error',
    target: 'codex',
  });
  expect(plan.entries.some((entry) => entry.relativePath === 'hooks/hooks.json')).toBe(false);
});

it('rejects handler fields the Codex host would ignore or refuse for the event', () => {
  expect(planCodes(withNativeHooks({
    hooks: { SessionEnd: [{ hooks: [{ server: 'scanner', tool: 'flush', type: 'mcp_tool' }] }] },
  }))).toEqual(['codex.hooks.session-end.mcp-tool']);
  expect(planCodes(withNativeHooks({
    hooks: { SessionEnd: [commandGroup({ async: true })] },
  }))).toEqual(['codex.hooks.session-end.async']);
  expect(planCodes(withNativeHooks({
    hooks: { SessionEnd: [commandGroup({ timeout: 4 })] },
  }))).toEqual(['codex.hooks.session-end.timeout']);
  expect(planCodes(withNativeHooks({
    hooks: { SessionEnd: [commandGroup({ timeout: 3 })] },
  }))).toEqual([]);
  expect(planCodes(withNativeHooks({
    hooks: {
      PreCompact: [commandGroup({ additionalContextLimit: 5000 })],
      Stop: [commandGroup({ additionalContextLimit: 0 })],
    },
  }))).toEqual(['codex.hooks.additional-context-limit.event', 'codex.hooks.additional-context-limit.event']);
  expect(planCodes(withNativeHooks({
    hooks: {
      Stop: [commandGroup({}, 'Bash')],
      UserPromptSubmit: [commandGroup({}, '.*')],
    },
  }))).toEqual(['codex.hooks.matcher.ignored', 'codex.hooks.matcher.ignored']);
  const rejected = codexAdapter.plan(withNativeHooks({ hooks: { SessionEnd: [commandGroup({ timeout: 30 })] } }));
  expect(rejected.diagnostics[0]).toMatchObject({
    message: expect.stringContaining('at most 3 seconds'),
    recovery: expect.stringContaining('3 seconds or less'),
  });
  expect(rejected.entries.some((entry) => entry.relativePath === 'hooks/hooks.json')).toBe(false);
});

it('emits a native document that uses every documented handler field unchanged', () => {
  const document = {
    description: 'Documented handler surface.',
    hooks: {
      PostToolUse: [{
        hooks: [
          {
            additionalContextLimit: 5000,
            async: true,
            command: 'python3 ${PLUGIN_ROOT}/hooks/post.py',
            commandWindows: 'py -3 %PLUGIN_ROOT%\\hooks\\post.py',
            statusMessage: 'Reviewing Bash output',
            timeout: 120,
            type: 'command',
          },
          {
            input: { patch: '${tool_input.command}' },
            server: 'scanner',
            statusMessage: 'Scanning edited files',
            timeout: 30,
            tool: 'scan_patch',
            type: 'mcp_tool',
          },
        ],
        matcher: 'Write|Edit',
      }],
      SessionEnd: [commandGroup({ timeout: 3 }, 'other')],
      SessionStart: [commandGroup({ additionalContextLimit: 0 }, 'startup|resume|clear|compact')],
      UserPromptSubmit: [commandGroup()],
    },
  };
  const model = withNativeHooks(document);
  expect(planCodes(model)).toEqual([]);
  expect(emittedHooks(model)).toEqual(document);
});

it('rejects codex-scoped native selectors that name the documented hosted tool', () => {
  const hook = {
    event: 'beforeTool' as const,
    id: 'hook:before-tool:search',
    name: 'search',
    nativeTools: [{ name: 'WebSearch', target: 'codex' }],
    provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
    source: '/workspace/src/hooks/search.ts',
    targets: ['codex'],
    tools: [],
  };
  const codes = planCodes({ ...plugin, hooks: [hook] });
  expect(codes).toContain('codex.hook.tool.hosted');
  expect(planCodes({
    ...plugin,
    hooks: [{ ...hook, nativeTools: [{ name: 'update_plan', target: 'codex' }] }],
  })).toEqual([]);
  expect(codexCapabilityTable.hooks.contract.matcherSemantics).toMatchObject({
    applyPatchAliases: ['Edit', 'Write'],
    hostedToolExclusions: ['WebSearch'],
    ignoredMatcherEvents: ['UserPromptSubmit', 'Stop'],
  });
  expect(codexCapabilityTable.hooks.matchers['file.write']).toBe('^(?:apply_patch|Edit|Write)$');
});

const outputSamples: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>> = {
  PermissionRequest: undefined,
  PostCompact: undefined,
  PostToolUse: { additionalContext: 'The command updated generated files.', outcome: 'continue' },
  PreCompact: undefined,
  PreToolUse: { outcome: 'deny', reason: 'Destructive command blocked by hook.' },
  SessionStart: { additionalContext: 'Load the workspace conventions before editing.', outcome: 'continue' },
  Stop: { outcome: 'deny', reason: 'Run one more pass over the failing tests.' },
  SubagentStart: { additionalContext: 'Review the repository test conventions first.', outcome: 'continue' },
  SubagentStop: { outcome: 'deny', reason: 'Run one more focused pass inside the subagent.' },
  UserPromptSubmit: { additionalContext: 'Ask for a clearer reproduction before editing files.', outcome: 'continue' },
};

const canonicalHookEventFor: Readonly<Record<string, string>> = {
  PostToolUse: 'afterTool',
  PreToolUse: 'beforeTool',
  SessionStart: 'sessionStart',
  Stop: 'stop',
  SubagentStart: 'agentStart',
  SubagentStop: 'agentStop',
  UserPromptSubmit: 'promptSubmit',
};

it('validates every Codex lifecycle-replay starter and codec output against the pinned generated wire schemas', async () => {
  const validator = createDraft7AdapterValidator();
  const schemasFor = codexCapabilityTable.hooks.contract.generatedSchemaValidation.schemas as Readonly<
    Record<string, { readonly input: string; readonly output?: string }>
  >;
  const schemaRoot = new URL('../src/adapters/schemas/codex/generated/', import.meta.url);
  const compile = async (name: string) => validator.compile(JSON.parse(await readFile(new URL(name, schemaRoot), 'utf8')));
  const routes = codexCapabilityTable.hooks.eventRoutes as Readonly<Record<string, { readonly nativeEvent?: string; readonly state: string }>>;
  const covered = new Set<string>();

  for (const [event, route] of Object.entries(routes)) {
    if (route.state !== 'supported' || route.nativeEvent === undefined) continue;
    const canonicalEvent = event as CanonicalAgentEvent;
    const starter = codexAdapter.hookContract!.nativeEventStarter!(canonicalEvent);
    expect(starter, event).toBeDefined();
    const schemas = schemasFor[route.nativeEvent]!;
    const validateInput = await compile(schemas.input);
    expect(validateInput(starter), `${event} ${JSON.stringify(validateInput.errors)}`).toBe(true);
    expect(() => validateNativeEventEnvelope(starter, {
      canonicalEvent,
      nativeEvent: route.nativeEvent!,
      target: 'codex',
    })).not.toThrow();
    covered.add(route.nativeEvent);

    const canonicalHookEvent = canonicalHookEventFor[route.nativeEvent];
    const sample = outputSamples[route.nativeEvent];
    if (schemas.output === undefined || canonicalHookEvent === undefined || sample === undefined) continue;
    const validateOutput = await compile(schemas.output);
    const encoded = encodeNativeHookPlaygroundOutput(sample, canonicalHookEvent as never, route.nativeEvent, 'codex');
    expect(encoded, event).toBeDefined();
    expect(validateOutput(encoded), `${event} ${JSON.stringify(validateOutput.errors)}`).toBe(true);
  }
  expect([...covered].sort()).toEqual([...releaseEvents].sort());
});

it('accepts a null last_assistant_message on Codex Stop as the pinned stop input schema does', () => {
  const stop = {
    cwd: '/workspace',
    hook_event_name: 'Stop',
    last_assistant_message: null,
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    session_id: 'session-codex-1',
    stop_hook_active: false,
    transcript_path: null,
    turn_id: 'turn-codex-1',
  };
  expect(validateNativeEventEnvelope(stop, { canonicalEvent: 'stop', nativeEvent: 'Stop', target: 'codex' })).toBe(stop);
  expect(() => validateNativeEventEnvelope(
    { ...stop, transcript_path: '/tmp/transcript.jsonl' },
    { canonicalEvent: 'stop', nativeEvent: 'Stop', target: 'claude' },
  )).toThrow(/last_assistant_message must be a (?:nonempty )?string/u);
});
