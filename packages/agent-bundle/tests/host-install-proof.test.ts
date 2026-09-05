import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import {
  buildHostInstallFixture,
  buildPortableHostInstallFixture,
  disposeHostInstallFixture,
  expectedCodexInterfaceFields,
  runInstalledHostContractMatrixProof,
  runClaudeHostInstallProof,
  runCodexHostInstallProof,
  runCursorHostInstallProof,
  runHostUninstallProof,
  runPortableHostInstallProof,
  runPortableUninstallProof,
  type BuiltHostInstallFixture,
  type BuiltPortableHostInstallFixture,
} from './support/host-install.ts';
import { AgentTestError } from '../src/test/errors.ts';
import { stableJson } from '../src/core/digest.ts';
import {
  HOST_INSTALL_PROOF_LEVEL,
  proofLevelLabel,
} from '../src/test/manifest.ts';

const proofLabel = proofLevelLabel(HOST_INSTALL_PROOF_LEVEL);
const simulatedProofLabel =
  'simulated (adapter-simulated discovery and stdio spawn from an isolated installed root; NOT host-install evidence)';
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
let mcpOnlyFixture: BuiltHostInstallFixture | undefined;
let portableFixture: BuiltPortableHostInstallFixture | undefined;

beforeAll(async () => {
  [fixture, mcpOnlyFixture, portableFixture] = await Promise.all([
    buildHostInstallFixture({ environment: process.env }),
    buildHostInstallFixture({
      environment: process.env,
      prepareProject: async (projectRoot) => {
        await writeFile(join(projectRoot, 'agent-bundle.config.ts'), [
          'export default {',
          '  marketplace: true,',
          '  mcp: { servers: { probe: {} } },',
          '  plugin: {',
          "    description: 'Proves an MCP-only installed host artifact.',",
          "    name: 'host-install-mcp-only-proof',",
          "    version: '1.0.0',",
          '  },',
          '  routes: { mcpCommands: true },',
          "  targets: ['claude', 'codex', 'cursor'],",
          '};',
          '',
        ].join('\n'));
      },
    }),
    buildPortableHostInstallFixture({ environment: process.env }),
  ]);
}, 180_000);

