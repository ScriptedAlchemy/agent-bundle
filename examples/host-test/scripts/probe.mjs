#!/usr/bin/env node
// Scripted probe lifecycle: install the built host-test artifact into an
// ISOLATED host home, drive one capture session, copy the log out, and
// uninstall. Nothing here touches the real ~/.claude, ~/.codex, or ~/.cursor.
//
//   node scripts/probe.mjs install   <claude|codex|cursor> [--no-auth] [--root <dir>]
//   node scripts/probe.mjs capture   <claude|codex|cursor> [--prompt <text>] [--model <m>] [--timeout <ms>] [--scripted-model]
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
    switch (flag) {
      case '--no-auth': flags.auth = false; break;
      case '--keep-home': flags.keepHome = true; break;
      case '--root': flags.root = rest[++index]; break;
      case '--prompt': flags.prompt = rest[++index]; break;
      case '--model': flags.model = rest[++index]; break;
      case '--timeout': flags.timeout = Number(rest[++index]); break;
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

/** The isolated environment every host command runs with. HOME moves; auth is copied opaquely. */
const isolatedEnvironment = () => {
  const environment = { ...process.env, HOME: paths.home, HOST_TEST_LOG_DIR: paths.logDir };
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
  // Nothing from the real host homes leaks through inherited variables.
  delete environment.ANTHROPIC_API_KEY;
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
 * With --scripted-model the real Claude Code binary talks to a local scripted
 * Messages API (scripts/mock-anthropic.mjs) instead of Anthropic, so the hook,
 * MCP, and subagent plumbing under test is the host's own while no account is
 * needed; the model text in the transcript is then not evidence of anything.
 */
const captureClaude = () => {
  const scripted = flags.scriptedModel === true;
  const args = [
    '-p', scripted ? 'You are exercising the host-test probe plugin. Do the scripted steps.' : scenarioPrompt(),
    '--output-format', 'json',
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
  log(`claude ${args.slice(2).join(' ')}${scripted ? ` (scripted model on 127.0.0.1:${String(port)})` : ''}`);
  try {
    if (mock !== undefined) spawnSync(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 800)']);
    return run('claude', args, { cwd: paths.workspace, env: environment, timeout: flags.timeout ?? 900_000 });
  } finally {
    mock?.kill();
  }
};

const captureCodex = () => {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '--dangerously-bypass-hook-trust',
    '--json',
    '-C', paths.workspace,
    ...(flags.model === undefined ? [] : ['--model', flags.model]),
    scenarioPrompt(),
  ];
  log(`codex ${args.slice(0, -1).join(' ')} "<prompt>"`);
  return run('codex', args, { cwd: paths.workspace, timeout: flags.timeout ?? 900_000 });
};

const captureCursor = () => {
  const args = [
    '-p', scenarioPrompt(),
    '--output-format', 'json',
    '--force',
    ...(flags.model === undefined ? [] : ['--model', flags.model]),
  ];
  log(`cursor-agent ${args.slice(2).join(' ')} (IDE sessions are driven manually; see probe:install output)`);
  return run('cursor-agent', args, { cwd: paths.workspace, timeout: flags.timeout ?? 900_000 });
};

const capture = () => {
  if (!existsSync(paths.home)) throw new Error(`isolated home ${paths.home} missing; run probe:install ${host} first`);
  mkdirSync(paths.captures, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  let result;
  switch (host) {
    case 'claude': result = captureClaude(); break;
    case 'codex': result = captureCodex(); break;
    case 'cursor': result = captureCursor(); break;
    default: throw new Error(`unreachable host ${host}`);
  }
  writeFileSync(join(paths.captures, `session-${stamp}.stdout.txt`), result.stdout ?? '');
  writeFileSync(join(paths.captures, `session-${stamp}.stderr.txt`), result.stderr ?? '');
  log(`host exit ${result.status}; transcript at ${join(paths.captures, `session-${stamp}.*`)}`);
  const logFile = join(paths.logDir, 'captures.ndjson');
  if (existsSync(logFile)) {
    const copy = join(paths.captures, `captures-${stamp}.ndjson`);
    copyFileSync(logFile, copy);
    const lines = readFileSync(copy, 'utf8').split('\n').filter(Boolean).length;
    log(`copied ${lines} capture record(s) to ${copy}`);
    const dump = run(process.execPath, [join(exampleRoot, 'dist', 'bin', 'host-test.js'), 'dump', '--log', copy], { env: process.env });
    process.stdout.write(dump.stdout);
    process.stderr.write(dump.stderr);
  } else {
    log(`no capture log was written at ${logFile}: the host dispatched no hook and no MCP call reached the probe`);
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
