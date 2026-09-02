import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import {
  buildHostInstallFixture,
  buildPortableHostInstallFixture,
  disposeHostInstallFixture,
  runClaudeHostInstallProof,
  runCodexHostInstallProof,
  runCursorHostInstallProof,
  runPortableHostInstallProof,
  type BuiltHostInstallFixture,
  type BuiltPortableHostInstallFixture,
} from './support/host-install.ts';
import {
  HOST_INSTALL_PROOF_LEVEL,
  proofLevelLabel,
} from '../src/test/manifest.ts';

const proofLabel = proofLevelLabel(HOST_INSTALL_PROOF_LEVEL);
const claudeMissingEvidence = 'missing evidence: claude binary unavailable on PATH';
const codexMissingEvidence = 'missing evidence: codex binary unavailable on PATH';
const claudeAvailable = spawnSync('claude', ['--version'], {
  stdio: 'ignore',
  timeout: 5_000,
  windowsHide: true,
}).status === 0;
const codexAvailable = spawnSync('codex', ['--version'], {
  stdio: 'ignore',
  timeout: 5_000,
  windowsHide: true,
}).status === 0;
const claudePluginIt = claudeAvailable ? it : it.skip;
const codexPluginIt = codexAvailable ? it : it.skip;

let fixture: BuiltHostInstallFixture | undefined;
let portableFixture: BuiltPortableHostInstallFixture | undefined;

beforeAll(async () => {
  [fixture, portableFixture] = await Promise.all([
    buildHostInstallFixture({ environment: process.env }),
    buildPortableHostInstallFixture({ environment: process.env }),
  ]);
}, 180_000);

afterAll(async () => {
  await Promise.all([
    fixture === undefined ? Promise.resolve() : disposeHostInstallFixture(fixture),
    portableFixture === undefined ? Promise.resolve() : disposeHostInstallFixture(portableFixture),
  ]);
});

const builtFixture = (): BuiltHostInstallFixture => {
  if (fixture === undefined) throw new Error(`[${proofLabel}] shared fixture build did not complete.`);
  return fixture;
};

const builtPortableFixture = (): BuiltPortableHostInstallFixture => {
  if (portableFixture === undefined) {
    throw new Error(`[${proofLabel}] portable fixture build did not complete.`);
  }
  return portableFixture;
};

const expectHygienicReport = (report: unknown): void => {
  expect(JSON.stringify(report), proofLabel).not.toMatch(
    /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|authorization|credential|password|secret|sk-[A-Za-z0-9_-]{16,}|\/home\/|\/Users\/|\/tmp\/|stdout|stderr)/iu,
  );
};

claudePluginIt(
  claudeAvailable
    ? 'installs through Claude and observes the host-owned component inventory'
    : `installs through Claude and observes the host-owned component inventory [${claudeMissingEvidence}]`,
  async () => {
    const report = await runClaudeHostInstallProof(builtFixture(), { environment: process.env });

    expect(report, proofLabel).toEqual({
      host: 'claude',
      install: { state: 'installed', version: '1.0.0' },
      inventory: { hooks: 1, mcpServers: 1, skills: 1 },
      proofLevel: proofLabel,
      registration: {
        enabled: true,
        id: 'host-install-proof@host-install-proof-marketplace',
        installPath: 'plugins/cache/host-install-proof-marketplace/host-install-proof/1.0.0',
        mcpServers: ['probe'],
        scope: 'user',
        version: '1.0.0',
      },
      skill: 'plugins/cache/host-install-proof-marketplace/host-install-proof/1.0.0/skills/probe/SKILL.md',
      status: 'passed',
    });
    expectHygienicReport(report);
  },
  180_000,
);

