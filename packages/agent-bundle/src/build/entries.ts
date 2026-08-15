import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import type { TargetHookEntry } from '../adapters/types.ts';
import type { NormalizedMcpServer, NormalizedScript } from '../core/types.ts';
import { stableJson } from '../core/digest.ts';
import { emitPlanEntries, resolveArtifactDestination } from './emit.ts';
import type { CompiledMcpApp } from './mcp-apps.ts';
import type { ArtifactOutputKind } from './provenance.ts';
import { buildWithRslib } from './rslib.ts';

export interface CompiledEntry {
  readonly name: string;
  readonly output: string;
  readonly outputKind: ArtifactOutputKind;
  readonly source: string;
  readonly sourceInputs: readonly string[];
}

interface PlannedScriptEntry extends CompiledEntry {
  readonly mode: NormalizedScript['mode'];
}

export interface CompiledHookEntry extends CompiledEntry {
  readonly event: TargetHookEntry['event'];
  readonly id: string;
  readonly target: string;
  /** Native hook timeout in seconds. Omit it to use the host default. */
  readonly timeout?: number;
}

export interface CompiledMcpEntry extends CompiledEntry {
  readonly id: string;
  readonly target: string;
}

const outputName = (script: NormalizedScript): string =>
  script.mode === 'bundle' ? `${script.name}.mjs` : `${script.name}${extname(script.source)}`;

export const planCompiledEntries = (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): readonly PlannedScriptEntry[] => {
  const names = new Set<string>();
  return Object.freeze(entries.map((script) => {
    const filename = outputName(script);
    if (script.name.length === 0 || names.has(filename)) {
      throw new Error(`Duplicate compiled script destination ${JSON.stringify(`scripts/${filename}`)}.`);
    }
    names.add(filename);
    return {
      mode: script.mode,
      name: script.name,
      output: resolveArtifactDestination(
        resolve(options.outDir, 'scripts'),
        filename,
      ),
      outputKind: script.mode === 'copy' ? 'copy' as const : 'bundle' as const,
      source: script.source,
      sourceInputs: Object.freeze([script.provenance.sourcePath, script.source]),
    };
  }).map((entry) => Object.freeze(entry)));
};

export const compileEntries = async (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): Promise<readonly CompiledEntry[]> => {
  const compiled = planCompiledEntries(entries, options);
  const bundled = compiled.filter((entry) => entry.mode === 'bundle');
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: bundled.map(({ name, source, sourceInputs }) => ({
      name,
      outputRelativePath: `scripts/${name}.mjs`,
      source,
      sourceInputs,
    })),
    outputRoot: options.outDir,
  });
  await emitPlanEntries({
    entries: await Promise.all(compiled
      .filter((entry) => entry.mode === 'copy')
      .map(async (entry) => ({
        bytes: (await stat(entry.source)).size,
        kind: 'copy' as const,
        relativePath: relative(options.outDir, entry.output).replaceAll('\\', '/'),
        source: entry.source,
        sourceInputs: entry.sourceInputs,
      }))),
    root: options.outDir,
  });

  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  return Object.freeze(compiled.map((entry) => Object.freeze({
    ...entry,
    sourceInputs: entry.mode === 'bundle'
      ? evidenceByPath.get(`scripts/${entry.name}.mjs`) ?? (() => { throw new Error(`Missing bundled script evidence for ${JSON.stringify(entry.name)}.`); })()
      : entry.sourceInputs,
  })));
};

const localMcpOutputName = (server: NormalizedMcpServer): string => {
  const output = server.args?.[0];
  const match = typeof output === 'string'
    ? /^mcp\/(mcp-[a-z0-9-]+-[a-f\d]{8}\.mjs)$/u.exec(output)
    : undefined;
  if (server.source === undefined || match?.[1] === undefined) {
    throw new Error(`MCP server ${JSON.stringify(server.name)} has an unsafe local output alias.`);
  }
  return match[1];
};

