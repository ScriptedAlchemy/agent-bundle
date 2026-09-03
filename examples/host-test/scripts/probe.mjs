#!/usr/bin/env node
// Scripted probe lifecycle: install the built host-test artifact into an
// ISOLATED host home, drive one capture session, copy the log out, and
// uninstall. Nothing here touches the real ~/.claude, ~/.codex, or ~/.cursor.
//
//   node scripts/probe.mjs install   <claude|codex|cursor> [--no-auth] [--root <dir>]
//   node scripts/probe.mjs capture   <claude|codex|cursor> [--prompt <text> | --scenario <file.json> | --scripted-model] [--model <m>] [--timeout <ms>]
//   node scripts/probe.mjs uninstall <claude|codex|cursor> [--keep-home]
//   node scripts/probe.mjs status    <claude|codex|cursor>
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOSTS = ['claude', 'codex', 'cursor'];
const PLUGIN = 'host-test';
const MARKETPLACE = 'host-test-marketplace';

const parseArgs = (argv) => {
  const [command, host, ...rest] = argv;
  const flags = { auth: true, keepHome: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    // A value flag with nothing after it must not fall back to the default
    // silently: `--scenario` at the end would run the default scenario under
    // the requested one's name. Only absence is rejected — the next argument
    // is the value whatever it looks like, so `--prompt "--help"` or a file
    // named `--baseline.json` still work.
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--no-auth': flags.auth = false; break;
      case '--keep-home': flags.keepHome = true; break;
      case '--root': flags.root = value(); break;
      case '--prompt': flags.prompt = value(); break;
      case '--scenario': flags.scenario = value(); break;
      case '--model': flags.model = value(); break;
      case '--timeout': {
        flags.timeout = Number(value());
        if (!Number.isFinite(flags.timeout) || flags.timeout <= 0) throw new Error('--timeout needs a positive number of milliseconds');
        break;
      }
      case '--scripted-model': flags.scriptedModel = true; break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  return { command, flags, host };
};

const { command, flags, host } = parseArgs(process.argv.slice(2));
if (!['install', 'capture', 'uninstall', 'status'].includes(command) || !HOSTS.includes(host)) {
  console.error('usage: probe.mjs <install|capture|uninstall|status> <claude|codex|cursor> [flags]');
  process.exit(2);
}

const root = resolve(flags.root ?? process.env.HOST_TEST_ROOT ?? '/tmp/host-test');
const paths = {
  artifact: join(exampleRoot, 'artifact', host),
  captures: join(root, host),
  home: join(root, `${host}-home`),
  logDir: join(root, host, 'log'),
  workspace: join(root, `${host}-workspace`),
};
const realHome = homedir();

/**
 * Ambient credentials never reach a host that runs with permission bypasses;
 * the hosts authenticate from the copied sign-in files. The host environment
 * is therefore built from an allowlist of process/locale/display plumbing, and
 * even allowlisted values are dropped when they carry a credential (a proxy URL
 * with userinfo, a bearer token, a key=value assignment with a secret name).
 */
const HOST_ENVIRONMENT_ALLOWLIST = new Set([
  'PATH', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS',
  'CI', 'NO_COLOR', 'FORCE_COLOR', 'HOST_TEST_ROOT',
]);
const CREDENTIAL_BEARING_VALUE = /(?:\/\/[^/\s:@]+:[^/\s@]+@|\b(?:bearer|basic)\s+[\w\-.=+/]{8,}|(?:^|[;&\s])(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)=[^;&\s]+|\bsk-[\w-]{16,}|\bghp_[\w]{20,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/iu;
const allowlistedEnvironment = (base) => Object.fromEntries(
  Object.entries(base).filter(([name, value]) =>
    HOST_ENVIRONMENT_ALLOWLIST.has(name) && typeof value === 'string' && !CREDENTIAL_BEARING_VALUE.test(value)),
);

/** The isolated environment every host command runs with. HOME moves; auth is copied opaquely; nothing else from the shell survives. */
const isolatedEnvironment = () => {
  const environment = { ...allowlistedEnvironment(process.env), HOME: paths.home, HOST_TEST_LOG_DIR: paths.logDir };
  switch (host) {
    case 'claude':
      environment.CLAUDE_CONFIG_DIR = join(paths.home, '.claude');
      break;
    case 'codex':
      environment.CODEX_HOME = join(paths.home, '.codex');
      break;
    case 'cursor':
      // Cursor reads ~/.cursor from HOME; the IDE additionally needs its own
      // --user-data-dir so the real profile is never opened.
      break;
    default:
      throw new Error(`unreachable host ${host}`);
  }
  return environment;
};

const run = (commandName, args, options = {}) => {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd ?? exampleRoot,
    encoding: 'utf8',
    env: options.env ?? isolatedEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  return result;
};

const log = (message) => console.log(`[probe:${host}] ${message}`);

const copyOpaque = (source, destination, label) => {
  if (!existsSync(source)) {
    log(`no ${label} at ${source}; the isolated home will be unauthenticated`);
    return false;
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const mode = statSync(source).mode & 0o777;
  writeFileSync(destination, readFileSync(destination), { mode });
  log(`copied ${label} byte-for-byte into the isolated home (never read as data)`);
  return true;
};

/** Copies only the `cursorAuth/*` rows; every other profile row stays behind. */
const transplantCursorAuth = (source, destination) => {
  if (!existsSync(source)) {
    log(`no Cursor profile store at ${source}; the isolated IDE will be signed out`);
    return;
  }
  const from = new DatabaseSync(`file:${source}?mode=ro`, { open: true, readOnly: true });
  const rows = from.prepare("select key, value from ItemTable where key like 'cursorAuth/%'").all();
  from.close();
  const to = new DatabaseSync(destination);
  to.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const insert = to.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
  for (const row of rows) insert.run(row.key, row.value);
  to.close();
  log(`transplanted ${rows.length} Cursor sign-in row(s) into the isolated profile (values never read as data)`);
};

const ensureArtifact = () => {
  if (!existsSync(join(paths.artifact, 'INSTALL.md'))) {
    log('artifact missing; running pnpm build');
    const built = run('pnpm', ['build'], { env: process.env, inherit: true });
    if (built.status !== 0) throw new Error('pnpm build failed');
  }
};

const install = () => {
  ensureArtifact();
  mkdirSync(paths.home, { mode: 0o700, recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });
  if (!existsSync(join(paths.workspace, '.git'))) {
    run('git', ['init', '-q', '-b', 'probe-main', paths.workspace], { env: process.env });
    writeFileSync(join(paths.workspace, 'README.md'), '# host-test probe workspace\n');
    run('git', ['-C', paths.workspace, 'add', '.'], { env: process.env });
    run('git', ['-C', paths.workspace, '-c', 'user.email=probe@host-test', '-c', 'user.name=probe', 'commit', '-q', '-m', 'probe workspace'], { env: process.env });
  }
  switch (host) {
    case 'claude': {
      const config = join(paths.home, '.claude');
      mkdirSync(config, { recursive: true });
      if (flags.auth) copyOpaque(join(realHome, '.claude', '.credentials.json'), join(config, '.credentials.json'), 'Claude credentials');
      // Claude keeps onboarding + trust state in ~/.claude.json; seed the
      // minimum so a non-interactive turn never blocks on first-run prompts.
      writeFileSync(join(paths.home, '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { [paths.workspace]: { hasTrustDialogAccepted: true } },
      }, null, 2));
      break;
    }
    case 'codex': {
      const codexHome = join(paths.home, '.codex');
      mkdirSync(codexHome, { recursive: true });
      if (flags.auth) copyOpaque(join(realHome, '.codex', 'auth.json'), join(codexHome, 'auth.json'), 'Codex auth.json');
      // Codex 0.147 gates subagents behind the multi-agent features; hooks
      // from an installed plugin additionally need trust, which probe:capture
      // bypasses per invocation with --dangerously-bypass-hook-trust.
      writeFileSync(join(codexHome, 'config.toml'), [
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        'suppress_unstable_features_warning = true',
        '',
        '[agents]',
        'enabled = true',
        'max_depth = 3',
        '',
        '[features]',
        'multi_agent = true',
        '',
        '[features.multi_agent_v2]',
        'enabled = true',
        '',
      ].join('\n'));
      break;
    }
    case 'cursor': {
      mkdirSync(join(paths.home, '.cursor'), { recursive: true });
      // The IDE needs its own profile so the real one is never opened; the
      // agent pane needs a signed-in account, so the sign-in rows are copied
      // out of the real profile store into the empty isolated one.
      const userDir = join(paths.home, '.config', 'Cursor', 'User');
      mkdirSync(join(userDir, 'globalStorage'), { recursive: true });
      writeFileSync(join(userDir, 'settings.json'), JSON.stringify({
        'security.workspace.trust.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'window.restoreWindows': 'none',
      }, null, 2));
      if (flags.auth) transplantCursorAuth(join(realHome, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), join(userDir, 'globalStorage', 'state.vscdb'));
      break;
    }
    default:
      throw new Error(`unreachable host ${host}`);
  }
  const result = run('pnpm', ['exec', 'agent-bundle', 'install', host, '--from', paths.artifact, '--json']);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`agent-bundle install ${host} failed with ${result.status}`);
  log(`installed into isolated home ${paths.home}`);
  log(`capture log directory: ${paths.logDir}`);
  if (host === 'cursor') {
    log('launch the isolated IDE with (add DISPLAY=:<n> under Xvfb; --remote-debugging-port enables CDP driving):');
    log(`  HOME=${paths.home} HOST_TEST_LOG_DIR=${paths.logDir} cursor --no-sandbox --disable-gpu --user-data-dir ${join(paths.home, '.config', 'Cursor')} --extensions-dir ${join(paths.home, '.cursor', 'extensions')} --skip-release-notes --disable-workspace-trust --remote-debugging-port=9334 ${paths.workspace}`);
  }
};

const scenarioPrompt = () => flags.prompt ?? [
  'You are exercising the host-test probe plugin. Do exactly these steps in order, without asking questions.',
  '1. Run the shell command `pwd`.',
  '2. Create a file named probe-note.txt in the current directory containing the single line `host-test`.',
  '3. Call the `dump` tool of the host-test MCP server with an empty object as arguments and remember its `log.path`.',
  '4. Call the `probe` tool of the host-test-raw MCP server with {"note":"root"}.',
  '5. If you have a subagent or Task tool, spawn exactly one subagent with these instructions: "Run the shell command `pwd`, call the host-test `dump` tool with {}, call the host-test-raw `probe` tool with {\\"note\\":\\"subagent\\"}, then if you can spawn a nested subagent do so with the instruction to run `pwd` and call `probe` with {\\"note\\":\\"nested\\"}, and finally reply with every id you saw." If you have no subagent tool, say so.',
  '6. Reply with exactly one final line: HOST_TEST_DONE <the log.path from step 3>',
].join('\n');

/**
 * The ordered prompts of one capture session. `--prompt` is a one-turn
 * scenario; `--scenario <file.json>` is `{ "turns": ["...", ...] }` (a turn may
 * also be `{ "prompt": "..." }`), every turn after the first resuming the same
 * host session so turn boundaries show up in the hook stream.
 */
const scenarioTurns = () => {
  if (flags.scenario === undefined) return [scenarioPrompt()];
  // Both flags name the prompts of the run; honouring one and dropping the
  // other would capture a different experiment than the caller asked for.
  if (flags.prompt !== undefined) throw new Error('--prompt and --scenario both supply the prompts: pass one of them');
  const file = resolve(flags.scenario);
  const scenario = JSON.parse(readFileSync(file, 'utf8'));
  const turns = Array.isArray(scenario) ? scenario : scenario?.turns;
  if (!Array.isArray(turns) || turns.length === 0) throw new Error(`${file}: expected {"turns": [<prompt>, ...]} with at least one turn`);
  return turns.map((turn, index) => {
    const prompt = typeof turn === 'string' ? turn : turn?.prompt;
    if (typeof prompt !== 'string' || prompt.length === 0) throw new Error(`${file}: turn ${String(index + 1)} has no prompt`);
    return prompt;
  });
};

const parseStream = (stdout) => stdout.split('\n').filter(Boolean).flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});

