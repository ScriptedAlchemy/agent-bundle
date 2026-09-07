import { posix } from 'node:path';

import capabilityTable from './capabilities/amp-0.0.0-20260907001852-gf348fed.json' with { type: 'json' };
import {
  capabilityEvidence,
  eventRouteCapabilitiesFrom,
  supportedCapability,
  unavailableCapability,
} from './capability-state.ts';
import { createTargetDiagnostics } from './diagnostics.ts';
import {
  planHooks,
  type TargetHookContract,
  type TargetHookWrapper,
} from './hook-contract.ts';
import {
  hasPathToken,
  sortedEntries,
  sourceInputs,
  type TargetAdapter,
  type TargetArtifactEntry,
  type TargetArtifactPlan,
} from './types.ts';
import { operatorEnvLayerImport } from '../build/launch-env-shell.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isPortablePathSegment } from '../core/paths.ts';
import { stableJson } from '../core/digest.ts';
import { isPlainDataRecord } from '../core/strict-json.ts';
import {
  type NormalizedHook,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';

const ampName = 'amp';
const metadata = Object.freeze({
  adapterRevision: '1.0.0',
  observedVersion: capabilityTable.pluginApi.version,
  schemas: Object.freeze([]),
});
const evidence = capabilityEvidence(ampName, metadata);
const { errorDiagnostic } = createTargetDiagnostics(ampName, 'Amp');

const ampPluginRoot = (plugin: string): string => `.amp/plugins/${plugin}`;

const factoryName = (name: string): string => {
  const identifier = name.replace(
    /[^A-Za-z\d_$]+([A-Za-z\d_$])?/gu,
    (_, character: string | undefined) => character?.toUpperCase() ?? '',
  );
  return /^[A-Za-z_$]/u.test(identifier) ? identifier : `plugin${identifier}`;
};

const mcpServerPlan = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const diagnostics: Diagnostic[] = [];
  if (server.source !== undefined) {
    diagnostics.push(errorDiagnostic(
      'amp.mcp.generated-local',
      `Amp skill MCP server ${JSON.stringify(server.name)} is compiler-owned, but the pinned skill MCP contract ` +
        'documents no plugin-root placeholder or execution cwd for a relocatable generated entry.',
    ));
    return { diagnostics };
  }
  if (server.transport === 'streamable-http') {
    return {
      diagnostics,
      value: {
        ...(server.headers === undefined ? {} : { headers: server.headers }),
        url: server.url,
      },
    };
  }
  if (server.cwd !== undefined) {
    diagnostics.push(errorDiagnostic(
      'amp.mcp.cwd',
      `Amp skill MCP server ${JSON.stringify(server.name)} declares cwd, which the pinned skill MCP document does not support.`,
    ));
  }
  if (
    typeof server.command !== 'string'
    || server.command.trim() === ''
    || server.command.includes('/')
    || server.command.includes('\\')
  ) {
    diagnostics.push(errorDiagnostic(
      'amp.mcp.command',
      `Amp skill MCP server ${JSON.stringify(server.name)} must use a nonempty globally resolvable command, not a filesystem path.`,
    ));
  }
  const values = [
    ['command', server.command],
    ...(server.args ?? []).map((value, index) => [`args[${index}]`, value] as const),
    ...Object.entries(server.env ?? {}).map(([name, value]) => [`env.${name}`, value] as const),
  ] as const;
  for (const [location, value] of values) {
    if (value !== undefined && hasPathToken(value)) {
      diagnostics.push(errorDiagnostic(
        `amp.mcp.path-token.${location.replaceAll(/[^a-z\d]+/giu, '-').toLowerCase()}`,
        `Amp skill MCP server ${JSON.stringify(server.name)} ${location} uses an Agent Bundle path token, ` +
          'but the pinned Amp contract documents no plugin-root token.',
      ));
    }
  }
  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics,
    value: {
      ...(server.args === undefined ? {} : { args: server.args }),
      command: server.command,
      ...(server.env === undefined ? {} : { env: server.env }),
    },
  };
};

const encodeAmpPlaygroundInput = (
  input: Readonly<Record<string, unknown>>,
  nativeEvent: string,
): Readonly<Record<string, unknown>> => {
  const base = {
    hook_event_name: nativeEvent,
    session_id: input.sessionId,
  };
  if (nativeEvent === 'tool.call') {
    return deepFreeze({
      ...base,
      tool_input: input.toolInput,
      tool_name: input.toolName,
      tool_use_id: input.toolUseId,
    });
  }
  return deepFreeze(base);
};

