import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { CodexEvalHarnessError, codexHarnessFailure } from '../src/eval/codex-errors.ts';
import {
  codexPluginInstallPlan,
  codexPluginObserved,
  readCodexCandidatePlugin,
} from '../src/eval/codex-plugins.ts';

const fixtureRoot = new URL('../fixtures/eval/codex/', import.meta.url);

const marketplace = {
  name: 'agent-bundle-eval-marketplace',
  plugins: [{ name: 'agent-bundle-eval', source: { path: './', source: 'local' } }],
};

const withCandidate = async (
  build: (candidate: string) => Promise<void>,
  task: (candidate: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle codex candidate '));
  try {
    await build(root);
    await task(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

it('reads the generated Codex marketplace identity and packaged Skill names', async () => {
  await withCandidate(
    async (candidate) => {
      await mkdir(join(candidate, '.agents', 'plugins'), { recursive: true });
      await mkdir(join(candidate, 'skills', 'release-notes'), { recursive: true });
      await mkdir(join(candidate, 'skills', 'triage'), { recursive: true });
      await writeFile(join(candidate, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify(marketplace)}\n`);
      await writeFile(join(candidate, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\n---\n');
      await writeFile(join(candidate, 'skills', 'triage', 'SKILL.md'), '---\nname: triage\n---\n');
    },
    async (candidate) => {
      const plugin = await readCodexCandidatePlugin(candidate);
      expect(plugin).toEqual({
        marketplace: 'agent-bundle-eval-marketplace',
        plugin: 'agent-bundle-eval',
        skills: ['release-notes', 'triage'],
      });
      expect(codexPluginInstallPlan(plugin, candidate)).toEqual([
        { args: ['plugin', 'marketplace', 'add', candidate], id: 'marketplace.add' },
        { args: ['plugin', 'add', 'agent-bundle-eval@agent-bundle-eval-marketplace'], id: 'plugin.add' },
        { args: ['plugin', 'list', '--json'], id: 'plugin.list' },
      ]);
    },
  );
});

it('rejects a candidate that carries no installable Codex marketplace', async () => {
  await withCandidate(
    async (candidate) => {
      await mkdir(join(candidate, '.codex-plugin'), { recursive: true });
      await writeFile(join(candidate, '.codex-plugin', 'plugin.json'), '{"name":"agent-bundle-eval"}\n');
    },
    async (candidate) => {
      await expect(readCodexCandidatePlugin(candidate)).rejects.toMatchObject({
        code: 'CODEX_ARTIFACT_INVALID',
        name: 'CodexEvalHarnessError',
      });
    },
  );
});

it('rejects a root marketplace manifest outside the canonical Codex path', async () => {
  await withCandidate(
    async (candidate) => {
      await writeFile(join(candidate, 'marketplace.json'), `${JSON.stringify(marketplace)}\n`);
    },
    async (candidate) => {
      await expect(readCodexCandidatePlugin(candidate)).rejects.toMatchObject({
        code: 'CODEX_ARTIFACT_INVALID',
        name: 'CodexEvalHarnessError',
      });
    },
  );
});

it('observes plugin availability only when the temporary home reports it installed and enabled', async () => {
  const installed = await readFile(new URL('plugin-list.json', fixtureRoot), 'utf8');
  const disabled = await readFile(new URL('plugin-list-disabled.json', fixtureRoot), 'utf8');
  const candidate = { marketplace: 'agent-bundle-eval-marketplace', plugin: 'agent-bundle-eval', skills: [] };

  expect(codexPluginObserved(installed, candidate)).toBe(true);
  expect(codexPluginObserved(disabled, candidate)).toBe(false);
  expect(codexPluginObserved(installed, { ...candidate, plugin: 'other' })).toBe(false);
  expect(codexPluginObserved('not json', candidate)).toBe(false);
});

it('maps every Codex harness error onto a structural harness failure, never a plugin failure', () => {
  expect(codexHarnessFailure(new CodexEvalHarnessError('CODEX_CLI_MISSING', 'The codex executable is not installed.'))).toEqual({
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: 'CODEX_CLI_MISSING: The Codex CLI is not installed.',
    stage: 'preflight',
  });
  expect(codexHarnessFailure(new CodexEvalHarnessError('CODEX_TRACE_INVALID', 'The event stream was unreadable.'))).toEqual({
    code: 'EVAL_TRACE_UNAVAILABLE',
    message: 'CODEX_TRACE_INVALID: The Codex event stream could not be verified.',
    stage: 'trace',
  });
  expect(codexHarnessFailure(new CodexEvalHarnessError('CODEX_ARTIFACT_INVALID', 'The candidate has no marketplace.'))).toEqual({
    code: 'EVAL_ARTIFACT_UNAVAILABLE',
    message: 'CODEX_ARTIFACT_INVALID: The Codex candidate artifact is unavailable.',
    stage: 'artifact',
  });
  expect(codexHarnessFailure(new Error('unexpected'))).toEqual({
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: 'CODEX_TRIAL_FAILED: The native Codex trial could not be completed.',
    stage: 'preflight',
  });
});
