/**
 * Re-records the Claude CLI verdicts the pinned `schemas/claude/hooks.schema.json`
 * is cross-checked against (tests/claude-hooks-schema.test.ts, #477).
 *
 * Every `tests/fixtures/claude-hooks-schema/cases/<name>.json` is written as the
 * `hooks/hooks.json` of a minimal plugin and validated with
 * `claude plugin validate <plugin>/.claude-plugin/plugin.json --strict --json`;
 * the JSON report lands in `reports/<claude version>/<name>.json` with the
 * temporary plugin path replaced by `/bundle/claude`, the placeholder the other
 * recorded Claude reports under tests/fixtures use. The run needs no login: it
 * points CLAUDE_CONFIG_DIR at an empty directory.
 *
 *   node scripts/record-claude-hooks-schema-fixtures.mjs
 */
import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(repositoryRoot, 'packages/agent-bundle/tests/fixtures/claude-hooks-schema');
const pluginPathPlaceholder = '/bundle/claude';

/** The manifest every case shares; `author` keeps `--strict` from failing on the attribution warning. */
const manifest = {
  author: { name: 'agent-bundle' },
  description: 'Claude hooks schema fixture.',
  name: 'hooks-schema-fixture',
  version: '1.0.0',
};

const claude = async (args, env) => {
  try {
    const { stdout, stderr } = await execFile('claude', args, { encoding: 'utf8', env });
    return { exitCode: 0, stderr, stdout };
  } catch (error) {
    if (typeof error?.code !== 'number') throw error;
    return { exitCode: error.code, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
  }
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
    const result = await claude(['plugin', 'validate', manifestPath, '--strict', '--json'], env);
    if (result.exitCode === 2 || result.stdout.trim().length === 0) {
      throw new Error(`claude plugin validate did not produce a report for ${name} (exit ${result.exitCode}): ${result.stderr}`);
    }
    const report = JSON.parse(result.stdout.replaceAll(pluginRoot, pluginPathPlaceholder));
    if (report.success !== (result.exitCode === 0)) disagreements += 1;
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