/** One line per turn about what the model's own stream shows: tool calls by name, and how many envelopes came from inside a subagent. */
const describeStream = (envelopes) => {
  const toolUses = new Map();
  let fromSubagents = 0;
  for (const envelope of envelopes) {
    if (envelope.parent_tool_use_id) fromSubagents += 1;
    if (envelope.type !== 'assistant') continue;
    for (const block of envelope.message?.content ?? []) {
      if (block.type === 'tool_use') toolUses.set(block.name, (toolUses.get(block.name) ?? 0) + 1);
    }
  }
  const result = envelopes.find((envelope) => envelope.type === 'result');
  const tools = [...toolUses].map(([name, count]) => `${name}×${String(count)}`).join(' ');
  return `${String(envelopes.length)} stream envelope(s), ${String(fromSubagents)} from inside subagents (parent_tool_use_id set); result ${result?.subtype ?? 'missing'} after ${String(result?.num_turns ?? '?')} model turn(s); tool_use: ${tools || 'none'}`;
};

/**
 * With --scripted-model the real Claude Code binary talks to a local scripted
 * Messages API (scripts/mock-anthropic.mjs) instead of Anthropic, so the hook,
 * MCP, and subagent plumbing under test is the host's own while no account is
 * needed; the model text in the transcript is then not evidence of anything.
 *
 * Every turn runs `claude -p --output-format stream-json --verbose`, so the
 * model's tool-use stream (with `parent_tool_use_id` on envelopes produced
 * inside a subagent) is captured next to the hook payloads; turns after the
 * first `--resume` the session id the first turn's `system/init` envelope
 * reported.
 */