codexPluginIt(
  codexAvailable
    ? 'installs through Codex and observes enabled registration'
    : `installs through Codex and observes enabled registration [${codexMissingEvidence}]`,
  async () => {
    const report = await runCodexHostInstallProof(builtFixture(), { environment: process.env });

    expect(report, proofLabel).toEqual({
      host: 'codex',
      install: { state: 'installed', version: '1.0.0' },
      manifest: {
        interfaceCapabilities: ['hooks', 'mcp', 'skills'],
        interfaceFields: [
          'capabilities',
          'category',
          'defaultPrompt',
          'developerName',
          'displayName',
          'longDescription',
          'shortDescription',
        ],
        path: '.codex-plugin/plugin.json',
      },
      proofLevel: proofLabel,
      registration: {
        cachePath: 'plugins/cache/host-install-proof-marketplace/host-install-proof/1.0.0',
        state: 'installed, enabled',
        version: '1.0.0',
      },
      skill: 'plugins/cache/host-install-proof-marketplace/host-install-proof/1.0.0/skills/probe/SKILL.md',
      skillSidecar: {
        matchesBuiltArtifact: true,
        path: 'skills/probe/agents/openai.yaml',
        schema: 'schema-valid',
        sections: ['dependencies', 'interface', 'policy'],
      },
      status: 'passed',
    });
    expectHygienicReport(report);
  },
  180_000,
);

it('installs into an isolated Cursor home, validates schemas, and is idempotent', async () => {
  const report = await runCursorHostInstallProof(builtFixture(), { environment: process.env });

  expect(report, proofLabel).toEqual({
    destination: '.cursor/plugins/local/host-install-proof',
    documents: {
      hooks: 'schema-valid',
      mcp: 'schema-valid',
      plugin: 'schema-valid',
    },
    host: 'cursor',
    install: { first: 'installed', second: 'already-installed', version: '1.0.0' },
    logo: {
      path: './assets/docs/media/logo.svg',
      resolvesInsideDeployTree: true,
    },
    pluginRootVariable: {
      locations: [
        'hooks/hooks.json#/hooks/sessionStart/0/command',
        'mcp.json#/mcpServers/probe/args/0',
        'mcp.json#/mcpServers/probe/env/AGENT_BUNDLE_PLUGIN_ROOT',
      ],
      resolvedAtInstall: false,
      sessionEvidence: 'unavailable: Cursor exposes no non-interactive plugin-loading session surface',
      spelling: '${CURSOR_PLUGIN_ROOT}',
    },
    proofLevel: proofLabel,
    skill: '.cursor/plugins/local/host-install-proof/skills/probe/SKILL.md',
    status: 'passed',
  });
  expectHygienicReport(report);
}, 180_000);

it(
  'installs the emitted Agent Plugins 1.0.0 package into an isolated Cursor home and validates it against the pinned spec schemas (filesystem/schema conformance; not an IDE-loading proof)',
  async () => {
    const report = await runPortableHostInstallProof(
      builtPortableFixture(),
      { environment: process.env },
    );

    expect(report, proofLabel).toEqual({
      destination: '.cursor/plugins/local/host-install-portable-proof',
      documents: {
        mcp: 'schema-valid',
        plugin: 'schema-valid',
      },
      hooks: 'not-emitted',
      host: 'cursor',
      install: { first: 'installed', second: 'already-installed', version: '1.0.0' },
      pluginVariables: {
        allowedLocations: 'args/env values/cwd only',
        locations: [
          'mcp.json#/mcpServers/probe/cwd',
          'mcp.json#/mcpServers/probe/env/AGENT_BUNDLE_PLUGIN_ROOT',
        ],
        reservedEnvKeys: 'absent',
        resolvedAtInstall: false,
        sessionEvidence: 'unavailable: Cursor loads Agent Plugins only at restart or window reload; no non-interactive plugin-loading session surface',
      },
      proofLevel: 'host-install (emitted install.mjs + isolated Cursor home filesystem + pinned Agent Plugins 1.0.0 schemas; NOT IDE plugin-loader evidence)',
      proofScope: 'installer+filesystem+pinned-schema conformance against an isolated Cursor home; IDE plugin-loader behavior not observed by this test',
      skill: '.cursor/plugins/local/host-install-portable-proof/skills/probe/SKILL.md',
      specVersion: '1.0.0',
      status: 'passed',
    });
    expectHygienicReport(report);
  },
  180_000,
);
