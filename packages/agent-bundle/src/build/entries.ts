import { extname, resolve } from 'node:path';

import type { TargetHookEntry } from '../adapters/types.ts';
import type { NormalizedScript } from '../core/types.ts';
import { resolveArtifactDestination } from './emit.ts';
import { buildWithRslib } from './rslib.ts';

export interface CompiledEntry {
  readonly name: string;
  readonly output: string;
  readonly source: string;
}

export interface CompiledHookEntry extends CompiledEntry {
  readonly event: TargetHookEntry['event'];
  readonly id: string;
  readonly target: string;
}

const outputName = (script: NormalizedScript): string => {
  const extension = extname(script.name);
  return extension.length > 0 ? script.name.slice(0, -extension.length) : script.name;
};

export const planCompiledEntries = (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): readonly CompiledEntry[] => {
  const names = new Set<string>();
  return Object.freeze(entries.map((script) => {
    const name = outputName(script);
    if (name.length === 0 || names.has(name)) {
      throw new Error(`Duplicate compiled script destination ${JSON.stringify(`scripts/${name}.mjs`)}.`);
    }
    names.add(name);
    return {
      name,
      output: resolveArtifactDestination(
        resolve(options.outDir, 'scripts'),
        `${name}.mjs`,
      ),
      source: script.source,
    };
  }).map((entry) => Object.freeze(entry)));
};

export const compileEntries = async (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): Promise<readonly CompiledEntry[]> => {
  const compiled = planCompiledEntries(entries, options);

  await buildWithRslib({
    cwd: options.cwd,
    entries: compiled.map(({ name, source }) => ({
      name,
      outputRelativePath: `scripts/${name}.mjs`,
      source,
    })),
    outputRoot: options.outDir,
  });

  return compiled;
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
    `import handler from ${JSON.stringify(entry.hook.source)};`,
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
    'const run = async () => {',
    '  if (typeof handler !== "function") fail("default export must be a function");',
    '  const raw = await (await import("node:fs/promises")).readFile(0, "utf8");',
    '  if (raw.trim().length === 0) fail("stdin must contain exactly one JSON value");',
    '  let input;',
    '  try { input = JSON.parse(raw); } catch { fail("stdin must contain exactly one JSON value"); }',
    '  if (!isRecord(input)) fail("stdin JSON value must be an object");',
    '  const simulation = process.env.AGENT_BUNDLE_HOOK_SIMULATION === "1";',
    '  const nativeInput = simulation ? encodeNative(input) : input;',
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
  source: entry.hook.source,
  target: entry.target,
})));

export const compileHooks = async (
  entries: readonly TargetHookEntry[],
  options: { readonly cwd: string; readonly outDir: string },
): Promise<readonly CompiledHookEntry[]> => {
  const compiled = planCompiledHooks(entries, options);
  await buildWithRslib({
    cwd: options.cwd,
    entries: compiled.map((entry) => ({
      name: entry.name,
      outputRelativePath: `hooks/${entry.name}.mjs`,
      source: entry.source,
      virtualSource: wrapperSource(entries.find((candidate) => candidate.hook.id === entry.id)!),
    })),
    outputRoot: options.outDir,
  });
  return compiled;
};
