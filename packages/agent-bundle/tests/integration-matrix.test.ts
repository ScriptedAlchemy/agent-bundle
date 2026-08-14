import { execFile as executeFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { build, inspect, listHooks, simulateHook, validate } from '../src/api.ts';

const execFile = promisify(executeFile);
const fixturesRoot = join(process.cwd(), 'fixtures', 'integration');
const fixtureRoot = join(fixturesRoot, 'comprehensive');

it('builds the checked-in fixture matrix from a path with spaces', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-integration-matrix-'));
  const root = join(parent, 'project with spaces');
  const output = join(root, 'artifact');
  await cp(fixtureRoot, root, { recursive: true });

  try {
    const inspection = await inspect({ root });
    expect(inspection.model).toMatchObject({
      metadata: { name: 'integration-fixture' },
      scripts: [
        { mode: 'bundle', name: 'bundle' },
        { mode: 'copy', name: 'python' },
        { mode: 'copy', name: 'shell' },
      ],
      targets: [{ name: 'portable' }, { name: 'codex' }, { name: 'claude' }],
    });

    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });

    const generatedShell = join(output, 'portable', 'scripts', 'shell.sh');
    const generatedPython = join(output, 'portable', 'scripts', 'python.py');
    await expect(execFile(generatedShell, [], { cwd: root })).resolves.toMatchObject({ stdout: 'shell fixture\n' });
    await expect(execFile('python3', [generatedPython], { cwd: root })).resolves.toMatchObject({ stdout: 'python fixture\n' });
    expect((await stat(generatedShell)).mode & 0o777).toBe(0o751);
    expect((await stat(generatedPython)).mode & 0o777).toBe(0o711);

    const bundled = await import(pathToFileURL(join(output, 'portable', 'scripts', 'bundle.mjs')).href);
    expect(bundled.bundleMessage).toBe('bundled fixture');
    await expect(readFile(join(output, 'portable', 'scripts', 'bundle.mjs'), 'utf8')).resolves.not.toMatch(
      /from\s+['"]agent-bundle(?:\/[^'"]*)?['"]/,
    );

    await expect(readFile(join(output, 'portable', 'skills', 'review', 'references', 'guide.txt'), 'utf8')).resolves.toBe(
      'fixture reference\n',
    );
    await expect(readFile(join(output, 'portable', 'skills', 'review', 'assets', 'binary.bin'))).resolves.toEqual(
      await readFile(join(root, 'skills', 'review', 'assets', 'binary.bin')),
    );

    await expect(readFile(join(output, 'codex', '.codex-plugin', 'plugin.json'), 'utf8')).resolves.toContain(
      'integration-fixture',
    );
    await expect(readFile(join(output, 'claude', '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain(
      'integration-fixture',
    );
    await expect(readFile(join(output, 'portable', 'mcp.json'), 'utf8')).resolves.toContain(
      'remote-http',
    );

    const hooks = await listHooks({ artifact: output, root });
    expect(hooks).toHaveLength(2);
    await expect(simulateHook({
      artifact: output,
      hook: hooks[0]!.id,
      input: {
        cwd: root,
        sessionId: 'matrix',
        source: 'fixture',
        transcriptPath: join(root, 'transcript.json'),
      },
      root,
      target: hooks[0]!.target,
    })).resolves.toEqual({ additionalContext: 'hook:fixture', outcome: 'continue' });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}, 60_000);

it('builds the checked-in portable skills-only fixture', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-skills-only-'));
  const root = join(parent, 'skills-only');
  const output = join(root, 'artifact');
  await cp(join(fixturesRoot, 'skills-only'), root, { recursive: true });

  try {
    await expect(inspect({ root })).resolves.toMatchObject({
      model: { scripts: [], targets: [{ name: 'portable' }] },
    });
    await build({ output, root });
    await expect(readFile(join(output, 'portable', 'skills', 'portable-skill', 'references', 'guide.txt'), 'utf8')).resolves.toBe(
      'portable guide\n',
    );
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

it('reports checked-in unsupported-capability and canonical-collision diagnostics', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-negative-fixtures-'));
  const unsupportedRoot = join(parent, 'unsupported');
  const collisionRoot = join(parent, 'collision');
  await Promise.all([
    cp(join(fixturesRoot, 'unsupported-capability'), unsupportedRoot, { recursive: true }),
    cp(join(fixturesRoot, 'canonical-collision'), collisionRoot, { recursive: true }),
  ]);

  try {
    const [unsupported, collision] = await Promise.all([
      validate({ root: unsupportedRoot }),
      validate({ root: collisionRoot }),
    ]);
    expect(unsupported.diagnostics.map((diagnostic) => diagnostic.code)).toContain('AB4204');
    expect(collision.diagnostics.map((diagnostic) => diagnostic.code)).toContain('AB4408');
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
