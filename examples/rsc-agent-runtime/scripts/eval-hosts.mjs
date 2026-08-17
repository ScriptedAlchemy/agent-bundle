/* global URL, process */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyNativeEvidence, evidenceFromTranscript, hookEvidenceFromProbe, summarizeHookProbe } from './eval-evidence.mjs';
import { sanitizedHostEnvironment } from './eval-host-environment.mjs';

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

const cliVersion = async (host, environment) => {
  const result = await runProcess(host, ['--version'], { env: environment });
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

const evidenceFrom = async (host, fixture, stateFile, probeFile, transcript, correlation) => {
  const stateRecords = await readFile(stateFile, 'utf8')
    .then((contents) => contents.split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .catch(() => []);
  const transcriptEvidence = evidenceFromTranscript(host, transcript, { ...correlation, stateRecords });
  const editObserved = await stat(join(fixture, correlation.editPath)).then(() => true).catch(() => false);
  const hookProbe = await hookProbeSummary(probeFile);
  return {
    editObservedByHook: editObserved && transcriptEvidence.stateMarkerObserved && hookEvidenceFromProbe(hookProbe),
    eventCounts: { ...transcriptEvidence.eventCounts, hook: hookProbe.launches, state: stateRecords.length },
    finalMarkerObserved: transcriptEvidence.finalMarkerObserved,
    hookProbe,
    mcpReadObserved: transcriptEvidence.mcpReadObserved,
    rscRenderToolObserved: transcriptEvidence.rscRenderToolObserved,
    sharedHookStateObserved: transcriptEvidence.sharedHookStateObserved,
  };
};

const promptFor = (host, { editPath, finalMarker }) => {
  const nativeEdit = host === 'codex'
    ? 'Use the apply_patch tool for that file edit; do not use a shell command.'
    : 'Use the Write tool for that file edit.';
  return `In this workspace, create exactly one file named ${editPath} containing the word ${host}. ${nativeEdit} Then call the rsc-agent-runtime MCP tool recent_edits, pass its snapshot to render_edit_timeline, and finish with this exact marker on its own line: ${finalMarker}. Do not create any other files.`;
};

const evaluateHost = async (host, capturedAt) => {
  const nativeEnvironment = sanitizedHostEnvironment(process.env);
  const version = await cliVersion(host, nativeEnvironment);
  const pluginRoot = join(exampleRoot, 'dist', 'plugins', host);
  await stat(pluginRoot);
  const fixture = await mkdtemp(join(tmpdir(), `rsc-agent-runtime-${host}-fixture-`));
  const marker = `rsc-eval-${randomBytes(16).toString('hex')}`;
  const correlation = {
    editPath: `host-created-${marker}.txt`,
    finalMarker: `HOST_EVAL_FINAL host=${host} marker=${marker}`,
    marker,
  };
  const stateFile = join(fixture, '.agent-runtime-demo', 'events.jsonl');
  const probeFile = join(fixture, 'hook-probe.jsonl');
  const sharedEnv = sanitizedHostEnvironment(process.env, { hookProbeFile: probeFile, stateFile });
  let temporaryCodexHome;
  try {
    await runProcess('git', ['init', '--quiet'], { cwd: fixture, env: sharedEnv });
    await runProcess('git', ['config', 'user.email', 'rsc-demo@example.invalid'], { cwd: fixture, env: sharedEnv });
    await runProcess('git', ['config', 'user.name', 'RSC Runtime Demo'], { cwd: fixture, env: sharedEnv });
    let result;
    if (host === 'claude') {
      result = await runProcess('claude', [
        '-p', promptFor(host, correlation), '--plugin-dir', pluginRoot, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
        '--no-session-persistence', '--dangerously-skip-permissions',
      ], { cwd: fixture, env: sharedEnv });
    } else {
      temporaryCodexHome = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-codex-home-'));
      await mkdir(temporaryCodexHome, { recursive: true });
      await opaqueCodexAuthCopy(temporaryCodexHome);
      const codexEnv = sanitizedHostEnvironment(process.env, {
        codexHome: temporaryCodexHome,
        hookProbeFile: probeFile,
        stateFile,
      });
      const marketplace = 'rsc-agent-runtime-marketplace';
      const marketplaceAdd = await runProcess('codex', ['plugin', 'marketplace', 'add', pluginRoot, '--json'], { cwd: fixture, env: codexEnv });
      const pluginAdd = marketplaceAdd.exitCode === 0
        ? await runProcess('codex', ['plugin', 'add', `rsc-agent-runtime@${marketplace}`, '--json'], { cwd: fixture, env: codexEnv })
        : { exitCode: 1, stderr: '', stdout: '' };
      result = pluginAdd.exitCode === 0
        ? await runProcess('codex', [
          '-a', 'never', 'exec', '--ephemeral', '--json', '--dangerously-bypass-hook-trust', '-s', 'workspace-write', '-C', fixture, promptFor(host, correlation),
        ], { cwd: fixture, env: codexEnv })
        : { exitCode: 1, stderr: '', stdout: '' };
    }
    const evidence = await evidenceFrom(host, fixture, stateFile, probeFile, `${result.stdout}\n${result.stderr}`, correlation);
    return classifyNativeEvidence(host, {
      ...evidence,
      sessionAvailable: result.exitCode === 0 && evidence.finalMarkerObserved,
      version,
    }, { capturedAt });
  } finally {
    if (temporaryCodexHome !== undefined) await rm(temporaryCodexHome, { force: true, recursive: true });
    await rm(fixture, { force: true, recursive: true });
  }
};

const run = async () => {
  const selected = parseHost(process.argv.slice(2));
  const hosts = selected === 'all' ? ['claude', 'codex'] : [selected];
  const capturedAt = new Date().toISOString();
  const summaries = [];
  for (const host of hosts) {
    try {
      summaries.push(await evaluateHost(host, capturedAt));
    } catch {
      summaries.push(classifyNativeEvidence(host, {}, { capturedAt }));
    }
  }
  process.stdout.write(`${JSON.stringify({ capturedAt, hosts: summaries, schemaVersion: 2 })}\n`);
  if (summaries.some((summary) => summary.claims.some((claim) => claim.id !== 'mcp-app-iframe' && claim.evidence !== 'observed'))) {
    process.exitCode = 1;
  }
};

run().catch(() => { process.exitCode = 1; });
