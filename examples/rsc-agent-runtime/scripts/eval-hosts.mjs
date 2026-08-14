/* global URL, process */

import { spawn } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evidenceFromTranscript, hookEvidenceFromProbe, summarizeHookProbe } from './eval-evidence.mjs';

const exampleRoot = resolve(new URL('..', import.meta.url).pathname);
const expectedVersions = { claude: '2.1.232', codex: '0.147.0' };

const parseHost = (argv) => {
  const hostIndex = argv.indexOf('--host');
  const host = hostIndex === -1 ? 'all' : argv[hostIndex + 1];
  if (!['claude', 'codex', 'all'].includes(host) || argv.length !== (hostIndex === -1 ? 0 : 2)) {
    throw new Error('Usage: node scripts/eval-hosts.mjs [--host claude|codex|all]');
  }
  return host;
};

const runProcess = async (command, args, options = {}) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [exitCode, signal] = await once(child, 'close');
  return { exitCode, signal, stderr, stdout };
};

const cliVersion = async (host) => {
  const result = await runProcess(host, ['--version']);
  const version = result.stdout.trim() || result.stderr.trim();
  if (result.exitCode !== 0 || !version.includes(expectedVersions[host])) {
    throw new Error(`${host} ${expectedVersions[host]} is not installed`);
  }
  return expectedVersions[host];
};