afterAll(async () => {
  await Promise.all([
    fixture === undefined ? Promise.resolve() : disposeHostInstallFixture(fixture),
    mcpOnlyFixture === undefined ? Promise.resolve() : disposeHostInstallFixture(mcpOnlyFixture),
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

const builtMcpOnlyFixture = (): BuiltHostInstallFixture => {
  if (mcpOnlyFixture === undefined) {
    throw new Error(`[${simulatedProofLabel}] MCP-only fixture build did not complete.`);
  }
  return mcpOnlyFixture;
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
      checks: {
        'runtime-instance-identity': {
          reason: 'the compiled manifest declares no event routes, so this boundary has no event runtime.',
          status: 'not-applicable',
        },
      },
      provenance: { host: 'claude', proofLevel: 'simulated' },
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
    proofLevel: simulatedProofLabel,
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

it('does not execute a tampered installed MCP command after static integrity checks fail', async () => {
  const markerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-tampered-command-'));
  const marker = join(markerRoot, 'executed');
  try {
    const error = await runInstalledHostContractMatrixProof(builtFixture(), {
      environment: process.env,
      fixtures: {
        'tool:probe/echo': { input: { message: 'installed host' }, resultCompat: 'additive' },
      },
      host: 'claude',
      mode: 'adapter-simulator',
      mutateInstalled: async (installedRoot) => {
        const commandPath = join(markerRoot, 'tampered-command.sh');
        await writeFile(commandPath, [
          '#!/bin/sh',
          `printf executed > ${JSON.stringify(marker)}`,
          `exec ${JSON.stringify(process.execPath)} "$@"`,
          '',
        ].join('\n'), { mode: 0o755 });
        const mcpPath = join(installedRoot, '.mcp.json');
        const mcp = JSON.parse(await readFile(mcpPath, 'utf8')) as {
          mcpServers: Record<string, Record<string, unknown>>;
        };
        await writeFile(mcpPath, `${JSON.stringify({
          ...mcp,
          mcpServers: {
            ...mcp.mcpServers,
            probe: { ...mcp.mcpServers.probe, command: commandPath },
          },
        })}\n`);
      },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).message).toContain('version-digests');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(markerRoot, { force: true, recursive: true });
  }
}, 180_000);

it('accepts an installed artifact whose manifest declares no resource components', async () => {
  const cloneParent = await mkdtemp(join(tmpdir(), 'agent-bundle-resource-free-'));
  const cloneRoot = join(cloneParent, 'fixture');
  try {
    await cp(builtFixture().root, cloneRoot, { recursive: true });
    const artifactRoot = join(cloneRoot, 'project', 'artifact');
    const artifactManifestPath = join(artifactRoot, 'agent-bundle.manifest.json');
    const artifactManifest = JSON.parse(await readFile(artifactManifestPath, 'utf8')) as {
      readonly files: readonly { readonly path: string }[];
    };
    // Resource directories sit at the top of the one plugin root (#555).
    await writeFile(artifactManifestPath, `${stableJson({
      ...artifactManifest,
      files: artifactManifest.files.filter((file) =>
        !/^(?:assets|commands|skills)\//u.test(file.path)),
    })}\n`);
    const clonedFixture: BuiltHostInstallFixture = Object.freeze({
      artifactRoot,
      bundles: Object.freeze({ claude: artifactRoot, codex: artifactRoot, cursor: artifactRoot }),
      cli: builtFixture().cli,
      root: cloneRoot,
    });
    const report = await runInstalledHostContractMatrixProof(clonedFixture, {
      environment: process.env,
      fixtures: {
        'tool:probe/echo': { input: { message: 'resource-free installed host' }, resultCompat: 'additive' },
      },
      host: 'claude',
      mode: 'adapter-simulator',
    });

    expect(report.checks.resources).toEqual({ status: 'passed' });
  } finally {
    await rm(cloneParent, { force: true, recursive: true });
  }
}, 180_000);

it('accepts an installed MCP-only artifact with no declared hooks', async () => {
  const report = await runInstalledHostContractMatrixProof(builtMcpOnlyFixture(), {
    environment: process.env,
    fixtures: {
      'tool:probe/echo': { input: { message: 'MCP-only installed host' }, resultCompat: 'additive' },
    },
    host: 'claude',
    mode: 'adapter-simulator',
  });

  expect(report.checks['hook-commands']).toEqual({ status: 'passed' });
  expect(report.proofLevel).toBe(simulatedProofLabel);
}, 180_000);

it('fails closed when an installed manifest drifts from the built artifact', async () => {
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
  expect((error as AgentTestError).message).toContain(simulatedProofLabel);
}, 180_000);

claudePluginIt(
  claudeAvailable
    ? 'installs through Claude and observes the host-owned component inventory'
    : `installs through Claude and observes the host-owned component inventory [${claudeMissingEvidence}]`,
  async () => {
    const report = await runClaudeHostInstallProof(builtFixture(), { environment: process.env });

    expect(report, proofLabel).toEqual({
      host: 'claude',
      install: { sameVersionRebuild: 'replaced', state: 'installed', version: '1.0.0' },
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
      install: { sameVersionRebuild: 'replaced', state: 'installed', version: '1.0.0' },
      manifest: {
        interfaceCapabilities: ['hooks', 'mcp', 'skills'],
        interfaceFields: [...expectedCodexInterfaceFields],
        matchesBuiltArtifact: true,
        path: '.codex-plugin/plugin.json',
        schema: 'schema-valid',
      },
      proofLevel: proofLabel,
      registration: {
        cachePath: 'plugins/cache/host-install-proof-marketplace/host-install-proof/1.0.0',
        state: 'installed, enabled',
        version: '1.0.0',
      },
      skill: 'plugins/cache/host-install-proof-marketplace/host-install-proof/1.0.0/skills/probe/SKILL.md',
      // One root shares a portable SKILL.md with every host (#555): no Codex sidecar.
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
    hooksRegistration: { events: ['sessionStart'], state: 'registered', userHooksJson: 'absent' },
    host: 'cursor',
    install: { first: 'installed', sameVersionRebuild: 'replaced', second: 'already-installed', version: '1.0.0' },
    logo: {
      path: './assets/docs/media/logo.svg',
      resolvesInsideDeployTree: true,
    },
    marketplace: {
      commit: 'git-sha',
      first: 'staged',
      imported: false,
      manifest: 'marketplace.json lists the plugin',
      repository: '.cursor/agent-bundle/marketplaces/host-install-proof',
      second: 'already-staged',
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
    unifiedBundle: {
      hooksDocument: 'hooks/hooks-cursor.json',
      hooksRegistration: 'registered',
      install: 'installed',
      staticFindings: { AB6027: 0, AB7320: 0 },
    },
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
      contract: 'agent-plugins-1.0.0 byte lane clean (AB6035–AB6037)',
      destination: '.cursor/plugins/local/host-install-portable-proof',
      documents: {
        mcp: 'schema-valid',
        plugin: 'schema-valid',
      },
      hooks: 'not-emitted',
      host: 'cursor',
      install: { first: 'installed', sameVersionRebuild: 'replaced', second: 'already-installed', version: '1.0.0' },
      manifestMetadata: 'author/homepage/repository/license/keywords/extensions emitted from portable config',
      pluginVariables: {
        allowedLocations: 'args/env values/cwd only',
        cursorExpansion: {
          doctor: 'AB7326 expanded',
          installedCopy: 'PLUGIN_ROOT/PLUGIN_DATA absolute, cwd = plugin root, PLUGIN_ROOT/PLUGIN_DATA env set, no placeholder left',
          pluginData: '.cursor/agent-bundle/plugin-data/host-install-portable-proof',
          receipt: 'cursorExpansion records the bundle mcp.json verbatim',
        },
        locations: [
          'mcp.json#/mcpServers/probe/cwd',
          'mcp.json#/mcpServers/probe/env/AGENT_BUNDLE_PLUGIN_ROOT',
        ],
        reservedEnvKeys: 'absent',
        resolvedAtInstall: true,
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

claudePluginIt(
  claudeAvailable
    ? 'uninstalls through Claude by its receipt, leaving only classified host-owned bookkeeping behind'
    : `uninstalls through Claude by its receipt, leaving only classified host-owned bookkeeping behind [${claudeMissingEvidence}]`,
  async () => {
    const report = await runHostUninstallProof(builtFixture(), 'claude', { environment: process.env });

    expect(report, proofLabel).toEqual({
      agentBundleResidue: [],
      // Claude 2.1.257 orphans the cached copy (.orphaned_at, ~14-day grace), keeps its empty registries and
      // settings, and writes session bookkeeping; none of it is Agent Bundle's, all of it is enumerated.
      homeByteIdentical: false,
      host: 'claude',
      hostResidue: [
        'claude-orphaned-cache-copy',
        'claude-plugin-registry-files',
        'claude-session-bookkeeping',
        'claude-settings',
      ],
      keepData: 'retained-by-host',
      plan: 'no-op',
      proofLevel: proofLabel,
      purgeData: 'purged',
      refusals: { foreignOrMismatch: 'AB7007', missingReceipt: 'AB7009', unconfirmedPurge: 'AB7008' },
      registrations: { 'claude-marketplace': 'removed', 'claude-plugin': 'removed' },
      rerun: 'not-installed',
      status: 'passed',
    });
    expectHygienicReport(report);
  },
  300_000,
);

codexPluginIt(
  codexAvailable
    ? 'uninstalls through Codex by its receipt, leaving only empty host directories and an empty config.toml behind'
    : `uninstalls through Codex by its receipt, leaving only empty host directories and an empty config.toml behind [${codexMissingEvidence}]`,
  async () => {
    const report = await runHostUninstallProof(builtFixture(), 'codex', { environment: process.env });

    expect(report, proofLabel).toEqual({
      agentBundleResidue: [],
      homeByteIdentical: false,
      host: 'codex',
      hostResidue: ['codex-empty-config', 'codex-empty-directories'],
      // codex-cli 0.147.0 deletes the cached tree (state/ included) on `plugin remove` and has no keep-data option.
      keepData: 'unavailable',
      plan: 'no-op',
      proofLevel: proofLabel,
      purgeData: 'removed-by-host',
      refusals: { foreignOrMismatch: 'AB7007', missingReceipt: 'AB7009', unconfirmedPurge: 'AB7008' },
      registrations: { 'codex-marketplace': 'removed', 'codex-plugin': 'removed' },
      rerun: 'not-installed',
      status: 'passed',
    });
    expectHygienicReport(report);
  },
  300_000,
);

it('uninstalls the Cursor local copy by its receipt and leaves the isolated home byte-identical', async () => {
  const report = await runHostUninstallProof(builtFixture(), 'cursor', { environment: process.env });

  expect(report, proofLabel).toEqual({
    agentBundleResidue: [],
    homeByteIdentical: true,
    host: 'cursor',
    hostResidue: [],
    keepData: 'kept',
    plan: 'no-op',
    proofLevel: proofLabel,
    purgeData: 'purged',
    refusals: { foreignOrMismatch: 'AB7007', missingReceipt: 'AB7009', unconfirmedPurge: 'AB7008' },
    registrations: { 'cursor-local-plugin': 'removed' },
    rerun: 'not-installed',
    status: 'passed',
  });
  expectHygienicReport(report);
}, 180_000);

it('uninstalls the emitted Agent Plugins package through install.mjs --uninstall and leaves the isolated home byte-identical', async () => {
  const report = await runPortableUninstallProof(builtPortableFixture(), { environment: process.env });

  expect(report, proofLabel).toEqual({
    homeByteIdentical: true,
    host: 'cursor',
    installer: 'emitted install.mjs --uninstall',
    keepData: 'kept',
    plan: 'no-op',
    proofLevel: 'host-install (emitted install.mjs + isolated Cursor home filesystem + pinned Agent Plugins 1.0.0 schemas; NOT IDE plugin-loader evidence)',
    purgeData: 'purged',
    refusals: { foreign: 'refused', missingReceipt: 'refused', unconfirmedPurge: 'refused' },
    rerun: 'not-installed',
    status: 'passed',
  });
  expectHygienicReport(report);
}, 180_000);
