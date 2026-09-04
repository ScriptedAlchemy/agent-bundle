import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import claudeCapabilityTable from '../src/adapters/capabilities/claude-2.1.260.json' with { type: 'json' };
import { readStandardNativeHookCommands } from '../src/adapters/hook-contract.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import hooksSchema from '../src/adapters/schemas/claude/hooks.schema.json' with { type: 'json' };
import schemaProvenance from '../src/adapters/schemas/claude/PROVENANCE.json' with { type: 'json' };
import { createAdapterValidator } from '../src/adapters/types.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import type { LoadedConfig } from '../src/config/load.ts';

const fixtureRoot = new URL('./fixtures/claude-hooks-schema/', import.meta.url);
/**
 * The Claude CLI the schema is pinned to (PROVENANCE.json observedCliVersion, the
 * exact version CI installs); its `plugin validate --strict --json` verdicts must
 * be recorded beside the cases.
 */
const pinnedCliVersion = schemaProvenance.observedCliVersion;
/**
 * The previous pin, kept as the evidence for the v2.1.251 gate: it has no
 * `--json`, so its verdicts come from the text reporter.
 */
const previousPinCliVersion = '2.1.250';
const validate = createAdapterValidator().compile(hooksSchema);

interface RecordedReport {
  /** Present when the report was parsed from the text reporter (a CLI without `--json`). */
  readonly reporter?: 'text';
  readonly contents: readonly {
    readonly errors: readonly { readonly message: string }[];
    readonly file: string;
    readonly warnings: readonly { readonly message: string }[];
  }[];
  readonly strict: boolean;
  readonly success: boolean;
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(new URL(path, fixtureRoot), 'utf8')) as T;
const caseNames = async (): Promise<readonly string[]> =>
  (await readdir(new URL('./cases/', fixtureRoot))).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();

/**
 * Cases the pinned schema rejects although Claude Code accepts them: each is a
 * deliberate agent-bundle tightening over the documented contract, recorded in
 * PROVENANCE.json. Anything else must agree with the recorded CLI verdict.
 */
const deliberateTightenings: Readonly<Record<string, string>> = {
  'agent-on-session-start': 'hooks reference "Prompt-based hooks": SessionStart supports command and mcp_tool handlers only; the validator does not enforce per-event handler support.',
  'args-on-http': 'closed per-type handler shape: `args` is a command-hook field; Claude silently ignores it on an http handler.',
  'async-on-http': 'closed per-type handler shape: `async` is a command-hook field ("Run hooks in the background": only available on type command).',
  'async-on-prompt': 'closed per-type handler shape: `async` is a command-hook field.',
  'async-rewake-on-mcp': 'closed per-type handler shape: `asyncRewake` is a command-hook field.',
  'continue-on-block-on-agent': 'hooks reference "Agent hook configuration": agent hooks have no continueOnBlock field.',
  'continue-on-block-on-command': 'closed per-type handler shape: `continueOnBlock` is a prompt-hook field.',
  'empty-command': 'an empty command string names no executable; minLength 1 predates this pin.',
  'empty-hooks-array': 'a matcher group with no handlers registers nothing; minItems 1 predates this pin.',
  'http-on-session-start': 'hooks reference "Prompt-based hooks": SessionStart does not support http handlers.',
  'model-on-command': 'closed per-type handler shape: `model` is a prompt/agent-hook field.',
  'prompt-empty': 'an empty prompt sends the model nothing to evaluate.',
  'prompt-on-session-start': 'hooks reference "Prompt-based hooks": SessionStart does not support prompt handlers.',
  'prompt-on-subagent-start': 'hooks reference "Prompt-based hooks": SubagentStart supports command, http and mcp_tool handlers but not prompt or agent.',
  'server-empty': 'an empty server name can never resolve to a connected MCP server.',
  'shell-on-mcp': 'closed per-type handler shape: `shell` is a command-hook field.',
  'timeout-float': 'the hook contract lowers timeoutMs to whole seconds; `timeout` stays an integer as it was before this pin.',
  'unknown-group-field': 'closed matcher-group shape: Claude Code 2.1.250 and 2.1.260 --strict ignore unknown hooks.json keys without a warning, so the pin is the only guard against a misspelled field.',
  'unknown-handler-field': 'closed handler shape: Claude Code 2.1.250 and 2.1.260 --strict ignore unknown hooks.json keys without a warning.',
  'unknown-top-level-field': 'closed document shape: Claude Code 2.1.250 and 2.1.260 --strict ignore unknown hooks.json keys without a warning.',
  'url-on-command': 'closed per-type handler shape: `url` is an http-hook field.',
};