export const planCompiledMcpEntries = (
  servers: readonly NormalizedMcpServer[],
  options: { readonly outDir: string; readonly target: string },
): readonly CompiledMcpEntry[] => {
  const names = new Set<string>();
  return Object.freeze(servers
    .filter((server) => server.source !== undefined && server.targets.includes(options.target))
    .map((server) => {
      const outputName = localMcpOutputName(server);
      const name = outputName.slice(0, -extname(outputName).length);
      if (names.has(name)) {
        throw new Error(`Duplicate compiled MCP destination ${JSON.stringify(`mcp/${outputName}`)}.`);
      }
      names.add(name);
      return Object.freeze({
        id: server.id,
        name,
        output: resolveArtifactDestination(resolve(options.outDir, 'mcp'), outputName),
        outputKind: 'bundle',
        source: server.source!,
        sourceInputs: Object.freeze([server.provenance.sourcePath, server.source!]),
        target: options.target,
      });
    }));
};

export const compileMcpEntries = async (
  servers: readonly NormalizedMcpServer[],
  options: {
    readonly apps?: readonly CompiledMcpApp[];
    readonly cwd: string;
    readonly outDir: string;
    readonly target: string;
  },
): Promise<readonly CompiledMcpEntry[]> => {
  const compiled = planCompiledMcpEntries(servers, options);
  const virtualSources = await Promise.all(compiled.map(async (entry) => {
    const records = await Promise.all((options.apps ?? [])
      .filter((app) => app.serverId === entry.id)
      .map(async (app) => ({
        ...(app._meta === undefined ? {} : { _meta: app._meta }),
        html: await readFile(app.output, 'utf8'),
        mimeType: app.mimeType,
        name: app.name,
        resourceUri: app.resourceUri,
      })));
    return [
      `const mcpApps = Object.freeze(${stableJson(records)});`,
      'export { mcpApps };',
      'export default mcpApps;',
      '',
    ].join('\n');
  }));
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: compiled.map(({ id, name, source, sourceInputs }, index) => ({
      name,
      outputRelativePath: `mcp/${name}.mjs`,
      source,
      sourceInputs: Object.freeze([
        ...sourceInputs,
        ...(options.apps ?? [])
          .filter((app) => app.serverId === id)
          .flatMap((app) => app.sourceInputs),
      ]),
      virtualModules: [{
        name: 'agent-bundle/mcp-apps',
        source: virtualSources[index]!,
      }],
    })),
    outputRoot: options.outDir,
  });
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  return Object.freeze(compiled.map((entry) => Object.freeze({
    ...entry,
    sourceInputs: evidenceByPath.get(`mcp/${entry.name}.mjs`) ?? (() => { throw new Error(`Missing bundled MCP evidence for ${JSON.stringify(entry.name)}.`); })(),
  })));
};