const captureClaude = () => {
  const scripted = flags.scriptedModel === true;
  // The scripted model answers one canned transcript; it cannot follow a
  // scenario, so refuse the combination instead of silently running the
  // canned turn under the scenario's name.
  if (scripted && (flags.scenario !== undefined || flags.prompt !== undefined)) {
    throw new Error('--scripted-model plays a fixed transcript and ignores prompts: drop --scenario/--prompt, or run the scenario against the real model');
  }
  const turns = scripted ? ['You are exercising the host-test probe plugin. Do the scripted steps.'] : scenarioTurns();
  const baseArgs = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model', flags.model ?? (scripted ? 'claude-sonnet-4-5' : 'sonnet'),
  ];
  const port = 8790 + Math.floor(Math.random() * 100);
  const mock = scripted
    ? spawn(process.execPath, [join(exampleRoot, 'scripts', 'mock-anthropic.mjs'), String(port), join(paths.captures, 'scripted-model.log')], { stdio: 'ignore' })
    : undefined;
  const environment = {
    ...isolatedEnvironment(),
    ...(scripted
      ? {
          ANTHROPIC_API_KEY: 'scripted-model',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(port)}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          PROBE_WORKSPACE: paths.workspace,
        }
      : {}),
  };
  log(`claude -p <prompt> ${baseArgs.join(' ')}${scripted ? ` (scripted model on 127.0.0.1:${String(port)})` : ''}; ${String(turns.length)} turn(s)`);
  const results = [];
  let sessionId;
  try {
    if (mock !== undefined) spawnSync(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 800)']);
    for (const [index, prompt] of turns.entries()) {
      const args = ['-p', prompt, ...baseArgs, ...(sessionId === undefined ? [] : ['--resume', sessionId])];
      // A timeout or spawn error on a later turn must not discard the turns
      // already captured: record it as a failed turn and let `capture()`
      // write the partial evidence and exit non-zero.
      const spawned = spawnSync('claude', args, { cwd: paths.workspace, encoding: 'utf8', env: environment, maxBuffer: 64 * 1024 * 1024, timeout: flags.timeout ?? 900_000 });
      if (spawned.error) {
        log(`turn ${String(index + 1)}/${String(turns.length)}: ${spawned.error.message}`);
        results.push({ ...spawned, failure: `turn ${String(index + 1)} did not finish: ${spawned.error.message}`, status: spawned.status ?? null, stdoutExtension: 'stream.ndjson' });
        break;
      }
      const result = spawned;
      const envelopes = parseStream(result.stdout ?? '');
      sessionId ??= envelopes.find((envelope) => typeof envelope.session_id === 'string')?.session_id;
      log(`turn ${String(index + 1)}/${String(turns.length)}: exit ${String(result.status)}, session ${sessionId ?? 'unknown'}; ${describeStream(envelopes)}`);
      if (result.status === 0 && sessionId === undefined && index + 1 < turns.length) {
        // A multi-turn scenario without a session to resume is not the
        // scenario: fail the turn so `capture()` refuses the partial run.
        results.push({ ...result, failure: 'the first turn reported no session_id, so the remaining turns cannot resume it', stdoutExtension: 'stream.ndjson' });
        break;
      }
      results.push({ ...result, stdoutExtension: 'stream.ndjson' });
      if (result.status !== 0) break;
    }
  } finally {
    mock?.kill();
  }
  return results;
};

