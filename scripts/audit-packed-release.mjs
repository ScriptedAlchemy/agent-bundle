import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { npmCliInvocation } from './npm-cli.mjs';

const execFile = promisify(executeFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(repositoryRoot, 'packages', 'agent-bundle');
const { NODE_PATH: _nodePath, ...productionEnvironment } = process.env;
const npmCli = npmCliInvocation(productionEnvironment);
const execNpm = (args, options) => execFile(npmCli.command, [...npmCli.args, ...args], options);

const fail = (message) => {
  throw new Error(`Invalid packed release audit: ${message}`);
};

const asRecord = (value, message) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(message);
  return value;
};

const asString = (value, message) => {
  if (typeof value !== 'string' || value.length === 0) fail(message);
  return value;
};

const packOutputFromJson = (stdout) => {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? Object.values(parsed)
      : undefined;
  if (entries === undefined) fail('npm pack --json returned neither an array nor a package-keyed object');
  if (entries.length !== 1) {
    fail(`npm pack --json returned ${String(entries.length)} entries; expected exactly one`);
  }
  const [entry] = entries;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('npm pack --json returned an invalid pack entry; expected one object');
  }
  return entry;
};

/** Every name -> Set(version) reachable under the consumer's own node_modules tree. */
const collectInstalledPackages = async (nodeModulesRoot) => {
  const installed = new Map();
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.cache') continue;
      const child = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        await walk(child);
        continue;
      }
      try {
        const manifest = JSON.parse(await readFile(join(child, 'package.json'), 'utf8'));
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
          const versions = installed.get(manifest.name) ?? new Set();
          versions.add(manifest.version);
          installed.set(manifest.name, versions);
        }
      } catch {
        // A directory without a readable manifest is not an installed package.
      }
      await walk(join(child, 'node_modules'));
    }
  };
  await walk(nodeModulesRoot);
  return installed;
};

const validateSbom = (sbom, productManifest, installedPackages) => {
  const document = asRecord(sbom, 'document must be an object');
  if (document.bomFormat !== 'CycloneDX') fail('bomFormat must be CycloneDX');
  asString(document.specVersion, 'specVersion is required');

  const metadata = asRecord(document.metadata, 'metadata is required');
  const root = asRecord(metadata.component, 'metadata.component is required');
  if (root.name === productManifest.name || root.version !== '1.0.0') {
    fail('metadata.component must describe the external production consumer');
  }
  const rootReference = asString(root['bom-ref'], 'metadata.component bom-ref is required');

  if (!Array.isArray(document.components)) fail('components must be an array');
  const components = document.components.map((component, index) => asRecord(component, `component ${index} must be an object`));
  const componentReferences = new Set(components.map((component, index) => (
    asString(component['bom-ref'], `component ${index} bom-ref is required`)
  )));
  const product = components.find((component) => (
    component.name === productManifest.name && component.version === productManifest.version
  ));
  if (product === undefined) fail(`missing installed ${productManifest.name}@${productManifest.version} component`);
  const productReference = asString(product['bom-ref'], 'installed product bom-ref is required');

  for (const [index, component] of components.entries()) {
    if (component.scope === 'development') fail(`component ${index} has development scope`);
    if (!Array.isArray(component.properties)) fail(`component ${index} is missing npm package path metadata`);
    const packagePath = component.properties.find((property) => (
      asRecord(property, `component ${index} property must be an object`).name === 'cdx:npm:package:path'
    ))?.value;
    if (packagePath !== undefined) {
      const path = asString(packagePath, `component ${index} has an invalid npm package path`);
      if (!path.startsWith('node_modules/') || path.includes('node_modules/.pnpm/') || path.includes('/packages/')) {
        fail(`component ${index} is not installed from the external production consumer`);
      }
      continue;
    }
    // npm >= 11 omits cdx:npm:package:path, so the same guarantee is checked
    // against the packages physically installed in the consumer's node_modules.
    const name = asString(component.name, `component ${index} name is required`);
    const version = asString(component.version, `component ${index} version is required`);
    if (installedPackages.get(name)?.has(version) !== true) {
      fail(`component ${index} (${name}@${version}) is not installed in the external production consumer`);
    }
  }

  if (!Array.isArray(document.dependencies)) fail('dependencies must be an array');
  const knownReferences = new Set([rootReference, ...componentReferences]);
  const dependencies = document.dependencies.map((dependency, index) => asRecord(dependency, `dependency ${index} must be an object`));
  const declaredReferences = new Set();
  for (const [index, dependency] of dependencies.entries()) {
    const reference = asString(dependency.ref, `dependency ${index} ref is required`);
    if (!knownReferences.has(reference)) fail(`dependency ${index} has an unknown ref`);
    declaredReferences.add(reference);
    if (dependency.dependsOn !== undefined && !Array.isArray(dependency.dependsOn)) {
      fail(`dependency ${index} dependsOn must be an array`);
    }
    for (const dependencyReference of dependency.dependsOn ?? []) {
      if (!knownReferences.has(asString(dependencyReference, `dependency ${index} contains an invalid dependency ref`))) {
        fail(`dependency ${index} contains an unknown dependency ref`);
      }
    }
  }
  for (const reference of knownReferences) {
    if (!declaredReferences.has(reference)) fail(`dependency closure is missing ${reference}`);
  }

  const rootDependencies = dependencies.find((dependency) => dependency.ref === rootReference);
  if (!rootDependencies?.dependsOn?.includes(productReference)) {
    fail('external production consumer must depend on the packed product');
  }
  const productDependencies = dependencies.find((dependency) => dependency.ref === productReference);
  if (productDependencies?.dependsOn?.length === 0 || productDependencies === undefined) {
    fail('packed product dependency closure is missing');
  }
};