const opaqueCodexAuthCopy = async (temporaryCodexHome) => {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const source = join(sourceHome, 'auth.json');
  try {
    const sourceStat = await stat(source);
    await copyFile(source, join(temporaryCodexHome, 'auth.json'));
    await chmod(join(temporaryCodexHome, 'auth.json'), sourceStat.mode & 0o777);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
};

const hookProbeSummary = async (probeFile) => {
  const records = await readFile(probeFile, 'utf8')
    .then((contents) => contents.split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .catch(() => []);
  return summarizeHookProbe(records);
};

const evidenceFrom = async (host, fixture, stateFile, probeFile, transcript) => {
  const stateRecords = await readFile(stateFile, 'utf8')
    .then((contents) => contents.split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .catch(() => []);
  const transcriptEvidence = evidenceFromTranscript(host, transcript);
  const stateRecorded = stateRecords.some((record) => record.host === host && String(record.path).endsWith('host-created.txt'));
  const editObserved = await stat(join(fixture, 'host-created.txt')).then(() => true).catch(() => false);
  const hookProbe = await hookProbeSummary(probeFile);
  return {
    editObservedByHook: editObserved && stateRecorded && hookEvidenceFromProbe(hookProbe),
    editObservedByMcp: transcriptEvidence.mcpReadObserved && stateRecorded,
    eventCounts: { ...transcriptEvidence.eventCounts, hook: hookProbe.launches, state: stateRecords.length },
    finalMarkerObserved: transcriptEvidence.finalMarkerObserved,
    hookProbe,
    rscRenderToolObserved: transcriptEvidence.rscRenderToolObserved,
  };
};

const promptFor = (host) => {
  const nativeEdit = host === 'codex'
    ? 'Use the apply_patch tool for that file edit; do not use a shell command.'
    : 'Use the Write tool for that file edit.';
  return `In this workspace, create exactly one file named host-created.txt containing the word ${host}. ${nativeEdit} Then call the rsc-agent-runtime MCP tool recent_edits, pass its snapshot to render_edit_timeline, and finish with this exact marker on its own line: HOST_EVAL_FINAL host=${host} path=host-created.txt. Do not create any other files.`;
};

const evaluateHost = async (host) => {
  const startedAt = Date.now();
  const version = await cliVersion(host);
  const pluginRoot = join(exampleRoot, 'dist', 'plugins', host);
  await stat(pluginRoot);
  const fixture = await mkdtemp(join(tmpdir(), `rsc-agent-runtime-${host}-fixture-`));
  const stateFile = join(fixture, '.agent-runtime-demo', 'events.jsonl');
  const probeFile = join(fixture, 'hook-probe.jsonl');
  const sharedEnv = {
    ...process.env,
    AGENT_RUNTIME_HOOK_PROBE_FILE: probeFile,
    AGENT_RUNTIME_STATE_FILE: stateFile,
  };
  let temporaryCodexHome;
  try {
    await runProcess('git', ['init', '--quiet'], { cwd: fixture, env: sharedEnv });
    await runProcess('git', ['config', 'user.email', 'rsc-demo@example.invalid'], { cwd: fixture, env: sharedEnv });
    await runProcess('git', ['config', 'user.name', 'RSC Runtime Demo'], { cwd: fixture, env: sharedEnv });
    let result;
    if (host === 'claude') {
      result = await runProcess('claude', [
        '-p', promptFor(host), '--plugin-dir', pluginRoot, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
        '--no-session-persistence', '--dangerously-skip-permissions',
      ], { cwd: fixture, env: sharedEnv });
    } else {
      temporaryCodexHome = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-codex-home-'));
      await mkdir(temporaryCodexHome, { recursive: true });
      await opaqueCodexAuthCopy(temporaryCodexHome);
      const codexEnv = { ...sharedEnv, AGENT_RUNTIME_HOOK_PROBE_FILE: probeFile, CODEX_HOME: temporaryCodexHome };
      const marketplace = 'rsc-agent-runtime-marketplace';
      const marketplaceAdd = await runProcess('codex', ['plugin', 'marketplace', 'add', pluginRoot, '--json'], { cwd: fixture, env: codexEnv });
      const pluginAdd = marketplaceAdd.exitCode === 0
        ? await runProcess('codex', ['plugin', 'add', `rsc-agent-runtime@${marketplace}`, '--json'], { cwd: fixture, env: codexEnv })
        : { exitCode: 1, stderr: '', stdout: '' };
      result = pluginAdd.exitCode === 0
        ? await runProcess('codex', [
          '-a', 'never', 'exec', '--ephemeral', '--json', '--dangerously-bypass-hook-trust', '-s', 'workspace-write', '-C', fixture, promptFor(host),
        ], { cwd: fixture, env: codexEnv })
        : { exitCode: 1, stderr: '', stdout: '' };
    }
    const evidence = await evidenceFrom(host, fixture, stateFile, probeFile, `${result.stdout}\n${result.stderr}`);
    const success = result.exitCode === 0 && evidence.editObservedByHook && evidence.editObservedByMcp && evidence.rscRenderToolObserved && evidence.finalMarkerObserved;
    return {
      evidenceComplete: success,
      elapsedMs: Date.now() - startedAt,
      host,
      ...evidence,
      ...(success ? {} : { limitation: 'The selected native run did not produce every required hook/MCP evidence item.' }),
      sessionAvailable: result.exitCode === 0 && evidence.finalMarkerObserved,
      version,
    };
  } finally {
    if (temporaryCodexHome !== undefined) await rm(temporaryCodexHome, { force: true, recursive: true });
    await rm(fixture, { force: true, recursive: true });
  }
};

const run = async () => {
  const selected = parseHost(process.argv.slice(2));
  const hosts = selected === 'all' ? ['claude', 'codex'] : [selected];
  const summaries = [];
  for (const host of hosts) {
    try {
      summaries.push(await evaluateHost(host));
    } catch {
      summaries.push({
        editObservedByHook: false,
        editObservedByMcp: false,
        evidenceComplete: false,
        elapsedMs: 0,
        eventCounts: { hook: 0, json: 0, mcp: 0, rscRender: 0, state: 0 },
        finalMarkerObserved: false,
        host,
        hookProbe: { commandLaunched: false, exitStatuses: [], toolInputKeySets: [], toolNames: [], topLevelKeySets: [], valueTypeSets: [] },
        rscRenderToolObserved: false,
        sessionAvailable: false,
        version: expectedVersions[host],
      });
    }
  }
  process.stdout.write(`${JSON.stringify({ hosts: summaries })}\n`);
  if (summaries.some((summary) => !summary.evidenceComplete)) process.exitCode = 1;
};

run().catch(() => { process.exitCode = 1; });