/** Multi-turn scenarios are only wired for Claude (`--resume`); the other drivers take the one prompt. */
const singleTurnPrompt = () => {
  const turns = scenarioTurns();
  if (turns.length > 1) throw new Error(`${host}: probe:capture drives one turn per session for this host; --scenario turns beyond the first are only wired for claude`);
  return turns[0];
};

const captureCodex = () => {
  const prompt = singleTurnPrompt();
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '--dangerously-bypass-hook-trust',
    '--json',
    '-C', paths.workspace,
    ...(flags.model === undefined ? [] : ['--model', flags.model]),
    prompt,
  ];
  log(`codex ${args.slice(0, -1).join(' ')} "<prompt>"`);
  return [{ ...run('codex', args, { cwd: paths.workspace, timeout: flags.timeout ?? 900_000 }), stdoutExtension: 'stdout.ndjson' }];
};

const captureCursor = () => {
  const args = [
    '-p', singleTurnPrompt(),
    '--output-format', 'json',
    '--force',
    ...(flags.model === undefined ? [] : ['--model', flags.model]),
  ];
  log(`cursor-agent ${args.slice(2).join(' ')} (IDE sessions are driven manually; see probe:install output)`);
  return [{ ...run('cursor-agent', args, { cwd: paths.workspace, timeout: flags.timeout ?? 900_000 }), stdoutExtension: 'stdout.json' }];
};