/**
 * Cases the reference gates to a release after the previous pin: the schema and
 * the pinned 2.1.260 CLI accept them, the previous 2.1.250 pin rejected the keys
 * as unknown. Recorded so the gate stays visible for anyone still on 2.1.250.
 */
const newerThanPreviousPin: Readonly<Record<string, string>> = {
  'all-pinned-events': 'every documented event, including PreModelSwitch and PostModelSwitch (v2.1.251 or later); 2.1.250 rejects the two keys.',
  'model-switch-events': 'hooks reference "PreModelSwitch" / "PostModelSwitch": both require Claude Code v2.1.251 or later; 2.1.250 rejects the keys, the pinned 2.1.260 accepts them.',
};

/** The reference's "Hook events": all 33 events the pinned 2.1.260 host knows. */
const documentedEvents = [
  'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'Elicitation', 'ElicitationResult', 'FileChanged', 'InstructionsLoaded',
  'MessageDisplay', 'Notification', 'PermissionDenied', 'PermissionRequest', 'PostCompact', 'PostModelSwitch', 'PostToolBatch',
  'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreModelSwitch', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Setup', 'Stop',
  'StopFailure', 'SubagentStart', 'SubagentStop', 'TaskCompleted', 'TaskCreated', 'TeammateIdle', 'UserPromptExpansion',
  'UserPromptSubmit', 'WorktreeCreate', 'WorktreeRemove',
] as const;
/** hooks reference "Prompt-based hooks": the events that support all five handler types. */
const allHandlerEvents = [
  'PermissionDenied', 'PermissionRequest', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop',
  'SubagentStop', 'TaskCompleted', 'TaskCreated', 'TeammateIdle', 'UserPromptExpansion', 'UserPromptSubmit',
] as const;
const startupEvents = ['SessionStart', 'Setup'] as const;

const handlerGroup = (handler: Readonly<Record<string, unknown>>): unknown => [{ hooks: [handler] }];

it('agrees with the recorded verdict of the pinned Claude CLI and the previous pin on each fixture, except the recorded tightenings', async () => {
  const names = await caseNames();
  expect(names.length).toBeGreaterThan(40);
  const recordedVersions = (await readdir(new URL('./reports/', fixtureRoot))).sort();
  expect(pinnedCliVersion).toBe('2.1.260');
  expect(recordedVersions).toEqual([previousPinCliVersion, pinnedCliVersion]);
  for (const tightening of [...Object.keys(deliberateTightenings), ...Object.keys(newerThanPreviousPin)]) expect(names).toContain(tightening);

  for (const version of recordedVersions) {
    const pinned = version === pinnedCliVersion;
    expect(await readdir(new URL(`./reports/${version}/`, fixtureRoot)), version).toEqual(names.map((name) => `${name}.json`));
    for (const name of names) {
      const document = await readJson<unknown>(`./cases/${name}.json`);
      const report = await readJson<RecordedReport>(`./reports/${version}/${name}.json`);
      const label = `${name} @ ${version}`;
      expect(report.strict, label).toBe(true);
      // 2.1.250 has no `--json`; its verdicts come from the text reporter. The pin records `--json`.
      expect(report.reporter, label).toBe(pinned ? undefined : 'text');
      const accepted = validate(document);
      if (Object.hasOwn(deliberateTightenings, name)) {
        expect(report.success, `${label}: a tightening must be a case Claude accepts`).toBe(true);
        expect(accepted, `${label}: the schema must reject what the tightening describes`).toBe(false);
        continue;
      }
      if (Object.hasOwn(newerThanPreviousPin, name)) {
        expect(accepted, `${label}: the schema admits what the pinned host accepts`).toBe(true);
        expect(report.success, `${label}: gated cases are rejected by the previous pin and accepted by the pin`).toBe(pinned);
        continue;
      }
      expect(accepted, `${label}: schema=${accepted} claude=${report.success} ${JSON.stringify(validate.errors ?? report.contents)}`)
        .toBe(report.success);
    }
  }
});