const encodeAmpPlaygroundOutput = (
  result: Readonly<Record<string, unknown>> | undefined,
  canonicalEvent: string,
): Readonly<Record<string, unknown>> | undefined => {
  if (result === undefined || canonicalEvent !== 'beforeTool') return undefined;
  if (result.outcome === 'deny') {
    return {
      action: 'reject-and-continue',
      message: result.reason,
    };
  }
  return isPlainDataRecord(result.updatedInput)
    ? { action: 'modify', input: result.updatedInput }
    : undefined;
};

const ampHookWrapperSource = (entry: TargetHookWrapper): string => [
  operatorEnvLayerImport,
  `import * as handlerModule from ${JSON.stringify(entry.hook.source)};`,
  '',
  'const target = "amp";',
  `const canonicalEvent = ${JSON.stringify(entry.event)};`,
  `const nativeEvent = ${JSON.stringify(entry.nativeEvent)};`,
  'const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);',
  'const fail = (message) => { throw new Error(`Agent Bundle hook error: ${message}`); };',
  'const validateInput = (input) => {',
  '  if (!isRecord(input)) fail("stdin JSON value must be an object");',
  '  if (input.hook_event_name !== nativeEvent) fail(`native hook_event_name must equal ${nativeEvent}`);',
  '  if (typeof input.session_id !== "string") fail("native session_id must be a string");',
  '  if (canonicalEvent === "beforeTool") {',
  '    if (typeof input.tool_name !== "string") fail("native tool_name must be a string");',
  '    if (!isRecord(input.tool_input)) fail("native tool_input must be an object");',
  '    if (typeof input.tool_use_id !== "string") fail("native tool_use_id must be a string");',
  '  }',
  '};',
  'const decodeInput = (input) => canonicalEvent === "beforeTool"',
  '  ? { sessionId: input.session_id, toolInput: input.tool_input, toolName: input.tool_name, toolUseId: input.tool_use_id }',
  '  : { sessionId: input.session_id };',
  'const validateResult = (result) => {',
  '  if (result === undefined) return undefined;',
  '  if (!isRecord(result)) fail("handler must return void or a result object");',
  '  const allowed = new Set(["outcome", "reason", "updatedInput", "additionalContext"]);',
  '  for (const key of Object.keys(result)) if (!allowed.has(key)) fail(`handler result has unsupported field ${key}`);',
  '  if (result.outcome !== undefined && result.outcome !== "continue" && result.outcome !== "deny") fail("handler result outcome is invalid");',
  '  if (result.reason !== undefined && typeof result.reason !== "string") fail("handler result reason must be a string");',
  '  if (result.updatedInput !== undefined && !isRecord(result.updatedInput)) fail("handler result updatedInput must be an object");',
  '  if (result.additionalContext !== undefined) fail(`${canonicalEvent} has no Amp additional-context channel as a plain hook`);',
  '  if (canonicalEvent === "sessionStart" && (result.outcome === "deny" || result.reason !== undefined || result.updatedInput !== undefined)) fail("sessionStart is observation-only on Amp");',
  '  if (canonicalEvent === "beforeTool" && result.outcome === "deny" && (typeof result.reason !== "string" || result.reason.trim() === "")) fail("denied beforeTool hook requires a nonempty reason");',
  '  if (canonicalEvent === "beforeTool" && result.outcome === "deny" && result.updatedInput !== undefined) fail("beforeTool cannot replace input while denying");',
  '  return result;',
  '};',
  'const encodeOutput = (result) => {',
  '  if (result === undefined || canonicalEvent === "sessionStart") return undefined;',
  '  if (result.outcome === "deny") return { action: "reject-and-continue", message: result.reason };',
  '  return result.updatedInput === undefined ? undefined : { action: "modify", input: result.updatedInput };',
  '};',
  'const decodeOutput = (output) => {',
  '  if (output?.action === "reject-and-continue") return { outcome: "deny", reason: output.message };',
  '  if (output?.action === "modify") return { outcome: "continue", updatedInput: output.input };',
  '  return undefined;',
  '};',
  'const run = async () => {',
  '  const handler = Reflect.get(handlerModule, "default");',
  '  if (typeof handler !== "function") fail("default export must be a function");',
  '  let raw = "";',
  '  for await (const chunk of process.stdin) raw += chunk;',
  '  if (raw.trim() === "") fail("stdin must contain exactly one JSON value");',
  '  let input;',
  '  try { input = JSON.parse(raw); } catch { fail("stdin must contain exactly one JSON value"); }',
  '  const simulation = process.env.AGENT_BUNDLE_HOOK_SIMULATION === "1";',
  '  const nativeInput = simulation',
  '    ? canonicalEvent === "beforeTool"',
  '      ? { hook_event_name: nativeEvent, session_id: input.sessionId, tool_input: input.toolInput, tool_name: input.toolName, tool_use_id: input.toolUseId }',
  '      : { hook_event_name: nativeEvent, session_id: input.sessionId }',
  '    : input;',
  '  validateInput(nativeInput);',
  '  const result = validateResult(await handler(decodeInput(nativeInput), { nativeEvent, nativeInput, target }));',
  '  const nativeOutput = encodeOutput(result);',
  '  const output = simulation ? decodeOutput(nativeOutput) : nativeOutput;',
  '  if (output !== undefined) process.stdout.write(JSON.stringify(output));',
  '};',
  'if (import.meta.main) {',
  '  await run().catch((error) => {',
  '    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);',
  '    process.exitCode = 1;',
  '  });',
  '}',
  '',
].join('\n');