const capture = () => {
  if (!existsSync(paths.home)) throw new Error(`isolated home ${paths.home} missing; run probe:install ${host} first`);
  mkdirSync(paths.captures, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  // Only records appended by THIS run count as evidence: remember where the
  // live log ends before the host starts.
  const logFile = join(paths.logDir, 'captures.ndjson');
  const startOffset = existsSync(logFile) ? statSync(logFile).size : 0;
  let turns;
  switch (host) {
    case 'claude': turns = captureClaude(); break;
    case 'codex': turns = captureCodex(); break;
    case 'cursor': turns = captureCursor(); break;
    default: throw new Error(`unreachable host ${host}`);
  }
  for (const [index, turn] of turns.entries()) {
    const name = turns.length === 1 ? `session-${stamp}` : `session-${stamp}.turn-${String(index + 1)}`;
    writeFileSync(join(paths.captures, `${name}.${turn.stdoutExtension}`), turn.stdout ?? '');
    writeFileSync(join(paths.captures, `${name}.stderr.txt`), turn.stderr ?? '');
  }
  // The session failed if any turn did, or if the driver could not run the
  // whole scenario (`failure`).
  const result = turns.find((turn) => turn.status !== 0 || turn.failure !== undefined) ?? turns[turns.length - 1];
  const failed = result.status !== 0 || result.failure !== undefined;
  log(`host exit ${String(result.status)} over ${String(turns.length)} turn(s); transcript at ${join(paths.captures, `session-${stamp}.*`)}`);
  const appended = existsSync(logFile) ? readFileSync(logFile).subarray(startOffset).toString('utf8') : '';
  const records = appended.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const kinds = new Set(records.map((record) => record.kind));
  if (records.length > 0) {
    const copy = join(paths.captures, `captures-${stamp}.ndjson`);
    writeFileSync(copy, appended.endsWith('\n') ? appended : `${appended}\n`);
    log(`copied ${String(records.length)} capture record(s) from this run to ${copy}${startOffset > 0 ? ` (${String(startOffset)} bytes of earlier runs left behind)` : ''}`);
    const dump = run(process.execPath, [join(exampleRoot, 'dist', 'bin', 'host-test.js'), 'dump', '--log', copy], { env: process.env });
    process.stdout.write(dump.stdout);
    process.stderr.write(dump.stderr);
  } else {
    log(`no capture record was appended to ${logFile} by this run: the host dispatched no hook and no MCP call reached the probe`);
  }
  // The artifacts above are kept for inspection, but neither a failed host
  // session nor a session that produced no hook AND no MCP evidence is a
  // capture: automation must see the failure.
  const missing = ['event', 'mcp'].filter((kind) => !kinds.has(kind));
  if (failed) {
    log(`host session failed (${result.failure ?? `exit ${String(result.status)}`}); captures above are partial evidence at best`);
    process.exitCode = result.status === 0 || result.status === null ? 1 : result.status;
  } else if (missing.length > 0) {
    log(`host session exited 0 but produced no ${missing.join(' and no ')} record; the scenario requires both`);
    process.exitCode = 1;
  }
};

const uninstall = () => {
  if (!existsSync(paths.home)) {
    log(`isolated home ${paths.home} is already gone`);
    return;
  }
  const attempt = (commandName, args) => {
    const result = run(commandName, args);
    log(`${commandName} ${args.join(' ')} -> exit ${result.status}${result.status === 0 ? '' : `: ${(result.stderr || result.stdout).trim().slice(0, 300)}`}`);
  };
  switch (host) {
    case 'claude':
      attempt('claude', ['plugin', 'uninstall', `${PLUGIN}@${MARKETPLACE}`]);
      break;
    case 'codex':
      attempt('codex', ['plugin', 'remove', `${PLUGIN}@${MARKETPLACE}`]);
      break;
    case 'cursor':
      rmSync(join(paths.home, '.cursor', 'plugins', 'local', PLUGIN), { force: true, recursive: true });
      log('removed ~/.cursor/plugins/local/host-test from the isolated home');
      break;
    default:
      throw new Error(`unreachable host ${host}`);
  }
  if (!flags.keepHome) {
    rmSync(paths.home, { force: true, recursive: true });
    rmSync(paths.workspace, { force: true, recursive: true });
    log(`removed isolated home ${paths.home} and workspace (copied auth included); captures stay in ${paths.captures}`);
  }
};

const status = () => {
  log(`isolated home: ${paths.home} (${existsSync(paths.home) ? 'present' : 'absent'})`);
  log(`workspace: ${paths.workspace} (${existsSync(paths.workspace) ? 'present' : 'absent'})`);
  const logFile = join(paths.logDir, 'captures.ndjson');
  log(`live log: ${logFile} (${existsSync(logFile) ? `${readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length} record(s)` : 'absent'})`);
  log(`captures: ${paths.captures}`);
};

switch (command) {
  case 'install': install(); break;
  case 'capture': capture(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  default: throw new Error(`unreachable command ${command}`);
}