it('accepts every documented handler type and field, and every documented event, in one document', async () => {
  const full = await readJson<{ readonly hooks: Record<string, unknown> }>('./cases/full.json');
  expect(validate(full), JSON.stringify(validate.errors)).toBe(true);
  const handlers = Object.values(full.hooks).flatMap((groups) =>
    (groups as readonly { readonly hooks: readonly Record<string, unknown>[] }[]).flatMap((group) => group.hooks));
  expect([...new Set(handlers.map((handler) => handler.type))].sort()).toEqual(['agent', 'command', 'http', 'mcp_tool', 'prompt']);
  const fields = new Set(handlers.flatMap((handler) => Object.keys(handler)));
  for (const field of [
    'args', 'async', 'asyncRewake', 'shell', 'if', 'statusMessage', 'once', 'timeout',
    'url', 'headers', 'allowedEnvVars', 'server', 'tool', 'input', 'prompt', 'model', 'continueOnBlock',
  ]) {
    expect(fields.has(field), field).toBe(true);
  }

  const allEvents = await readJson<{ readonly hooks: Record<string, unknown> }>('./cases/all-pinned-events.json');
  expect(validate(allEvents), JSON.stringify(validate.errors)).toBe(true);
  expect(Object.keys(allEvents.hooks).sort()).toEqual([...documentedEvents]);
  expect(Object.keys(hooksSchema.properties.hooks.properties).sort()).toEqual([...documentedEvents]);
  expect(hooksSchema.properties.hooks.additionalProperties).toBe(false);
});

it('closes each event to the handler types the hooks reference documents for it', () => {
  const prompt = { prompt: 'Verify. $ARGUMENTS', type: 'prompt' };
  const agent = { prompt: 'Verify with tools. $ARGUMENTS', type: 'agent' };
  const http = { type: 'http', url: 'http://localhost:8080/hook' };
  const mcpTool = { server: 'plugin:fixture:db', tool: 'scan', type: 'mcp_tool' };
  const command = { command: 'echo hi', type: 'command' };
  for (const event of documentedEvents) {
    const supportsModelHandlers = (allHandlerEvents as readonly string[]).includes(event);
    const startup = (startupEvents as readonly string[]).includes(event);
    expect(validate({ hooks: { [event]: handlerGroup(command) } }), `${event} command`).toBe(true);
    expect(validate({ hooks: { [event]: handlerGroup(mcpTool) } }), `${event} mcp_tool`).toBe(true);
    expect(validate({ hooks: { [event]: handlerGroup(http) } }), `${event} http`).toBe(!startup);
    expect(validate({ hooks: { [event]: handlerGroup(prompt) } }), `${event} prompt`).toBe(supportsModelHandlers);
    expect(validate({ hooks: { [event]: handlerGroup(agent) } }), `${event} agent`).toBe(supportsModelHandlers);
  }
});