const auditPackedRelease = async () => {
  const auditRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-release-audit-'));

  try {
    const tarballs = join(auditRoot, 'tarballs');
    const consumer = join(auditRoot, 'consumer');
    await Promise.all([mkdir(tarballs), mkdir(consumer)]);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      name: 'agent-bundle-release-sbom-consumer',
      private: true,
      version: '1.0.0',
    }) + '\n');

    const { filename } = packOutputFromJson((await execNpm([
      'pack',
      '--json',
      '--pack-destination', tarballs,
    ], { cwd: packageRoot, env: productionEnvironment })).stdout);
    const tarball = join(tarballs, asString(filename, 'npm pack did not produce a tarball filename'));
    // No `--prefer-offline` here (unlike the packed pool's
    // cachedNpmInstallArguments): the tree this install produces is what
    // `npm audit`, `npm audit signatures`, and `npm sbom` below report on, so
    // it has to resolve against live registry metadata rather than whatever
    // the cache last saw.
    await execNpm([
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ], { cwd: consumer, env: productionEnvironment });

    await execFile('npm', ['ls', '--omit=dev', '--json'], {
      cwd: consumer,
      env: productionEnvironment,
    });
    await execFile('npm', ['audit', '--omit=dev', '--json'], {
      cwd: consumer,
      env: productionEnvironment,
    });
    await execFile('npm', ['audit', 'signatures', '--json'], {
      cwd: consumer,
      env: productionEnvironment,
    });

    const productManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const sbom = JSON.parse((await execNpm([
      'sbom',
      '--omit=dev',
      '--sbom-format', 'cyclonedx',
    ], { cwd: consumer, env: productionEnvironment })).stdout);
    const installedPackages = await collectInstalledPackages(join(consumer, 'node_modules'));
    validateSbom(sbom, productManifest, installedPackages);
    process.stdout.write(`${JSON.stringify(sbom)}\n`);
  } finally {
    await rm(auditRoot, { force: true, recursive: true });
  }
};

await auditPackedRelease();