const wrapperSource = (entry: TargetHookEntry): string => {
  const codecName = entry.target === 'codex' ? 'Codex' : 'Claude';
  const nativeEvent = {
    afterTool: 'PostToolUse',
    beforeTool: 'PreToolUse',
    sessionStart: 'SessionStart',
    stop: 'Stop',
  }[entry.event];

  return [
    `import * as handlerModule from ${JSON.stringify(entry.hook.source)};`,
    `const target = ${JSON.stringify(entry.target)};`,
    `const canonicalEvent = ${JSON.stringify(entry.event)};`,
    `const nativeEvent = ${JSON.stringify(nativeEvent)};`,
    '',
    'const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);',
    'const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));',
    `const decode${codecName}Native = (nativeInput) => ({`,
    '  cwd: nativeInput.cwd,',
    '  hookEventName: nativeInput.hook_event_name,',
    '  lastAssistantMessage: nativeInput.last_assistant_message,',
    '  sessionId: nativeInput.session_id,',
    '  source: nativeInput.source,',
    '  stopHookActive: nativeInput.stop_hook_active,',
    '  toolInput: nativeInput.tool_input,',
    '  toolName: nativeInput.tool_name,',
    '  toolResponse: nativeInput.tool_response,',
    '  toolUseId: nativeInput.tool_use_id,',
    '  transcriptPath: nativeInput.transcript_path,',
    '});',
    `const encode${codecName}Native = (canonicalInput) => defined({`,
    '  cwd: canonicalInput.cwd,',
    '  hook_event_name: nativeEvent,',
    '  last_assistant_message: canonicalInput.lastAssistantMessage,',
    '  session_id: canonicalInput.sessionId,',
    '  source: canonicalInput.source,',
    '  stop_hook_active: canonicalInput.stopHookActive,',
    '  tool_input: canonicalInput.toolInput,',
    '  tool_name: canonicalInput.toolName,',
    '  tool_response: canonicalInput.toolResponse,',
    '  tool_use_id: canonicalInput.toolUseId,',
    '  transcript_path: canonicalInput.transcriptPath,',
    '});',
    `const decodeNative = decode${codecName}Native;`,
    `const encodeNative = encode${codecName}Native;`,
    'const fail = (message) => { throw new Error(`Agent Bundle hook error: ${message}`); };',
    'const validateResult = (result) => {',
    '  if (result === undefined) return undefined;',
    '  if (!isRecord(result)) fail("handler must return void or a result object");',
    '  const allowed = new Set(["outcome", "reason", "updatedInput", "additionalContext"]);',
    '  for (const key of Object.keys(result)) if (!allowed.has(key)) fail(`handler result has unsupported field ${key}`);',
    '  if (result.outcome !== undefined && !["continue", "deny", "stop"].includes(result.outcome)) fail("handler result outcome is invalid");',
    '  if (result.reason !== undefined && typeof result.reason !== "string") fail("handler result reason must be a string");',
    '  if (result.additionalContext !== undefined && typeof result.additionalContext !== "string") fail("handler result additionalContext must be a string");',
    '  if (result.updatedInput !== undefined && !isRecord(result.updatedInput)) fail("handler result updatedInput must be an object");',
    '  if (result.reason !== undefined && !(result.outcome === "deny" && (canonicalEvent === "beforeTool" || canonicalEvent === "stop"))) fail("reason is only valid for a denied beforeTool or stop hook");',
    '  if (result.outcome === "deny" && (canonicalEvent === "beforeTool" || canonicalEvent === "stop") && (typeof result.reason !== "string" || result.reason.trim().length === 0)) fail(`denied ${canonicalEvent} hook requires a nonempty reason`);',
    '  if ((canonicalEvent === "sessionStart" || canonicalEvent === "afterTool") && (result.outcome === "deny" || result.outcome === "stop" || result.updatedInput !== undefined)) fail(`${canonicalEvent} cannot deny, stop, or replace input`);',
    '  if (canonicalEvent === "beforeTool" && (result.outcome === "stop" || (result.outcome === "deny" && result.updatedInput !== undefined))) fail("beforeTool cannot stop or replace input while denying");',
    '  if (canonicalEvent === "stop" && (result.outcome === "stop" || result.updatedInput !== undefined || result.additionalContext !== undefined)) fail("stop only accepts continue or deny with a reason");',
    '  return result;',
    '};',
    'const encodeOutput = (result) => {',
    '  if (result === undefined) return undefined;',
    '  if (canonicalEvent === "stop") return result.outcome === "deny" ? defined({ decision: "block", reason: result.reason }) : undefined;',
    '  const output = defined({',
    '    additionalContext: result.additionalContext,',
    '    hookEventName: nativeEvent,',
    '    permissionDecision: canonicalEvent === "beforeTool" ? (result.outcome === "deny" ? "deny" : "allow") : undefined,',
    '    permissionDecisionReason: canonicalEvent === "beforeTool" && result.outcome === "deny" ? result.reason : undefined,',
    '    updatedInput: canonicalEvent === "beforeTool" && result.outcome !== "deny" ? result.updatedInput : undefined,',
    '  });',
    '  return Object.keys(output).length === 1 && output.hookEventName !== undefined ? undefined : { hookSpecificOutput: output };',
    '};',
    'const decodeOutput = (nativeOutput) => {',
    '  if (nativeOutput === undefined) return undefined;',
    '  if (canonicalEvent === "stop") return nativeOutput.decision === "block" ? defined({ outcome: "deny", reason: nativeOutput.reason }) : undefined;',
    '  const output = nativeOutput.hookSpecificOutput;',
    '  if (!isRecord(output)) fail("native hook output is malformed");',
    '  return defined({',
    '    additionalContext: output.additionalContext,',
    '    outcome: output.permissionDecision === "deny" ? "deny" : "continue",',
    '    reason: output.permissionDecisionReason,',
    '    updatedInput: output.updatedInput,',
    '  });',
    '};',
    'const requireString = (input, field) => {',
    '  if (typeof input[field] !== "string") fail(`native ${field} must be a string`);',
    '};',
    'const validateNativeInput = (input) => {',
    '  requireString(input, "session_id");',
    '  requireString(input, "transcript_path");',
    '  requireString(input, "cwd");',
    '  if (input.hook_event_name !== nativeEvent) fail(`native hook_event_name must equal ${nativeEvent}`);',
    '  if (canonicalEvent === "sessionStart") { requireString(input, "source"); return; }',
    '  if (canonicalEvent === "beforeTool" || canonicalEvent === "afterTool") {',
    '    requireString(input, "tool_name");',
    '    if (!isRecord(input.tool_input)) fail(`native ${nativeEvent} tool_input must be an object`);',
    '    requireString(input, "tool_use_id");',
    '    if (canonicalEvent === "afterTool" && !isRecord(input.tool_response)) fail("native PostToolUse tool_response must be an object");',
    '    return;',
    '  }',
    '  if (typeof input.stop_hook_active !== "boolean") fail("native Stop stop_hook_active must be a boolean");',
    '  requireString(input, "last_assistant_message");',
    '};',
    'const run = async () => {',
    '  const handler = Reflect.get(handlerModule, "default");',
    '  if (typeof handler !== "function") fail("default export must be a function");',
    '  let raw = "";',
    '  for await (const chunk of process.stdin) raw += chunk;',
    '  if (raw.trim().length === 0) fail("stdin must contain exactly one JSON value");',
    '  let input;',
    '  try { input = JSON.parse(raw); } catch { fail("stdin must contain exactly one JSON value"); }',
    '  if (!isRecord(input)) fail("stdin JSON value must be an object");',
    '  const simulation = process.env.AGENT_BUNDLE_HOOK_SIMULATION === "1";',
    '  const nativeInput = simulation ? encodeNative(input) : input;',
    '  validateNativeInput(nativeInput);',
    '  const event = decodeNative(nativeInput);',
    '  const result = validateResult(await handler(event, { nativeEvent, nativeInput, target }));',
    '  const nativeOutput = encodeOutput(result);',
    '  const output = simulation ? decodeOutput(nativeOutput) : nativeOutput;',
    '  if (output !== undefined) process.stdout.write(JSON.stringify(output));',
    '};',
    'await run().catch((error) => {',
    '  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);',
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n');
};

export const planCompiledHooks = (
  entries: readonly TargetHookEntry[],
  options: { readonly outDir: string },
): readonly CompiledHookEntry[] => Object.freeze(entries.map((entry) => Object.freeze({
  event: entry.event,
  id: entry.hook.id,
  name: entry.hook.name,
  output: resolveArtifactDestination(options.outDir, entry.relativePath),
  outputKind: 'bundle',
  source: entry.hook.source,
  sourceInputs: Object.freeze([entry.hook.provenance.sourcePath, entry.hook.source]),
  target: entry.target,
  ...(entry.hook.timeout === undefined ? {} : { timeout: entry.hook.timeout }),
})));

export const compileHooks = async (
  entries: readonly TargetHookEntry[],
  options: { readonly cwd: string; readonly outDir: string },
): Promise<readonly CompiledHookEntry[]> => {
  const compiled = planCompiledHooks(entries, options);
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: compiled.map((entry) => ({
      name: entry.name,
      outputRelativePath: `hooks/${entry.name}.mjs`,
      source: entry.source,
      sourceInputs: entry.sourceInputs,
      virtualSource: wrapperSource(entries.find((candidate) => candidate.hook.id === entry.id)!),
    })),
    outputRoot: options.outDir,
  });
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  return Object.freeze(compiled.map((entry) => Object.freeze({
    ...entry,
    sourceInputs: evidenceByPath.get(`hooks/${entry.name}.mjs`) ?? (() => { throw new Error(`Missing bundled hook evidence for ${JSON.stringify(entry.name)}.`); })(),
  })));
};
