import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import {
  buildHostInstallFixture,
  buildPortableHostInstallFixture,
  disposeHostInstallFixture,
  runInstalledHostContractMatrixProof,
  runClaudeHostInstallProof,
  runCodexHostInstallProof,
  runCursorHostInstallProof,
  runPortableHostInstallProof,
  type BuiltHostInstallFixture,
  type BuiltPortableHostInstallFixture,
} from './support/host-install.ts';
import { AgentTestError } from '../src/test/errors.ts';
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

it('stages a clean adapter-simulated host and runs the shared matrix from its installed layout', async () => {
  const report = await runInstalledHostContractMatrixProof(builtFixture(), {
    environment: process.env,
    fixtures: {
      'tool:probe/echo': { input: { message: 'installed host' }, resultCompat: 'additive' },
    },
    host: 'claude',
    mode: 'adapter-simulator',
  });

  expect(report, proofLabel).toMatchObject({
    checks: {
      'component-paths': { status: 'passed' },
      'hook-commands': { status: 'passed' },
      'manifest-schema': { status: 'passed' },
      'mcp-command': { status: 'passed' },
      resources: { status: 'passed' },
      'version-digests': { status: 'passed' },
      'version-quadruple': { status: 'passed' },
    },
    host: 'claude',
    matrix: {
      provenance: { host: 'claude', proofLevel: 'host-install' },
      routes: {
        'tool:probe/echo': {
          checks: {
            'compat-probe': {
              reason: expect.stringContaining('installed-host sessions cannot load project route modules'),
              status: 'not-applicable',
            },
            'serialized-round-trip': {
              reason: expect.stringContaining('installed-host sessions cannot load project route modules'),
              status: 'not-applicable',
            },
            sweep: { status: 'passed' },
            'version-skew': {
              reason: expect.stringContaining('installed-host sessions cannot load project route modules'),
              status: 'not-applicable',
            },
          },
        },
      },
    },
    metadata: {
      adapterRevision: expect.any(String),
      frameworkVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
      hostBinaryVersion: {
        reason: 'adapter simulator does not invoke a host binary',
        status: 'unavailable',
      },
      manifestSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    },
    proofLevel: proofLabel,
    sessionEvidence: 'adapter-simulated discovery and stdio spawn from an isolated installed root',
    status: 'passed',
    versions: {
      builtArtifact: '1.0.0',
      installedArtifact: '1.0.0',
      runningProcess: '1.0.0',
      source: '1.0.0',
    },
  });
  expect(report.matrix.provenance, proofLabel).toMatchObject({
    entry: expect.not.stringMatching(/^\//u),
  });
  expectHygienicReport(report);
}, 180_000);

it('fails closed when an installed manifest drifts from source, artifact, and running process', async () => {
  const error = await runInstalledHostContractMatrixProof(builtFixture(), {
    environment: process.env,
    fixtures: {
      'tool:probe/echo': { input: { message: 'installed host' }, resultCompat: 'additive' },
    },
    host: 'claude',
    mode: 'adapter-simulator',
    mutateInstalled: async (installedRoot) => {
      const manifestPath = join(installedRoot, '.claude-plugin', 'plugin.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: '9.0.0' })}\n`);
    },
  }).catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(AgentTestError);
  expect((error as AgentTestError).code).toBe('contract-violation');
  expect((error as AgentTestError).message).toContain('version-digests');
  expect((error as AgentTestError).message).toContain('version-quadruple');
  expect((error as AgentTestError).message).toContain(proofLabel);
}, 180_000);

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

    const matrix = await runInstalledHostContractMatrixProof(builtFixture(), {
      environment: process.env,
      fixtures: {
        'tool:probe/echo': { input: { message: 'claude installed host' }, resultCompat: 'additive' },
      },
      host: 'claude',
      mode: 'native-host',
    });
    expect(matrix.versions, proofLabel).toEqual({
      builtArtifact: '1.0.0',
      installedArtifact: '1.0.0',
      runningProcess: '1.0.0',
      source: '1.0.0',
    });
    expect(matrix.metadata.hostBinaryVersion, proofLabel).toEqual({
      status: 'observed',
      value: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
    });
    expectHygienicReport(matrix);
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

    const matrix = await runInstalledHostContractMatrixProof(builtFixture(), {
      environment: process.env,
      fixtures: {
        'tool:probe/echo': { input: { message: 'codex installed host' }, resultCompat: 'additive' },
      },
      host: 'codex',
      mode: 'native-host',
    });
    expect(matrix.versions, proofLabel).toEqual({
      builtArtifact: '1.0.0',
      installedArtifact: '1.0.0',
      runningProcess: '1.0.0',
      source: '1.0.0',
    });
    expect(matrix.metadata.hostBinaryVersion, proofLabel).toEqual({
      status: 'observed',
      value: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
    });
    expectHygienicReport(matrix);
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

  const matrix = await runInstalledHostContractMatrixProof(builtFixture(), {
    environment: process.env,
    fixtures: {
      'tool:probe/echo': { input: { message: 'cursor installed host' }, resultCompat: 'additive' },
    },
    host: 'cursor',
    mode: 'native-host',
  });
  expect(matrix.versions, proofLabel).toEqual({
    builtArtifact: '1.0.0',
    installedArtifact: '1.0.0',
    runningProcess: '1.0.0',
    source: '1.0.0',
  });
  expect(matrix.sessionEvidence, proofLabel).toBe(
    'unavailable: Cursor exposes no non-interactive plugin-loading session surface; adapter-simulated stdio spawn from isolated installed root',
  );
  expectHygienicReport(matrix);
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
