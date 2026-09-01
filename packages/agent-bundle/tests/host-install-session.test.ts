import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import {
  buildHostInstallTokenFixture,
  CLAUDE_SESSION_ARGUMENT,
  CLAUDE_SESSION_OPT_IN,
  disposeHostInstallFixture,
  runClaudeTokenSessionProof,
  type BuiltHostInstallTokenFixture,
} from './support/host-install.ts';
import { foreignSkillMarkdownSyntax, skillTokenSpellings } from '../src/skills/tokens.ts';
import {
  HOST_INSTALL_PROOF_LEVEL,
  proofLevelLabel,
} from '../src/test/manifest.ts';

const proofLabel = proofLevelLabel(HOST_INSTALL_PROOF_LEVEL);
const claudeAvailable = spawnSync('claude', ['--version'], {
  stdio: 'ignore',
  timeout: 5_000,
  windowsHide: true,
}).status === 0;
const sessionOptedIn = process.env[CLAUDE_SESSION_OPT_IN] === '1';
const sessionMissingEvidence = !claudeAvailable
  ? 'missing evidence: claude binary unavailable on PATH'
  : `missing evidence: ${CLAUDE_SESSION_OPT_IN}=1 opt-in required for a real model call`;
const sessionIt = claudeAvailable && sessionOptedIn ? it : it.skip;

let fixture: BuiltHostInstallTokenFixture | undefined;

beforeAll(async () => {
  fixture = await buildHostInstallTokenFixture({ environment: process.env });
}, 180_000);

afterAll(async () => {
  if (fixture !== undefined) await disposeHostInstallFixture(fixture);
});

const builtFixture = (): BuiltHostInstallTokenFixture => {
  if (fixture === undefined) throw new Error(`[${proofLabel}] token fixture build did not complete.`);
  return fixture;
};

it('lowers canonical Skill tokens to Claude spellings without leaking foreign syntax', () => {
  const markdown = builtFixture().loweredSkillMarkdown;

  expect(markdown, proofLabel).toContain('ARGS_MARKER=$ARGUMENTS');
  expect(markdown, proofLabel).toContain('PLUGIN_ROOT_MARKER=${CLAUDE_PLUGIN_ROOT}');
  expect(markdown, proofLabel).toContain('SKILL_DIR_MARKER=${CLAUDE_SKILL_DIR}');
  for (const spelling of Object.values(skillTokenSpellings)) {
    expect(markdown, proofLabel).not.toContain(spelling);
  }
  for (const syntax of foreignSkillMarkdownSyntax('claude')) {
    expect(markdown, proofLabel).not.toContain(syntax);
  }
});

sessionIt(
  claudeAvailable && sessionOptedIn
    ? 'resolves the Claude arguments, plugin-root, and skill-root tokens in a real session'
    : `resolves the Claude arguments, plugin-root, and skill-root tokens in a real session [${sessionMissingEvidence}]`,
  async () => {
    const report = await runClaudeTokenSessionProof(builtFixture(), { environment: process.env });

    expect(report, proofLabel).toEqual({
      claudeVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
      host: 'claude',
      invocation: {
        attempts: expect.any(Number),
        mode: 'inline --plugin-dir session',
        model: 'claude-sonnet-4-5',
        normalHome: {
          sessionBookkeeping: 'rewritten by Claude Code on every real turn',
          settingsAndPlugins: 'unchanged',
        },
      },
      markers: {
        arguments: CLAUDE_SESSION_ARGUMENT,
        pluginRoot: '.',
        skillRoot: 'skills/token-probe',
      },
      proofLevel: proofLabel,
      qualifier: expect.stringContaining('session-token'),
      resolved: {
        arguments: 'substituted',
        pluginRoot: 'absolute path that exists and is the loaded bundle root',
        skillRoot: 'absolute path that exists and is the loaded skill directory',
      },
      status: 'passed',
    });
    expect(report.invocation.attempts, proofLabel).toBeLessThanOrEqual(2);
    expect(report.qualifier, proofLabel).toContain(report.claudeVersion);
    expect(JSON.stringify(report), proofLabel).not.toMatch(
      /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|authorization|credential|password|secret|sk-[A-Za-z0-9_-]{16,}|\/home\/|\/Users\/|\/tmp\/|stdout|stderr)/iu,
    );
  },
  660_000,
);
