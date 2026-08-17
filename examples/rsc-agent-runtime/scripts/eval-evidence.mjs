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

const claudeToolUses = (event) => {
  if (event.type !== 'assistant' || !isRecord(event.message) || event.message.role !== 'assistant' || !Array.isArray(event.message.content)) {
    return [];
  }
  return event.message.content.flatMap(
    (content) =>
      isRecord(content) &&
      content.type === 'tool_use' &&
      typeof content.id === 'string' &&
      typeof content.name === 'string' &&
      [content],
  );
};

const successfulClaudeToolResults = (event) => {
  if (event.type !== 'user' || !isRecord(event.message) || event.message.role !== 'user' || !Array.isArray(event.message.content)) {
    return [];
  }
  return event.message.content.flatMap(
    (content) =>
      isRecord(content) &&
      content.type === 'tool_result' &&
      typeof content.tool_use_id === 'string' &&
      content.is_error !== true &&
      [content.tool_use_id],
  );
};

const isRequestedClaudeTool = (name, toolName) => name === toolName || name.endsWith(`__${toolName}`);

const claudeEvidence = (events, marker) => {
  const successfulResults = new Set(events.flatMap(successfulClaudeToolResults));
  const completedToolUses = events.flatMap(claudeToolUses).filter((toolUse) => successfulResults.has(toolUse.id));
  const recentEdits = completedToolUses.filter((toolUse) => isRequestedClaudeTool(toolUse.name, 'recent_edits')).length;
  const renderTimeline = completedToolUses.filter((toolUse) => isRequestedClaudeTool(toolUse.name, 'render_edit_timeline')).length;
  const finalMarkerObserved = events.some(
    (event) => event.type === 'result' && event.is_error === false && markerOnOwnLine(event.result, marker),
  );

  return {
    eventCounts: { hook: 0, json: events.length, mcp: recentEdits, rscRender: renderTimeline },
    finalMarkerObserved,
    mcpReadObserved: recentEdits > 0,
    rscRenderToolObserved: renderTimeline > 0,
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
  const mcpRead = hostAvailable && observed(result, 'editObservedByMcp');
  const rscRender = hostAvailable && observed(result, 'rscRenderToolObserved');
  const sharedHookState = host === 'claude' && hookDispatched && mcpRead;
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
  event.item.server === 'rsc-agent-runtime' &&
  event.item.tool === toolName;

const codexEvidence = (events, marker) => {
  const recentEdits = events.filter((event) => isCodexMcpCall(event, 'recent_edits')).length;
  const renderTimeline = events.filter((event) => isCodexMcpCall(event, 'render_edit_timeline')).length;
  const finalMarkerObserved = events.some(
    (event, index) =>
      event.type === 'item.completed' &&
      isRecord(event.item) &&
      event.item.type === 'agent_message' &&
      markerOnOwnLine(event.item.text, marker) &&
      events[index + 1]?.type === 'turn.completed',
  );

  return {
    eventCounts: { hook: 0, json: events.length, mcp: recentEdits, rscRender: renderTimeline },
    finalMarkerObserved,
    mcpReadObserved: recentEdits > 0,
    rscRenderToolObserved: renderTimeline > 0,
  };
};

/** Parses only known JSONL event discriminants and returns no host-supplied values. */
export const evidenceFromTranscript = (host, transcript) => {
  const events = jsonEvents(transcript);
  const marker = `HOST_EVAL_FINAL host=${host} path=host-created.txt`;
  return host === 'claude' ? claudeEvidence(events, marker) : codexEvidence(events, marker);
};
