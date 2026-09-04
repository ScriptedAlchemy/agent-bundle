// A scripted Anthropic Messages API stand-in so a REAL Claude Code process can
// drive the host-test scenario without an account: Claude Code is the host under
// test; only the model is scripted (root: pwd, write, dump, probe, one Agent;
// subagent: pwd, dump, probe, one nested Agent; nested: pwd, probe). Used by
// `probe.mjs capture claude --scripted-model`; standalone usage:
//   node mock-anthropic.mjs <port> [logfile]
// then run claude with ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=mock.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8790);
const logFile = process.argv[3];
const log = (line) => { if (logFile) appendFileSync(logFile, `${line}\n`); };

const readBody = (request) => new Promise((resolve) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => resolve(body));
});

const textOf = (content) => typeof content === 'string'
  ? content
  : (content ?? []).map((block) => block.type === 'text' ? block.text : block.type === 'tool_result' ? JSON.stringify(block.content ?? '') : '').join('\n');

const role = (messages) => {
  const content = messages[0]?.content ?? '';
  const blocks = typeof content === 'string' ? [content] : content.filter((block) => block.type === 'text').map((block) => block.text);
  if (blocks.some((text) => text.trimStart().startsWith('NESTED_PROBE_SCENARIO'))) return 'nested';
  if (blocks.some((text) => text.trimStart().startsWith('SUBAGENT_PROBE_SCENARIO'))) return 'subagent';
  if (blocks.some((text) => text.includes('exercising the host-test probe'))) return 'root';
  return 'other';
};

const toolUseCount = (messages) => messages
  .filter((message) => message.role === 'assistant' && Array.isArray(message.content))
  .reduce((count, message) => count + message.content.filter((block) => block.type === 'tool_use').length, 0);

const findTool = (tools, matcher) => tools.find((tool) => matcher(tool.name))?.name;

const scriptFor = (kind, tools) => {
  const bash = findTool(tools, (name) => name === 'Bash');
  const write = findTool(tools, (name) => name === 'Write');
  const dump = findTool(tools, (name) => /host-test__dump$/u.test(name));
  const probe = findTool(tools, (name) => /host-test-raw__probe$/u.test(name));
  const task = findTool(tools, (name) => name === 'Task' || name === 'Agent');
  const step = (name, input) => name === undefined ? undefined : { input, name };
  switch (kind) {
    case 'root':
      return [
        step(bash, { command: 'pwd' }),
        step(write, { content: 'host-test\n', file_path: `${process.env.PROBE_WORKSPACE ?? process.cwd()}/probe-note.txt` }),
        step(dump, {}),
        step(probe, { note: 'root' }),
        step(task, {
          description: 'host-test subagent probe',
          prompt: 'SUBAGENT_PROBE_SCENARIO: run `pwd`, call the host-test dump tool with {}, call the host-test-raw probe tool with {"note":"subagent"}, spawn a nested subagent with NESTED_PROBE_SCENARIO if you can, then reply with every id you saw.',
          subagent_type: 'general-purpose',
        }),
      ].filter(Boolean);
    case 'subagent':
      return [
        step(bash, { command: 'pwd' }),
        step(dump, {}),
        step(probe, { note: 'subagent' }),
        step(task, {
          description: 'nested host-test probe',
          prompt: 'NESTED_PROBE_SCENARIO: run `pwd`, call the host-test-raw probe tool with {"note":"nested"}, then reply with every id you saw.',
          subagent_type: 'general-purpose',
        }),
      ].filter(Boolean);
    case 'nested':
      return [
        step(bash, { command: 'pwd' }),
        step(probe, { note: 'nested' }),
      ].filter(Boolean);
    default:
      return [];
  }
};

const finalText = (kind) => {
  switch (kind) {
    case 'root': return 'HOST_TEST_DONE (mock model; see the probe log path in the dump result)';
    case 'subagent': return 'SUBAGENT_DONE: reported every id from the dump and probe results above.';
    case 'nested': return 'NESTED_DONE: reported every id from the probe result above.';
    default: return 'ok';
  }
};

const sse = (response, event, data) => {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

let messageCounter = 0;

const respond = (response, body, stream) => {
  const messages = body.messages ?? [];
  const kind = role(messages);
  const tools = body.tools ?? [];
  const script = scriptFor(kind, tools);
  const index = toolUseCount(messages);
  const next = script[index];
  const id = `msg_mock_${String(++messageCounter).padStart(4, '0')}`;
  log(JSON.stringify({ kind, model: body.model, step: index, tool: next?.name ?? 'text', toolCount: tools.length, toolNames: tools.map((tool) => tool.name).filter((name) => /host-test|Task|Agent|Bash|Write/u.test(name)), ...(kind === 'other' ? { first: JSON.stringify(messages[0]?.content).slice(0, 600), system: JSON.stringify(body.system).slice(0, 300) } : {}) }));
  const content = next === undefined
    ? [{ text: finalText(kind), type: 'text' }]
    : [{ id: `toolu_mock_${String(messageCounter)}`, input: next.input, name: next.name, type: 'tool_use' }];
  const stopReason = next === undefined ? 'end_turn' : 'tool_use';
  const message = {
    content,
    id,
    model: body.model,
    role: 'assistant',
    stop_reason: stopReason,
    stop_sequence: null,
    type: 'message',
    usage: { input_tokens: 10, output_tokens: 10 },
  };
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
  sse(response, 'message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } }, type: 'message_start' });
  const block = content[0];
  if (block.type === 'text') {
    sse(response, 'content_block_start', { content_block: { text: '', type: 'text' }, index: 0, type: 'content_block_start' });
    sse(response, 'content_block_delta', { delta: { text: block.text, type: 'text_delta' }, index: 0, type: 'content_block_delta' });
  } else {
    sse(response, 'content_block_start', { content_block: { id: block.id, input: {}, name: block.name, type: 'tool_use' }, index: 0, type: 'content_block_start' });
    sse(response, 'content_block_delta', { delta: { partial_json: JSON.stringify(block.input), type: 'input_json_delta' }, index: 0, type: 'content_block_delta' });
  }
  sse(response, 'content_block_stop', { index: 0, type: 'content_block_stop' });
  sse(response, 'message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, type: 'message_delta', usage: { output_tokens: 10 } });
  sse(response, 'message_stop', { type: 'message_stop' });
  response.end();
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const raw = await readBody(request);
  if (url.pathname.endsWith('/messages/count_tokens')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  if (url.pathname.endsWith('/v1/messages')) {
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }
    respond(response, body, body.stream === true);
    return;
  }
  log(JSON.stringify({ other: `${request.method} ${url.pathname}` }));
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: `mock: no route for ${url.pathname}`, type: 'not_found_error' }, type: 'error' }));
}).listen(port, '127.0.0.1', () => {
  console.log(`mock anthropic listening on http://127.0.0.1:${String(port)}`);
});
