const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const jsonEvents = (output) => output.split('\n').flatMap((line) => {
  try {
    const value = JSON.parse(line);
    return isRecord(value) ? [value] : [];
  } catch {
    return [];
  }
});

const markerOnOwnLine = (value, marker) =>
  typeof value === 'string' && value.split(/\r?\n/).some((line) => line.trim() === marker);

const MAX_RESULT_CONTENT_CHARACTERS = 16_384;
const MAX_RESULT_CONTENT_BLOCKS = 20;

const boundedText = (value) => typeof value === 'string' && value.length <= MAX_RESULT_CONTENT_CHARACTERS
  ? value
  : undefined;

const boundedClaudeResultContent = (value) => {
  const text = boundedText(value);
  if (text !== undefined) return text;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RESULT_CONTENT_BLOCKS) return undefined;
  const blocks = [];
  let length = 0;
  for (const block of value) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return undefined;
    length += block.text.length + (blocks.length === 0 ? 0 : 1);
    if (length > MAX_RESULT_CONTENT_CHARACTERS) return undefined;
    blocks.push(block.text);
  }
  return blocks.join('\n');
};

const claudeToolUses = (event) => {
  if (event.type !== 'assistant' || !isRecord(event.message) || event.message.role !== 'assistant' || !Array.isArray(event.message.content)) {
    return [];
  }
  return event.message.content.flatMap((content) =>
    isRecord(content) &&
    content.type === 'tool_use' &&
    typeof content.id === 'string' &&
    typeof content.name === 'string'
      ? [content]
      : [],
  );
};

const claudeToolResults = (event) => {
  if (event.type !== 'user' || !isRecord(event.message) || event.message.role !== 'user' || !Array.isArray(event.message.content)) {
    return [];
  }
  return event.message.content.flatMap((content) =>
    isRecord(content) &&
    content.type === 'tool_result' &&
    typeof content.tool_use_id === 'string'
      ? [{
        content: content.is_error === true ? undefined : boundedClaudeResultContent(content.content),
        id: content.tool_use_id,
        succeeded: content.is_error !== true,
      }]
      : [],
  );
};

const claudeRuntimeToolName = (toolName) => `mcp__rsc-agent-runtime__${toolName}`;

const completedClaudeToolUses = (events) => {
  const uses = events.flatMap(claudeToolUses);
  const useCounts = new Map();
  for (const toolUse of uses) useCounts.set(toolUse.id, (useCounts.get(toolUse.id) ?? 0) + 1);

  const results = new Map();
  const duplicateResults = new Set();
  for (const result of events.flatMap(claudeToolResults)) {
    if (results.has(result.id)) duplicateResults.add(result.id);
    else results.set(result.id, result);
  }

  return uses.flatMap((toolUse) => {
    const result = results.get(toolUse.id);
    if (useCounts.get(toolUse.id) !== 1 || duplicateResults.has(toolUse.id) || result?.succeeded !== true || result.content === undefined) {
      return [];
    }
    return [{ content: result.content, toolUse }];
  });
};

const stateHasMarker = (host, records, marker) =>
  typeof marker === 'string' && marker.length > 0 && Array.isArray(records) && records.some((record) =>
    isRecord(record) &&
    record.kind === 'edit' &&
    isRecord(record.event) &&
    record.event.host === host &&
    typeof record.event.path === 'string' &&
    record.event.path.includes(marker));

const claudeEvidence = (events, marker, finalMarker) => {
  const completed = completedClaudeToolUses(events);
  const recentEdits = completed.filter(({ toolUse }) => toolUse.name === claudeRuntimeToolName('recent_edits'));
  const renderTimeline = completed.filter(({ toolUse }) => toolUse.name === claudeRuntimeToolName('render_edit_timeline'));
  const finalMarkerObserved = events.some(
    (event) => event.type === 'result' && event.is_error === false && markerOnOwnLine(event.result, finalMarker),
  );

  return {
    eventCounts: { hook: 0, json: events.length, mcp: recentEdits.length, rscRender: renderTimeline.length },
    finalMarkerObserved,
    mcpReadMarkerObserved: typeof marker === 'string' && recentEdits.some(({ content }) => content.includes(marker)),
    mcpReadObserved: recentEdits.length > 0,
    rscRenderToolObserved: renderTimeline.length > 0,
  };
};

const distinct = (values) => [...new Set(values)].sort();

const terminalHostCanRenderIframe = false;
const evidence = (condition, observedBasis, unavailableBasis) => ({
  basis: condition ? observedBasis : unavailableBasis,
  evidence: condition ? 'observed' : 'unavailable',
});

const observed = (result, key) => isRecord(result) && result[key] === true;