it('requires the per-type fields the hooks reference marks required and types every optional one', () => {
  const stop = (handler: Readonly<Record<string, unknown>>): unknown => ({ hooks: { Stop: handlerGroup(handler) } });
  expect(validate(stop({ type: 'command' }))).toBe(false);
  expect(validate(stop({ type: 'http' }))).toBe(false);
  expect(validate(stop({ server: 'db', type: 'mcp_tool' }))).toBe(false);
  expect(validate(stop({ tool: 'scan', type: 'mcp_tool' }))).toBe(false);
  expect(validate(stop({ type: 'prompt' }))).toBe(false);
  expect(validate(stop({ type: 'agent' }))).toBe(false);
  expect(validate(stop({ command: 'echo hi' }))).toBe(false);
  expect(validate(stop({ command: 'echo hi', type: 'webhook' }))).toBe(false);

  expect(validate(stop({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs'], type: 'command' }))).toBe(true);
  expect(validate(stop({ command: 'node', args: [1], type: 'command' }))).toBe(false);
  expect(validate(stop({ command: 'echo hi', shell: 'powershell', type: 'command' }))).toBe(true);
  expect(validate(stop({ command: 'echo hi', shell: 'zsh', type: 'command' }))).toBe(false);
  expect(validate(stop({ command: 'echo hi', if: 'Bash(git *)', once: true, statusMessage: 'Checking', type: 'command' }))).toBe(true);
  expect(validate(stop({ command: 'echo hi', if: 5, type: 'command' }))).toBe(false);
  expect(validate(stop({ command: 'echo hi', once: 'yes', type: 'command' }))).toBe(false);
  expect(validate(stop({ command: 'echo hi', timeout: 0, type: 'command' }))).toBe(false);
  expect(validate(stop({ headers: { Authorization: 'Bearer $TOKEN' }, allowedEnvVars: ['TOKEN'], type: 'http', url: 'http://x' }))).toBe(true);
  expect(validate(stop({ headers: { Authorization: 1 }, type: 'http', url: 'http://x' }))).toBe(false);
  expect(validate(stop({ input: { file_path: '${tool_input.file_path}' }, server: 'db', tool: 'scan', type: 'mcp_tool' }))).toBe(true);
  expect(validate(stop({ input: 'x', server: 'db', tool: 'scan', type: 'mcp_tool' }))).toBe(false);
  expect(validate(stop({ continueOnBlock: true, model: 'haiku', prompt: 'Check. $ARGUMENTS', type: 'prompt' }))).toBe(true);
  expect(validate(stop({ continueOnBlock: true, prompt: 'Check. $ARGUMENTS', type: 'agent' }))).toBe(false);
  expect(validate(stop({ model: 'sonnet', prompt: 'Check. $ARGUMENTS', timeout: 120, type: 'agent' }))).toBe(true);
});

it('keeps the pinned schema descriptor and the capability evidence in step with the widened contract', () => {
  const claude = createDefaultRegistry().get('claude');
  const descriptor = claude.metadata.schemas.find((schema) => schema.name === 'hooks');
  expect(descriptor?.sha256).toBe(schemaProvenance.schemas['hooks.schema.json'].sha256);
  expect(schemaProvenance.hooksSchemaNotes).toContain('hooks.schema.json was re-pinned (uploaded 2026-09-03');
  expect(schemaProvenance.hooksSchemaNotes).toContain('Claude Code 2.1.260');
  expect(schemaProvenance.hooksSchemaNotes).toContain('2.1.250');
  expect(schemaProvenance.hooksSchemaNotes).toContain('PreModelSwitch');
  expect(schemaProvenance.hooksSchemaNotes).toContain('re-pin to 2.1.260');

  const handlerContract = claudeCapabilityTable.hooks.handlerContract;
  expect(handlerContract.types).toEqual(['agent', 'command', 'http', 'mcp_tool', 'prompt']);
  expect(handlerContract.emitted).toEqual({ command: ['command', 'timeout', 'type'] });
  expect(handlerContract.evidence.some((line) => line.startsWith('uploaded 2026-09-03:') && line.includes('hooks-2.md'))).toBe(true);
  expect(handlerContract.evidence.some((line) => line.includes('Claude Code 2.1.260') && line.includes('2.1.250'))).toBe(true);
  for (const feature of ['timeout', 'toolMatchers'] as const) {
    expect(claudeCapabilityTable.hooks.features[feature].evidence.some((line) => line.includes('every handler'))).toBe(true);
  }
});

it('enumerates only command handlers from a native document that mixes the documented handler types', async () => {
  const full = await readJson<Record<string, unknown>>('./cases/full.json');
  const enumerated = readStandardNativeHookCommands(full);
  expect(enumerated.status).toBe('found');
  if (enumerated.status !== 'found') return;
  expect(enumerated.commands.map((entry) => entry.command)).toEqual([
    'node', '"${CLAUDE_PLUGIN_ROOT}"/hooks/pre.sh', '/path/to/run-tests.sh', 'pwsh-thing', 'echo hi', 'echo hi',
  ]);
  expect(readStandardNativeHookCommands({ hooks: { Stop: [{ hooks: [{ prompt: 'x', type: 5 }] }] } })).toEqual({ status: 'invalid' });
  expect(readStandardNativeHookCommands({ hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } })).toEqual({ status: 'invalid' });
});

it('plans a Claude native hooks document that uses every documented handler type', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-hooks-schema-'));
  const registry = createDefaultRegistry();
  const loaded: LoadedConfig = {
    config: {
      claude: { nativeHooks: './claude-hooks.json' },
      plugin: { name: 'review-tools', version: '1.0.0' },
      targets: ['claude'],
    },
    configPath: join(root, 'agent-bundle.config.ts'),
    context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
  };
  try {
    await writeFile(join(root, 'claude-hooks.json'), await readFile(new URL('./cases/full.json', fixtureRoot), 'utf8'));
    const plan = registry.get('claude').plan(await normalizeProject(loaded, { skills: [] }, registry));
    expect(plan.diagnostics).toEqual([]);
    const emitted = plan.entries.find((entry) => entry.kind === 'write' && entry.relativePath === 'hooks/hooks.json');
    expect(emitted?.kind).toBe('write');
    if (emitted?.kind !== 'write') return;
    expect(JSON.parse(emitted.content)).toEqual(await readJson('./cases/full.json'));

    await writeFile(join(root, 'claude-hooks.json'), await readFile(new URL('./cases/prompt-on-session-start.json', fixtureRoot), 'utf8'));
    const rejected = registry.get('claude').plan(await normalizeProject(loaded, { skills: [] }, registry));
    expect(rejected.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['claude.native-hooks.schema']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
