/**
 * Re-records the Claude CLI verdicts the pinned `schemas/claude/hooks.schema.json`
 * is cross-checked against (tests/claude-hooks-schema.test.ts, #477).
 *
 * Every `tests/fixtures/claude-hooks-schema/cases/<name>.json` is written as the
 * `hooks/hooks.json` of a minimal plugin and validated with
 * `claude plugin validate <plugin>/.claude-plugin/plugin.json --strict --json`;
 * the JSON report lands in `reports/<claude version>/<name>.json` with the
 * temporary plugin path replaced by `/bundle/claude`, the placeholder the other
 * recorded Claude reports under tests/fixtures use. A CLI without `--json`
 * (the pinned 2.1.250 has only the text reporter) is recorded from its text
 * output into the same shape, marked `"reporter": "text"`. The run needs no
 * login: it points CLAUDE_CONFIG_DIR at an empty directory.
 *
 *   node scripts/record-claude-hooks-schema-fixtures.mjs
 *
 * CLAUDE_BIN selects the binary (default: `claude` on PATH), so the pinned
 * PROVENANCE.json observedCliVersion can be recorded from a scratch install
 * (`npm install --prefix <dir> @anthropic-ai/claude-code@<pin>`) beside a newer
 * release without touching the global installation.
 */
import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const repositoryRoot = resolve(import.meta.dirname, '..');
const fixtureRoot = join(repositoryRoot, 'packages/agent-bundle/tests/fixtures/claude-hooks-schema');
const pluginPathPlaceholder = '/bundle/claude';
const claudeBinary = process.env.CLAUDE_BIN ?? 'claude';

/** The manifest every case shares; `author` keeps `--strict` from failing on the attribution warning. */
const manifest = {
  author: { name: 'agent-bundle' },
  description: 'Claude hooks schema fixture.',
  name: 'hooks-schema-fixture',
  version: '1.0.0',
};

const claude = async (args, env) => {
  try {
    const { stdout, stderr } = await execFile(claudeBinary, args, { encoding: 'utf8', env });
    return { exitCode: 0, stderr, stdout };
  } catch (error) {
    if (typeof error?.code !== 'number') throw error;
    return { exitCode: error.code, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
  }
};

/** `--json` where the CLI has it; otherwise the text reporter, parsed into the JSON reporter's shape. */
let jsonReporter = true;
const validateReport = async (manifestPath, pluginRoot, env) => {
  const normalize = (text) => text.replaceAll(pluginRoot, pluginPathPlaceholder);
  if (jsonReporter) {
    const result = await claude(['plugin', 'validate', manifestPath, '--strict', '--json'], env);
    if (!/unknown option '--json'/u.test(result.stderr)) {
      if (result.exitCode === 2 || result.stdout.trim().length === 0) {
        throw new Error(`claude plugin validate did not produce a report for ${manifestPath} (exit ${result.exitCode}): ${result.stderr}`);
      }
      return { ...JSON.parse(normalize(result.stdout)), exitCodeSuccess: result.exitCode === 0 };
    }
    jsonReporter = false;
  }
  const result = await claude(['plugin', 'validate', manifestPath, '--strict'], env);
  const text = normalize(`${result.stdout}\n${result.stderr}`);
  if (!/Validation (passed|failed)/u.test(text)) {
    throw new Error(`claude plugin validate did not produce a verdict for ${manifestPath} (exit ${result.exitCode}): ${text}`);
  }
  const success = /Validation passed/u.test(text);
  // Findings are "  ❯ <path>: <message>" lines under "Found N error(s)" / "Found N warning(s)".
  const contents = [];
  let current;
  for (const line of text.split('\n')) {
    const validating = /^Validating (\w+): (.+)$/u.exec(line.trim());
    if (validating) {
      current = { file: validating[2], type: validating[1] === 'plugin' ? 'plugin' : validating[1], errors: [], warnings: [], notes: [] };
      contents.push(current);
      continue;
    }
    const heading = /Found \d+ (error|warning)s?:/u.exec(line);
    if (heading) { current.findings = heading[1] === 'error' ? current.errors : current.warnings; continue; }
    const finding = /^\s*❯ (\S+): (.+)$/u.exec(line);
    if (finding && current?.findings) current.findings.push({ path: finding[1], message: finding[2], code: null });
  }
  for (const content of contents) delete content.findings;
  const manifest = contents.find((content) => content.type === 'plugin') ?? { file: normalize(manifestPath), type: 'plugin', errors: [], warnings: [], notes: [] };
  return {
    success,
    strict: true,
    target: normalize(manifestPath),
    reporter: 'text',
    manifest,
    contents: contents.filter((content) => content !== manifest),
    exitCodeSuccess: result.exitCode === 0,
  };
};

const scratch = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-hooks-schema-'));
try {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(scratch, 'config') };
  await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const version = (await claude(['--version'], env)).stdout.trim().split(/\s+/u)[0];
  if (!/^\d+\.\d+\.\d+/u.test(version ?? '')) throw new Error(`could not read the Claude CLI version: ${version}`);
  const reportRoot = join(fixtureRoot, 'reports', version);
  await mkdir(reportRoot, { recursive: true });

  const cases = (await readdir(join(fixtureRoot, 'cases'))).filter((name) => name.endsWith('.json')).sort();
  let disagreements = 0;
  for (const file of cases) {
    const name = file.slice(0, -'.json'.length);
    const pluginRoot = join(scratch, name);
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'hooks'), { recursive: true });
    await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(pluginRoot, 'hooks', 'hooks.json'), await readFile(join(fixtureRoot, 'cases', file), 'utf8'));

    const manifestPath = join(pluginRoot, '.claude-plugin', 'plugin.json');
    const report = await validateReport(manifestPath, pluginRoot, env);
    if (report.success !== report.exitCodeSuccess) disagreements += 1;
    delete report.exitCodeSuccess;
    await writeFile(join(reportRoot, file), `${JSON.stringify(report, null, 2)}\n`);
    const findings = (report.contents ?? []).flatMap((content) => [
      ...(content.errors ?? []).map((finding) => `error ${finding.path}: ${finding.message}`),
      ...(content.warnings ?? []).map((finding) => `warning ${finding.path}: ${finding.message}`),
    ]);
    console.log(`${report.success ? 'accepted' : 'rejected'} ${name}${findings.length === 0 ? '' : ` — ${findings.join('; ')}`}`);
  }
  console.log(`Recorded ${cases.length} reports from Claude Code ${version} under ${reportRoot}.`);
  if (disagreements > 0) throw new Error(`${disagreements} report(s) disagree with their exit code.`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}