const hookContract = Object.freeze({
  hostContractRevision: capabilityTable.pluginApi.version,
  commandRoot: '',
  encodePlaygroundInput: encodeAmpPlaygroundInput,
  encodePlaygroundOutput: encodeAmpPlaygroundOutput,
  eventNames: {
    beforeTool: 'tool.call',
    sessionStart: 'session.start',
  },
  eventRouteNames: {
    'prompt/submit': 'agent.start',
    'session/start': 'session.start',
    stop: 'agent.end',
    'tool/after': 'tool.result',
    'tool/before': 'tool.call',
  },
  manifestPath: '.amp/hooks.json',
  matchers: {},
  registration: 'api',
  wrapperPath: (hook) => `hooks/${hook.name}.mjs`,
  wrapperSource: ampHookWrapperSource,
} satisfies TargetHookContract);

interface FactoryHook {
  readonly matcher?: string;
  readonly path: string;
}

const factorySource = (
  model: NormalizedPlugin,
  root: string,
  hooks: readonly TargetHookWrapper[],
  skillNames: readonly string[],
): string => {
  const grouped: Record<string, FactoryHook[]> = Object.create(null) as Record<string, FactoryHook[]>;
  for (const hook of hooks) {
    (grouped[hook.nativeEvent] ??= []).push({
      ...(hook.nativeMatcher === undefined ? {} : { matcher: hook.nativeMatcher }),
      path: `./${posix.relative(root, hook.relativePath)}`,
    });
  }
  const hookTable = Object.fromEntries(
    ['session.start', 'tool.call', 'tool.result', 'agent.start', 'agent.end']
      .flatMap((event) => grouped[event] === undefined ? [] : [[event, grouped[event]]]),
  );
  const description = (model.metadata.description ?? model.metadata.name).slice(0, 300);
  const registrations = skillNames.map((name) =>
    `  await amp.registerSkill({ path: 'skills/${name}' });`);
  const handlers: string[] = [];
  if (grouped['session.start'] !== undefined) {
    handlers.push(
      "  amp.on('session.start', async (event) => {",
      "    const native = { hook_event_name: 'session.start', session_id: event.thread.id };",
      '    for (const hook of hooks["session.start"]) {',
      '      const output = await runHook(hook.path, native);',
      '      if (output !== undefined) throw new Error("Amp session.start hooks cannot return a result.");',
      '    }',
      '  });',
    );
  }
  if (grouped['tool.call'] !== undefined) {
    handlers.push(
      "  amp.on('tool.call', async (event) => {",
      '    let input = event.input;',
      '    let modified = false;',
      '    for (const hook of hooks["tool.call"]) {',
      '      if (hook.matcher !== undefined && !(new RegExp(hook.matcher, "u")).test(event.tool)) continue;',
      "      const output = await runHook(hook.path, { hook_event_name: 'tool.call', session_id: event.thread.id, tool_input: input, tool_name: event.tool, tool_use_id: event.toolUseID });",
      '      if (output === undefined || output.action === "allow") continue;',
      '      if (output.action === "modify" && isRecord(output.input)) { input = output.input; modified = true; continue; }',
      '      if (output.action === "reject-and-continue" && typeof output.message === "string") return { action: "reject-and-continue", message: output.message };',
      '      if (output.action === "synthesize" && isRecord(output.result) && typeof output.result.output === "string" && (output.result.exitCode === undefined || Number.isInteger(output.result.exitCode))) {',
      '        return { action: "synthesize", result: { output: output.result.output, ...(output.result.exitCode === undefined ? {} : { exitCode: output.result.exitCode }) } };',
      '      }',
      '      if (output.action === "error" && typeof output.message === "string") return { action: "error", message: output.message };',
      '      throw new Error("Amp tool.call hook returned an invalid result.");',
      '    }',
      '    return modified ? { action: "modify", input } : { action: "allow" };',
      '  });',
    );
  }
  if (grouped['tool.result'] !== undefined) {
    handlers.push(
      "  amp.on('tool.result', async (event) => {",
      '    let current = { status: event.status, ...(event.error === undefined ? {} : { error: event.error }), ...(event.output === undefined ? {} : { output: event.output }) };',
      '    let replaced = false;',
      '    for (const hook of hooks["tool.result"]) {',
      '      if (hook.matcher !== undefined && !(new RegExp(hook.matcher, "u")).test(event.tool)) continue;',
      "      const output = await runHook(hook.path, { hook_event_name: 'tool.result', session_id: event.thread.id, status: current.status, tool_error: current.error, tool_input: event.input, tool_name: event.tool, tool_response: current.output, tool_use_id: event.toolUseID });",
      '      if (output === undefined) continue;',
      '      if (!["done", "error", "cancelled"].includes(String(output.status))) throw new Error("Amp tool.result hook returned an invalid status.");',
      '      if (output.error !== undefined && typeof output.error !== "string") throw new Error("Amp tool.result hook returned an invalid error.");',
      '      current = { status: output.status, ...(output.error === undefined ? {} : { error: output.error }), ...(output.output === undefined ? {} : { output: output.output }) };',
      '      replaced = true;',
      '    }',
      '    if (!replaced) return;',
      '    if (current.status === "done") return { status: "done", ...(current.output === undefined ? {} : { output: current.output }) };',
      '    if (current.status === "error") return { status: "error", ...(current.error === undefined ? {} : { error: current.error }), ...(current.output === undefined ? {} : { output: current.output }) };',
      '    return { status: "cancelled", ...(current.error === undefined ? {} : { error: current.error }), ...(current.output === undefined ? {} : { output: current.output }) };',
      '  });',
    );
  }
  if (grouped['agent.start'] !== undefined) {
    handlers.push(
      "  amp.on('agent.start', async (event) => {",
      '    const messages = [];',
      '    for (const hook of hooks["agent.start"]) {',
      "      const output = await runHook(hook.path, { hook_event_name: 'agent.start', prompt: event.message, prompt_id: event.id, session_id: event.thread.id });",
      '      if (output === undefined) continue;',
      '      if (!isRecord(output.message) || typeof output.message.content !== "string" || (output.message.display !== undefined && typeof output.message.display !== "boolean")) throw new Error("Amp agent.start hook returned an invalid message.");',
      '      messages.push(output.message);',
      '    }',
      '    if (messages.length === 0) return {};',
      '    return { message: { content: messages.map((message) => message.content).join("\\n"), ...(messages.some((message) => message.display === true) ? { display: true } : {}) } };',
      '  });',
    );
  }
  if (grouped['agent.end'] !== undefined) {
    handlers.push(
      "  amp.on('agent.end', async (event) => {",
      '    for (const hook of hooks["agent.end"]) {',
      "      const output = await runHook(hook.path, { hook_event_name: 'agent.end', prompt: event.message, prompt_id: event.id, session_id: event.thread.id, status: event.status });",
      '      if (output === undefined) continue;',
      '      if (output.action === "continue" && typeof output.userMessage === "string") return { action: "continue", userMessage: output.userMessage };',
      '      throw new Error("Amp agent.end hook returned an invalid result.");',
      '    }',
      '  });',
    );
  }
  const runtime = Object.keys(hookTable).length === 0 ? [] : [
    '/** @type {Readonly<Record<string, readonly { matcher?: string, path: string }[]>>} */',
    `const hooks = Object.freeze(${JSON.stringify(hookTable)});`,
    '/** @param {unknown} value */',
    'const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);',
    '/** @param {string} relativePath */',
    'const filePath = (relativePath) => {',
    '  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname);',
    '  return process.platform === "win32" ? pathname.slice(1).replaceAll("/", "\\\\") : pathname;',
    '};',
    '/** @param {string} relativePath @param {Record<string, unknown>} input */',
    'const runHook = async (relativePath, input) => {',
    '  const child = Bun.spawn([process.execPath, filePath(relativePath)], { stderr: "pipe", stdin: "pipe", stdout: "pipe" });',
    '  const stdout = new Response(child.stdout).text();',
    '  const stderr = new Response(child.stderr).text();',
    '  child.stdin.write(JSON.stringify(input));',
    '  child.stdin.end();',
    '  const [code, output, error] = await Promise.all([child.exited, stdout, stderr]);',
    '  if (code !== 0) throw new Error(error.trim() || `Amp hook process exited with code ${String(code)}.`);',
    '  if (error !== "") process.stderr.write(error);',
    '  if (output === "") return undefined;',
    '  const parsed = JSON.parse(output);',
    '  if (!isRecord(parsed)) throw new Error("Amp hook process returned a non-object result.");',
    '  return parsed;',
    '};',
    '',
  ];
  return [
    `export const description = ${JSON.stringify(description)};`,
    ...runtime,
    `/** @param {import('@ampcode/plugin').PluginAPI} amp */`,
    `export default async function ${factoryName(model.metadata.name)}(amp) {`,
    ...registrations,
    ...handlers,
    '}',
    '',
  ].join('\n');
};

