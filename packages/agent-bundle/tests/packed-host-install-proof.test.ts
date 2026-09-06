import { execFile as executeFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import {
  buildHostInstallFixture,
  disposeHostInstallFixture,
  expectedCodexInterfaceFields,
  runClaudeHostInstallProof,
  runCodexHostInstallProof,
  runCursorHostInstallProof,
  runHostUninstallProof,
  type BuiltHostInstallFixture,
} from './support/host-install.ts';
import {
  installedEnvironment,
  npmInstallArguments,
  packOutputFromJson,
} from './support/shared-pack.ts';
import {
  HOST_INSTALL_PROOF_LEVEL,
  proofLevelLabel,
} from '../src/test/manifest.ts';

const execFile = promisify(executeFile);
const proofLabel = proofLevelLabel(HOST_INSTALL_PROOF_LEVEL);
const packageName = 'host-install-proof-fixture';
const pluginName = 'host-install-proof';
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

let cleanupRoot: string | undefined;
let sourceFixture: BuiltHostInstallFixture | undefined;
let packedFixture: BuiltHostInstallFixture | undefined;
let fixturePackageVersion: string | undefined;

beforeAll(async () => {
  cleanupRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-host-install-'));
  sourceFixture = await buildHostInstallFixture({
    buildCommand: 'prepack',
    environment: process.env,
    prepareProject: async (projectRoot) => {
      const packagePath = join(projectRoot, 'package.json');
      const packageDocument = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
      if (typeof packageDocument.version !== 'string') {
        throw new TypeError(`[${proofLabel}] host-install fixture package has no string version.`);
      }
      fixturePackageVersion = packageDocument.version;
      delete packageDocument.private;
      packageDocument.files = ['README.md'];
      await Promise.all([
        writeFile(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`),
        writeFile(join(projectRoot, '.npmignore'), '.agents/\n.claude-plugin/\n.codex-plugin/\n'),
        writeFile(join(projectRoot, 'README.md'), '# Host install proof fixture\n'),
        writeFile(join(projectRoot, 'src', 'index.ts'), 'export const fixture = true;\n'),
      ]);
      const configPath = join(projectRoot, 'agent-bundle.config.ts');
      const config = await readFile(configPath, 'utf8');
      await writeFile(configPath, config.replace(
        'export default {\n',
        "export default {\n  bin: false,\n  lib: { dts: false, entry: './src/index.ts' },\n",
      ));
    },
  });

  const projectRoot = dirname(sourceFixture.artifactRoot);
  const tarballs = join(cleanupRoot, 'tarballs');
  const consumer = join(cleanupRoot, 'consumer');
  await Promise.all([mkdir(tarballs), mkdir(consumer)]);
  expect(await readdir(consumer), proofLabel).toEqual([]);

  const packed = await execFile(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs],
    { cwd: join(projectRoot, 'dist'), env: installedEnvironment() },
  );
  const packOutput = packOutputFromJson(packed.stdout);
  const tarball = join(tarballs, packOutput.filename);
  await execFile('npm', ['install', ...npmInstallArguments, tarball], {
    cwd: consumer,
    env: installedEnvironment(),
  });

  const installedPackageRoot = join(consumer, 'node_modules', packageName);
  const installedArtifactRoot = join(consumer, 'packed-artifact');
  const manifestName = 'agent-bundle.manifest.json';
  const manifestText = await readFile(join(installedPackageRoot, manifestName), 'utf8');
  const manifest = JSON.parse(manifestText) as {
    readonly distribution: {
      readonly install?: { readonly instructions?: string; readonly script?: string };
    };
    readonly executables: {
      readonly bins: readonly { readonly path: string; readonly worker?: string }[];
      readonly hooks: readonly { readonly path: string }[];
      readonly mcpServers: readonly {
        readonly apps: readonly { readonly path: string }[];
        readonly launch?: { readonly entry: string; readonly worker?: string };
      }[];
      readonly scripts: readonly { readonly path: string; readonly worker?: string }[];
    };
    readonly files: readonly {
      readonly bytes: number;
      readonly mode?: number;
      readonly path: string;
      readonly sha256: string;
    }[];
    readonly projections: readonly {
      readonly documents: Readonly<Record<string, string>>;
    }[];
  };
  const packedPaths = new Set(packOutput.files.map((file) => file.path));
  expect(packedPaths.has(manifestName), proofLabel).toBe(true);
  for (const hiddenRoot of ['.agents/plugins/', '.claude-plugin/', '.codex-plugin/']) {
    expect(
      [...packedPaths].some((path) => path.startsWith(hiddenRoot)),
      `${proofLabel}: selected hidden host root ${hiddenRoot}`,
    ).toBe(true);
  }
  for (const file of manifest.files) {
    expect(packedPaths.has(file.path), `${proofLabel}: packed ${file.path}`).toBe(true);
    const [artifactBytes, installedBytes, installedMetadata] = await Promise.all([
      readFile(join(sourceFixture.artifactRoot, file.path)),
      readFile(join(installedPackageRoot, file.path)),
      stat(join(installedPackageRoot, file.path)),
    ]);
    expect(installedBytes, `${proofLabel}: installed ${file.path}`).toEqual(artifactBytes);
    expect(installedBytes.byteLength, `${proofLabel}: bytes ${file.path}`).toBe(file.bytes);
    expect(createHash('sha256').update(installedBytes).digest('hex'), `${proofLabel}: digest ${file.path}`)
      .toBe(file.sha256);
    if (file.mode !== undefined) {
      expect(installedMetadata.mode & 0o777, `${proofLabel}: mode ${file.path}`).toBe(file.mode);
    }
  }
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  for (const projection of manifest.projections) {
    for (const path of Object.values(projection.documents)) {
      expect(manifestPaths.has(path), `${proofLabel}: projection document ${path}`).toBe(true);
    }
  }
  const executablePaths = [
    ...manifest.executables.bins.flatMap((entry) => [entry.path, entry.worker]),
    ...manifest.executables.hooks.map((entry) => entry.path),
    ...manifest.executables.mcpServers.flatMap((entry) => [
      entry.launch?.entry,
      entry.launch?.worker,
      ...entry.apps.map((app) => app.path),
    ]),
    ...manifest.executables.scripts.flatMap((entry) => [entry.path, entry.worker]),
    manifest.distribution.install?.instructions,
    manifest.distribution.install?.script,
  ].filter((path): path is string => path !== undefined);
  for (const path of executablePaths) {
    expect(manifestPaths.has(path), `${proofLabel}: executable ${path}`).toBe(true);
  }
  for (const forbidden of ['plugin.json', 'mcp.json']) {
    expect(packedPaths.has(forbidden), `${proofLabel}: forbidden discovery ${forbidden}`).toBe(false);
  }
  await mkdir(installedArtifactRoot);
  for (const file of [...manifest.files, { path: manifestName }]) {
    const destination = join(installedArtifactRoot, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(installedPackageRoot, file.path), destination);
  }
  await Promise.all([
    access(join(installedArtifactRoot, '.claude-plugin', 'plugin.json')),
    access(join(installedArtifactRoot, '.codex-plugin', 'plugin.json')),
    access(join(installedArtifactRoot, '.cursor-plugin', 'plugin.json')),
  ]);

  await rm(projectRoot, { force: true, recursive: true });
  await expect(stat(projectRoot), proofLabel).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(projectRoot, 'dist', 'bin', `${pluginName}.mjs`)), proofLabel)
    .rejects.toMatchObject({ code: 'ENOENT' });

  packedFixture = Object.freeze({
    artifactRoot: installedArtifactRoot,
    bundles: Object.freeze({
      claude: installedArtifactRoot,
      codex: installedArtifactRoot,
      cursor: installedArtifactRoot,
    }),
    cli: sourceFixture.cli,
    root: cleanupRoot,
  });
}, 300_000);

afterAll(async () => {
  await Promise.all([
    cleanupRoot === undefined ? Promise.resolve() : rm(cleanupRoot, { force: true, recursive: true }),
    sourceFixture === undefined ? Promise.resolve() : disposeHostInstallFixture(sourceFixture),
  ]);
});

const builtFixture = (): BuiltHostInstallFixture => {
  if (packedFixture === undefined) throw new Error(`[${proofLabel}] packed fixture setup did not complete.`);
  return packedFixture;
};

const expectHygienicReport = (report: unknown): void => {
  expect(JSON.stringify(report), proofLabel).not.toMatch(
    /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|authorization|credential|password|secret|sk-[A-Za-z0-9_-]{16,}|\/home\/|\/Users\/|\/tmp\/|stdout|stderr)/iu,
  );
};

claudePluginIt(
  claudeAvailable
    ? 'installs the packed tarball through Claude and observes the host-owned component inventory'
    : `installs the packed tarball through Claude and observes the host-owned component inventory [${claudeMissingEvidence}]`,
  async () => {
    const report = await runClaudeHostInstallProof(builtFixture(), {
      environment: process.env,
    });

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
    expect(report.registration.version, proofLabel).toBe(fixturePackageVersion);
    expectHygienicReport(report);
  },
  180_000,
);

codexPluginIt(
  codexAvailable
    ? 'installs the packed tarball through Codex and observes enabled registration'
    : `installs the packed tarball through Codex and observes enabled registration [${codexMissingEvidence}]`,
  async () => {
    const report = await runCodexHostInstallProof(builtFixture(), {
      environment: process.env,
    });

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
      skillSidecar: {
        matchesBuiltArtifact: true,
        path: 'skills/probe/agents/openai.yaml',
        schema: 'schema-valid',
        sections: ['dependencies', 'interface', 'policy'],
      },
      status: 'passed',
    });
    expect(report.registration.version, proofLabel).toBe(fixturePackageVersion);
    expectHygienicReport(report);
  },
  180_000,
);

it('installs the packed tarball into an isolated Cursor home, validates schemas, and is idempotent', async () => {
  const report = await runCursorHostInstallProof(builtFixture(), {
    environment: process.env,
  });

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
        '.cursor-plugin/hooks.json#/hooks/sessionStart/0/command',
        '.cursor-plugin/mcp.json#/mcpServers/probe/args/0',
        '.cursor-plugin/mcp.json#/mcpServers/probe/env/AGENT_BUNDLE_PLUGIN_ROOT',
      ],
      resolvedAtInstall: false,
      sessionEvidence: 'unavailable: Cursor exposes no non-interactive plugin-loading session surface',
      spelling: '${CURSOR_PLUGIN_ROOT}',
    },
    proofLevel: proofLabel,
    skill: '.cursor/plugins/local/host-install-proof/skills/probe/SKILL.md',
    status: 'passed',
    unifiedBundle: {
      hooksDocument: '.cursor-plugin/hooks.json',
      hooksRegistration: 'registered',
      install: 'installed',
      staticFindings: { AB6027: 0, AB7320: 0 },
    },
  });
  expect(report.install.version, proofLabel).toBe(fixturePackageVersion);
  expectHygienicReport(report);
}, 180_000);

claudePluginIt(
  claudeAvailable
    ? 'uninstalls the packed tarball through Claude, leaving only host-owned bookkeeping'
    : `uninstalls the packed tarball through Claude, leaving only host-owned bookkeeping [${claudeMissingEvidence}]`,
  async () => {
    const report = await runHostUninstallProof(builtFixture(), 'claude', {
      environment: process.env,
    });
    expect(report, proofLabel).toMatchObject({
      agentBundleResidue: [],
      host: 'claude',
      hostResidue: ['claude-orphaned-cache-copy', 'claude-plugin-registry-files', 'claude-session-bookkeeping', 'claude-settings'],
      registrations: { 'claude-marketplace': 'removed', 'claude-plugin': 'removed' },
      status: 'passed',
    });
    expectHygienicReport(report);
  },
  300_000,
);

codexPluginIt(
  codexAvailable
    ? 'uninstalls the packed tarball through Codex'
    : `uninstalls the packed tarball through Codex [${codexMissingEvidence}]`,
  async () => {
    const report = await runHostUninstallProof(builtFixture(), 'codex', {
      environment: process.env,
    });
    expect(report, proofLabel).toMatchObject({
      agentBundleResidue: [],
      host: 'codex',
      hostResidue: ['codex-empty-config', 'codex-empty-directories'],
      registrations: { 'codex-marketplace': 'removed', 'codex-plugin': 'removed' },
      status: 'passed',
    });
    expectHygienicReport(report);
  },
  300_000,
);

it('uninstalls the packed tarball from an isolated Cursor home and leaves it byte-identical', async () => {
  const report = await runHostUninstallProof(builtFixture(), 'cursor', {
    environment: process.env,
  });
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
