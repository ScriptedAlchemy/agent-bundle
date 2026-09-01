import { appendFile } from 'node:fs/promises';

const valueType = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

export const writeEvalProbe = async (input: Record<string, unknown>, exitStatus: number): Promise<void> => {
  const probeFile = process.env.AGENT_RUNTIME_HOOK_PROBE_FILE;
  if (probeFile === undefined || probeFile.trim() === '') return;

  const toolInput = input.tool_input;
  const toolInputRecord = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : undefined;
  const topLevelKeys = Object.keys(input).sort();
  const toolInputKeys = toolInputRecord === undefined ? [] : Object.keys(toolInputRecord).sort();
  await appendFile(probeFile, `${JSON.stringify({
    commandLaunched: true,
    exitStatus,
    toolInputKeys,
    toolInputValueTypes: Object.fromEntries(toolInputKeys.map((key) => [key, valueType(toolInputRecord?.[key])])),
    toolName: typeof input.tool_name === 'string' ? input.tool_name : undefined,
    topLevelKeys,
    topLevelValueTypes: Object.fromEntries(topLevelKeys.map((key) => [key, valueType(input[key])])),
  })}\n`);
};