const plan = (model: NormalizedPlugin): TargetArtifactPlan => {
  const diagnostics = [];
  if (!isPortablePathSegment(model.metadata.name)) {
    diagnostics.push(errorDiagnostic(
      'amp.name',
      `Amp directory plugin name ${JSON.stringify(model.metadata.name)} must be a portable path segment.`,
    ));
  }
  const root = ampPluginRoot(model.metadata.name);
  const selected = (targets: readonly string[]): boolean => targets.includes(ampName);
  const skills = model.skills.filter((skill) => selected(skill.targets));
  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const server of model.mcpServers) {
    if (!selected(server.targets)) continue;
    const planned = mcpServerPlan(server);
    diagnostics.push(...planned.diagnostics);
    if (planned.value !== undefined) servers[server.name] = planned.value;
  }
  const hasMcp = Object.keys(servers).length > 0;
  if (hasMcp && skills.length !== 1) {
    diagnostics.push(errorDiagnostic(
      'amp.mcp.skill-scope',
      `Amp MCP is skill-scoped, so a canonical server requires exactly one Amp skill; this projection has ${skills.length}.`,
    ));
  }
  for (const hook of model.hooks) {
    if (!selected(hook.targets)) continue;
    if (hook.prebuiltPath !== undefined) {
      diagnostics.push(errorDiagnostic(
        'amp.hook.prebuilt',
        `Amp hook ${JSON.stringify(hook.name)} is prebuilt, but a directory plugin registers callbacks from its generated factory rather than a native hook command document.`,
      ));
    }
    if (hook.timeoutMs !== undefined) {
      diagnostics.push(errorDiagnostic(
        'amp.hook.timeout',
        `Amp hook ${JSON.stringify(hook.name)} declares a timeout, but PluginAPI event registration exposes no per-handler timeout.`,
      ));
    }
  }

  const planContract: TargetHookContract = Object.freeze({
    ...hookContract,
    wrapperPath: (hook: NormalizedHook) => `${root}/hooks/${hook.name}.mjs`,
  });
  const generatedHooks = planHooks(model, ampName, planContract);
  diagnostics.push(...generatedHooks.diagnostics);

  const entries: TargetArtifactEntry[] = [];
  for (const skill of skills) {
    const prefix = `${root}/skills/${skill.name}`;
    const hostDocument = skill.hostDocuments?.[ampName];
    const generated = hostDocument !== undefined && !hostDocument.passThrough;
    if (generated) {
      entries.push({
        content: hostDocument.skillMarkdown,
        kind: 'write',
        relativePath: `${prefix}/SKILL.md`,
        sourceInputs: sourceInputs(skill.source),
      });
    } else if (skill.markdown !== undefined) {
      entries.push({
        content: skill.markdown,
        kind: 'write',
        relativePath: `${prefix}/SKILL.md`,
        sourceInputs: sourceInputs(skill.source),
      });
    }
    const generatedSidecars = new Set(generated
      ? hostDocument.sidecars.map((sidecar) => sidecar.relativePath)
      : []);
    for (const sidecar of generated ? hostDocument.sidecars : []) {
      if (sidecar.content === undefined) continue;
      entries.push({
        content: sidecar.content.endsWith('\n') ? sidecar.content : `${sidecar.content}\n`,
        kind: 'write',
        relativePath: `${prefix}/${sidecar.relativePath}`,
        sourceInputs: sourceInputs(skill.source, sidecar.source),
      });
    }
    const nativeMcp = isPlainDataRecord(hostDocument?.frontmatter.mcpServers);
    const mcpResource = skill.resources.find((resource) => resource.relativePath === 'mcp.json');
    if (hasMcp && (nativeMcp || mcpResource !== undefined)) {
      diagnostics.push(errorDiagnostic(
        'amp.mcp.precedence',
        `Amp skill ${JSON.stringify(skill.name)} already declares ${nativeMcp ? 'mcpServers frontmatter' : 'mcp.json'}; ` +
          'that native source takes precedence over the canonical MCP servers, so the generated document is omitted.',
      ));
    }
    if (hasMcp && skills.length === 1 && !nativeMcp && mcpResource === undefined) {
      entries.push({
        content: `${stableJson(servers)}\n`,
        kind: 'write',
        relativePath: `${prefix}/mcp.json`,
        sourceInputs: sourceInputs(...model.mcpServers
          .filter((server) => selected(server.targets))
          .map((server) => server.provenance.sourcePath)),
      });
    }
    const skipped = new Set(generated ? ['SKILL.md', ...generatedSidecars] : []);
    for (const resource of skill.resources) {
      if (skipped.has(resource.relativePath)) continue;
      entries.push({
        bytes: resource.bytes,
        kind: 'copy',
        relativePath: `${prefix}/${resource.relativePath}`,
        source: resource.source,
        sourceInputs: sourceInputs(skill.source, resource.source),
      });
    }
  }
  entries.push({
    content: factorySource(model, root, generatedHooks.hookEntries, skills.map((skill) => skill.name)),
    kind: 'write',
    relativePath: `${root}/index.js`,
    sourceInputs: sourceInputs(
      model.metadata.provenance.sourcePath,
      ...skills.map((skill) => skill.source),
      ...model.hooks.filter((hook) => selected(hook.targets)).map((hook) => hook.provenance.sourcePath),
    ),
  });
  return deepFreeze({
    diagnostics,
    documents: { entry: `${root}/index.js` },
    entries: sortedEntries(entries),
    hookEntries: generatedHooks.hookEntries,
  });
};