/** Converts bounded native-run observations into explicit, non-browser host claims. */
export const classifyNativeEvidence = (host, result, { capturedAt }) => {
  const hostAvailable = isRecord(result) && typeof result.version === 'string';
  const unavailableBasis = hostAvailable ? 'selected native run did not produce the required evidence' : 'installed host/version/session unavailable';
  const packageActivated = hostAvailable && observed(result, 'sessionAvailable') && observed(result, 'finalMarkerObserved');
  const hookDispatched = host === 'claude' && hostAvailable && observed(result, 'editObservedByHook');
  const mcpRead = hostAvailable && observed(result, 'mcpReadObserved');
  const rscRender = hostAvailable && observed(result, 'rscRenderToolObserved');
  const sharedHookState = host === 'claude' && hookDispatched && observed(result, 'sharedHookStateObserved');
  const iframeBasis = host === 'claude'
    ? 'Claude Code CLI is not an MCP Apps iframe host'
    : 'Codex CLI is not an MCP Apps iframe host';

  return {
    capturedAt,
    claims: [
      { id: 'package-activation', ...evidence(packageActivated, 'native terminal marker and loaded plugin session', unavailableBasis) },
      {
        id: 'hook-dispatch',
        ...evidence(
          hookDispatched,
          'value-free hook launch probe exited 0',
          host === 'codex' && hostAvailable ? 'Codex exec --ephemeral does not prove native hook dispatch' : unavailableBasis,
        ),
      },
      { id: 'mcp-read', ...evidence(mcpRead, 'completed recent_edits call with native success result', unavailableBasis) },
      { id: 'rsc-render', ...evidence(rscRender, 'completed render_edit_timeline call with native success result', unavailableBasis) },
      {
        id: 'shared-hook-mcp-state',
        ...evidence(
          sharedHookState,
          'hook-recorded state was returned by recent_edits',
          host === 'codex' && hostAvailable ? 'Codex exec --ephemeral has no native hook-recorded state correlation' : unavailableBasis,
        ),
      },
      { id: 'mcp-app-iframe', ...evidence(terminalHostCanRenderIframe, 'terminal host iframe rendering is not supported', iframeBasis) },
    ],
    host,
    hostVersion: hostAvailable ? result.version : 'unavailable',
  };
};

/** Reduces hook probe records to key/type/exit-status evidence without returning input values. */
export const summarizeHookProbe = (records) => {
  const probeRecords = Array.isArray(records) ? records.filter(isRecord) : [];
  return {
    commandLaunched: probeRecords.some((record) => record.commandLaunched === true),
    exitStatuses: distinct(probeRecords.map((record) => record.exitStatus).filter((value) => Number.isInteger(value))),
    launches: probeRecords.filter((record) => record.commandLaunched === true).length,
    toolInputKeySets: distinct(probeRecords.map((record) => JSON.stringify(record.toolInputKeys ?? []))),
    toolNames: distinct(probeRecords.map((record) => record.toolName).filter((value) => typeof value === 'string')),
    topLevelKeySets: distinct(probeRecords.map((record) => JSON.stringify(record.topLevelKeys ?? []))),
    valueTypeSets: distinct(probeRecords.map((record) => JSON.stringify({
      toolInput: record.toolInputValueTypes ?? {},
      topLevel: record.topLevelValueTypes ?? {},
    }))),
  };
};

export const hookEvidenceFromProbe = (summary) =>
  isRecord(summary) && summary.commandLaunched === true && Array.isArray(summary.exitStatuses) && summary.exitStatuses.includes(0);

const isCodexMcpCall = (event, toolName) =>
  event.type === 'item.completed' &&
  isRecord(event.item) &&
  event.item.type === 'mcp_tool_call' &&
  event.item.status === 'completed' &&
  event.item.is_error !== true &&
  !(isRecord(event.item.result) && event.item.result.is_error === true) &&
  event.item.server === 'rsc-agent-runtime' &&
  event.item.tool === toolName;

const codexEvidence = (events, finalMarker) => {
  const recentEdits = events.filter((event) => isCodexMcpCall(event, 'recent_edits')).length;
  const renderTimeline = events.filter((event) => isCodexMcpCall(event, 'render_edit_timeline')).length;
  const finalMarkerObserved = events.some(
    (event, index) =>
      event.type === 'item.completed' &&
      isRecord(event.item) &&
      event.item.type === 'agent_message' &&
      markerOnOwnLine(event.item.text, finalMarker) &&
      events[index + 1]?.type === 'turn.completed',
  );

  return {
    eventCounts: { hook: 0, json: events.length, mcp: recentEdits, rscRender: renderTimeline },
    finalMarkerObserved,
    mcpReadMarkerObserved: false,
    mcpReadObserved: recentEdits > 0,
    rscRenderToolObserved: renderTimeline > 0,
  };
};

/** Parses only known JSONL event discriminants and returns no host-supplied values. */
export const evidenceFromTranscript = (host, transcript, correlation = {}) => {
  const events = jsonEvents(transcript);
  const safeCorrelation = isRecord(correlation) ? correlation : {};
  const finalMarker = typeof safeCorrelation.finalMarker === 'string'
    ? safeCorrelation.finalMarker
    : `HOST_EVAL_FINAL host=${host} path=host-created.txt`;
  const evidence = host === 'claude'
    ? claudeEvidence(events, safeCorrelation.marker, finalMarker)
    : codexEvidence(events, finalMarker);
  return {
    ...evidence,
    sharedHookStateObserved: host === 'claude' && evidence.mcpReadMarkerObserved && stateHasMarker(host, safeCorrelation.stateRecords, safeCorrelation.marker),
    stateMarkerObserved: stateHasMarker(host, safeCorrelation.stateRecords, safeCorrelation.marker),
  };
};
