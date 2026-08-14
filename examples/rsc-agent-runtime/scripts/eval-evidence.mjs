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

const isClaudeToolUse = (event, toolName) =>
  event.type === 'assistant' &&
  isRecord(event.message) &&
  event.message.role === 'assistant' &&
  Array.isArray(event.message.content) &&
  event.message.content.some(
    (content) =>
      isRecord(content) &&
      content.type === 'tool_use' &&
      typeof content.name === 'string' &&
      (content.name === toolName || content.name.endsWith(`__${toolName}`)),
  );

const claudeEvidence = (events, marker) => {
  const recentEdits = events.filter((event) => isClaudeToolUse(event, 'recent_edits')).length;
  const renderTimeline = events.filter((event) => isClaudeToolUse(event, 'render_edit_timeline')).length;
  const hookEvents = events.filter(
    (event) => event.type === 'system' && event.subtype === 'hook_callback' && event.hook_event_name === 'PostToolUse',
  ).length;
  const finalMarkerObserved = events.some(
    (event) => event.type === 'result' && event.is_error === false && markerOnOwnLine(event.result, marker),
  );

  return {
    eventCounts: { hook: hookEvents, json: events.length, mcp: recentEdits, rscRender: renderTimeline },
    finalMarkerObserved,
    mcpReadObserved: recentEdits > 0,
    rscRenderToolObserved: renderTimeline > 0,
  };
};

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