export const ampAdapter: TargetAdapter = Object.freeze({
  artifactLayout: Object.freeze({
    rootDirectories: Object.freeze(['.amp']),
    rootDocuments: Object.freeze(['INSTALL.md']),
    skills: '.amp/plugins/{plugin}/skills',
  }),
  capabilities: Object.freeze({
    ...eventRouteCapabilitiesFrom(capabilityTable.eventRoutes, evidence),
    commands: unavailableCapability(capabilityTable.plugin.commands.reason),
    hooks: supportedCapability(evidence),
    'hooks.timeout': unavailableCapability('PluginAPI event handlers expose no per-handler timeout setting.'),
    'hooks.toolMatchers': Object.freeze({
      evidence,
      reason: 'Amp publishes no canonical built-in tool-name table; only explicit amp:<native-name> selectors are lowered.',
      state: 'degraded',
    }),
    install: supportedCapability(evidence),
    lsp: unavailableCapability(capabilityTable.plugin.lsp.reason),
    marketplace: unavailableCapability('Amp project/system directory plugins do not use a marketplace document.'),
    mcp: supportedCapability(evidence),
    mcpLegacySse: unavailableCapability('The canonical Agent Bundle MCP transport set does not emit legacy SSE.'),
    nativeDiagnostics: unavailableCapability(capabilityTable.plugin.nativeDiagnostics.reason),
    nativeExtension: unavailableCapability(capabilityTable.plugin.nativeExtension.reason),
    rules: unavailableCapability(capabilityTable.plugin.rules.reason),
    skills: supportedCapability(evidence),
    'skills.builtinTools': supportedCapability(evidence),
    'skills.hostFrontmatter': supportedCapability(evidence),
    'skills.markdownTokens': unavailableCapability('Amp documents no Skill Markdown interpolation syntax.'),
    'skills.mcpServers': supportedCapability(evidence),
  }),
  hookContract,
  mcpScope: 'skill',
  metadata,
  name: ampName,
  plan,
});
