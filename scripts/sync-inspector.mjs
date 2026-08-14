#!/usr/bin/env node

import { execFile as executeFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const DEFAULT_REPOSITORY = 'https://github.com/modelcontextprotocol/inspector.git';
const DEFAULT_OUTPUT = 'packages/workbench/src/inspector';
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json'];

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');

const usage = () => `Usage: node scripts/sync-inspector.mjs [options]

Maintainer-only command. It is the only Inspector workflow that may access the
network; install, build, and dev only consume its checked-in snapshot.

  --commit <sha>               Required upstream commit.
  --version <version>          Required upstream release version.
  --source <directory>         Existing checkout (no network access).
  --repository <url>           Upstream git repository.
  --out <directory>            Inspector snapshot directory.
  --entry <path>               Root source file (repeatable).
  --test <path>                Retained upstream test root (repeatable).
  --test-dependency <package>  Allowed retained-test-only package (repeatable).
  --dependency <package>       Allowed direct dependency package (repeatable).
  --public-import <specifier>  Allowed documented package subpath (repeatable).
  --alias <name=directory>     Internal source alias (repeatable).
  --license <path>             License path relative to upstream source.
  --mcp-sdk-version <version>  MCP SDK version used by the snapshot.
  --verify                     Verify checked-in digests and import closure only.
`;

const fail = (message) => {
  throw new Error(message);
};

const normalizeRelativePath = (path, label) => {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
    fail(`${label} must stay inside the Inspector source closure: ${path}`);
  }
  return normalized.replace(/^\.\//u, '');
};

const parseAlias = (value) => {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    fail(`--alias must use name=directory, received ${value}`);
  }
  return [value.slice(0, separator), normalizeRelativePath(value.slice(separator + 1), '--alias')];
};

const parseOptions = (argv) => {
  const options = {
    aliases: new Map([
      ['@', 'clients/web/src'],
      ['@inspector/core', 'core'],
    ]),
    commit: undefined,
    dependencies: [],
    entries: [],
    license: 'LICENSE',
    mcpSdkVersion: undefined,
    out: DEFAULT_OUTPUT,
    publicImports: [],
    repository: DEFAULT_REPOSITORY,
    source: undefined,
    testDependencies: [],
    tests: [],
    verify: false,
    version: undefined,
  };
  const repeatable = new Map([
    ['--dependency', 'dependencies'],
    ['--entry', 'entries'],
    ['--public-import', 'publicImports'],
    ['--test-dependency', 'testDependencies'],
    ['--test', 'tests'],
  ]);
  const scalar = new Map([
    ['--commit', 'commit'],
    ['--license', 'license'],
    ['--mcp-sdk-version', 'mcpSdkVersion'],
    ['--out', 'out'],
    ['--repository', 'repository'],
    ['--source', 'source'],
    ['--version', 'version'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (argument === '--verify') {
      options.verify = true;
      continue;
    }
    if (argument === '--alias') {
      const value = argv[index + 1];
      if (!value) fail('--alias requires a value');
      const [name, directory] = parseAlias(value);
      options.aliases.set(name, directory);
      index += 1;
      continue;
    }
    const repeatableKey = repeatable.get(argument);
    if (repeatableKey) {
      const value = argv[index + 1];
      if (!value) fail(`${argument} requires a value`);
      options[repeatableKey].push(value);
      index += 1;
      continue;
    }
    const scalarKey = scalar.get(argument);
    if (scalarKey) {
      const value = argv[index + 1];
      if (!value) fail(`${argument} requires a value`);
      options[scalarKey] = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  return options;
};

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const asPackageName = (specifier) => {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
};

const scanImports = (contents) => {
  const source = contents.toString('utf8');
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /@import\s+(?:url\()?['"]([^'"]+)['"]/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers].sort((left, right) => left.localeCompare(right));
};

const resolveCandidate = async (root, request) => {
  const normalized = normalizeRelativePath(request, 'import');
  const candidates = [normalized];
  const extension = extname(normalized);
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    candidates.push(...SOURCE_EXTENSIONS.map((candidateExtension) =>
      `${normalized.slice(0, -extension.length)}${candidateExtension}`));
  } else if (!extension) {
    candidates.push(...SOURCE_EXTENSIONS.map((candidateExtension) => `${normalized}${candidateExtension}`));
    candidates.push(...SOURCE_EXTENSIONS.map((candidateExtension) => `${normalized}/index${candidateExtension}`));
  }
  for (const candidate of candidates) {
    const absolute = resolve(root, candidate);
    if (relative(root, absolute).startsWith('..')) continue;
    try {
      if ((await stat(absolute)).isFile()) return normalizeRelativePath(relative(root, absolute), 'resolved import');
    } catch {
      // Try the next TypeScript/JavaScript extension candidate.
    }
  }
  fail(`Unable to resolve Inspector import ${request}`);
};

const resolveInternalImport = async ({ aliases, from, root, specifier }) => {
  if (specifier.startsWith('.')) {
    return resolveCandidate(root, join(dirname(from), specifier));
  }
  const alias = [...aliases.keys()].sort((left, right) => right.length - left.length).find((name) =>
    specifier === name || specifier.startsWith(`${name}/`));
  if (!alias) return undefined;
  const suffix = specifier.slice(alias.length).replace(/^\//u, '');
  return resolveCandidate(root, join(aliases.get(alias), suffix));
};

const assertExternalImport = ({ dependencies, publicImports, specifier }) => {
  if (specifier.startsWith('node:')) return;
  const packageName = asPackageName(specifier);
  if (!dependencies.includes(packageName)) {
    fail(`Inspector import ${specifier} is outside the declared dependency closure`);
  }
  if (specifier !== packageName && !publicImports.includes(specifier)) {
    fail(`Inspector import ${specifier} uses a package subpath without an explicit public-import allowlist entry`);
  }
};

const collectClosure = async ({ aliases, dependencies, entries, publicImports, root }) => {
  const pending = [...new Set(entries.map((entry) => normalizeRelativePath(entry, '--entry/--test')))];
  const externalImports = new Set();
  const files = new Map();
  const imports = new Map();

  while (pending.length > 0) {
    const requested = pending.pop();
    const path = await resolveCandidate(root, requested);
    if (files.has(path)) continue;
    const contents = await readFile(join(root, path));
    files.set(path, contents);
    const discovered = scanImports(contents);
    imports.set(path, discovered);
    for (const specifier of discovered) {
      const internal = await resolveInternalImport({ aliases, from: path, root, specifier });
      if (internal) {
        pending.push(internal);
      } else {
        assertExternalImport({ dependencies, publicImports, specifier });
        if (!specifier.startsWith('node:')) externalImports.add(specifier);
      }
    }
  }

  return { externalImports, files, imports };
};

const listFiles = async (root, prefix = '') => {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...(await listFiles(root, path)));
    else if (entry.isFile()) paths.push(normalizeRelativePath(path, 'vendored file'));
  }
  return paths;
};

const patchRecords = async (patchRoot) => {
  if (!(await exists(patchRoot))) return [];
  const entries = await readdir(patchRoot, { withFileTypes: true });
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.patch')) continue;
    const path = join(patchRoot, entry.name);
    records.push({ path: `patches/${entry.name}`, sha256: sha256(await readFile(path)) });
  }
  return records;
};

const applyPatches = async ({ output, patches }) => {
  if (patches.length === 0) return;
  const { stdout } = await execFile('git', ['-C', output, 'rev-parse', '--show-toplevel']);
  const repositoryRoot = stdout.trim();
  const vendorDirectory = relative(repositoryRoot, join(output, 'vendor'));
  if (!vendorDirectory || vendorDirectory.split('/').includes('..')) {
    fail(`Inspector patch output must stay inside its Git worktree: ${output}`);
  }
  for (const patch of patches) {
    await execFile(
      'git',
      ['-C', repositoryRoot, 'apply', '--whitespace=nowarn', '--directory', vendorDirectory, join(output, patch.path)],
    );
  }
};

const checkoutSource = async ({ commit, repository, source }) => {
  if (source) {
    const root = resolve(source);
    if (!(await exists(root))) fail(`--source does not exist: ${root}`);
    if (!(await exists(join(root, '.git')))) {
      fail(`--source must be a Git checkout so its commit can be verified: ${root}`);
    }
    const { stdout } = await execFile('git', ['-C', root, 'rev-parse', 'HEAD']);
    if (stdout.trim() !== commit) {
      fail(`--source is at ${stdout.trim()}, not the required explicit commit ${commit}`);
    }
    return { cleanup: undefined, root };
  }
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-inspector-sync-'));
  try {
    await execFile('git', ['clone', '--filter=blob:none', '--no-checkout', repository, root]);
    await execFile('git', ['-C', root, 'checkout', '--quiet', commit]);
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
  return { cleanup: () => rm(root, { force: true, recursive: true }), root };
};

const readUpstreamMetadata = async (root) => {
  const packagePath = join(root, 'package.json');
  if (!(await exists(packagePath))) fail(`Missing upstream package metadata: ${packagePath}`);
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    fail(`Unable to parse upstream package metadata: ${packagePath}`);
  }
  const version = packageJson?.version;
  const mcpSdkVersion = packageJson?.dependencies?.['@modelcontextprotocol/client'];
  if (typeof version !== 'string' || !version) {
    fail(`Upstream package metadata is missing a release version: ${packagePath}`);
  }
  if (typeof mcpSdkVersion !== 'string' || !mcpSdkVersion) {
    fail(`Upstream package metadata is missing @modelcontextprotocol/client: ${packagePath}`);
  }
  return { mcpSdkVersion, version };
};

const validateManifestImports = async ({ manifest, output }) => {
  const vendorRoot = join(output, 'vendor');
  const declaredPaths = new Set(manifest.files.map((file) => file.path));
  const actualPaths = await listFiles(vendorRoot);
  if (actualPaths.length !== declaredPaths.size || actualPaths.some((path) => !declaredPaths.has(path))) {
    fail('Vendored files differ from the declared Inspector source closure');
  }
  const aliases = new Map(manifest.aliases);
  for (const path of actualPaths) {
    const contents = await readFile(join(vendorRoot, path));
    for (const specifier of scanImports(contents)) {
      const internal = await resolveInternalImport({ aliases, from: path, root: vendorRoot, specifier });
      if (internal) {
        if (!declaredPaths.has(internal)) {
          fail(`Inspector import ${specifier} resolves outside the declared source closure`);
        }
      } else {
        assertExternalImport({
          dependencies: [...manifest.dependencies, ...(manifest.testDependencies ?? [])],
          publicImports: manifest.publicImports,
          specifier,
        });
      }
    }
  }
};

const verifySnapshot = async (output) => {
  const manifestPath = join(output, 'UPSTREAM.json');
  if (!(await exists(manifestPath))) fail(`Missing Inspector provenance: ${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    fail('UPSTREAM.json is not an Inspector sync manifest');
  }
  await validateManifestImports({ manifest, output });
  for (const file of manifest.files) {
    const contents = await readFile(join(output, 'vendor', file.path));
    if (sha256(contents) !== file.sha256) {
      fail(`Vendored digest mismatch: ${file.path}`);
    }
  }
  const license = await readFile(join(output, 'LICENSE.inspector'));
  if (sha256(license) !== manifest.license.sha256) fail('Inspector license digest mismatch');
  const actualPatches = await patchRecords(join(output, 'patches'));
  if (JSON.stringify(actualPatches) !== JSON.stringify(manifest.patches)) {
    fail('Inspector patch records differ from UPSTREAM.json');
  }
  return manifest;
};

const syncSnapshot = async (options) => {
  if (!options.commit || !/^[0-9a-f]{40}$/iu.test(options.commit)) {
    fail('--commit must be an explicit 40-character git commit');
  }
  if (!options.version) fail('--version is required');
  if (!options.mcpSdkVersion) fail('--mcp-sdk-version is required');
  if (options.entries.length === 0) fail('At least one --entry is required');
  if (options.dependencies.length === 0) fail('At least one --dependency is required');

  const output = resolve(options.out);
  const source = await checkoutSource(options);
  try {
    const upstreamMetadata = await readUpstreamMetadata(source.root);
    if (upstreamMetadata.version !== options.version) {
      fail(`upstream package version ${upstreamMetadata.version} does not match --version ${options.version}`);
    }
    if (upstreamMetadata.mcpSdkVersion !== options.mcpSdkVersion) {
      fail(`upstream @modelcontextprotocol/client version ${upstreamMetadata.mcpSdkVersion} does not match --mcp-sdk-version ${options.mcpSdkVersion}`);
    }
    const roots = [...options.entries, ...options.tests];
    const allowedDependencies = [...new Set([...options.dependencies, ...options.testDependencies])].sort();
    const closure = await collectClosure({
      aliases: options.aliases,
      dependencies: allowedDependencies,
      entries: roots,
      publicImports: [...new Set(options.publicImports)].sort(),
      root: source.root,
    });
    const licensePath = normalizeRelativePath(options.license, '--license');
    const upstreamLicensePath = join(source.root, licensePath);
    const fallbackLicensePath = join(output, 'LICENSE.inspector');
    const hasUpstreamLicense = await exists(upstreamLicensePath);
    const license = hasUpstreamLicense
      ? await readFile(upstreamLicensePath)
      : await readFile(fallbackLicensePath);
    const patches = await patchRecords(join(output, 'patches'));

    await rm(join(output, 'vendor'), { force: true, recursive: true });
    await mkdir(join(output, 'vendor'), { recursive: true });
    for (const [path] of [...closure.files].sort(([left], [right]) => left.localeCompare(right))) {
      const sourcePath = join(source.root, path);
      const targetPath = join(output, 'vendor', path);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
    await applyPatches({ output, patches });

    const patchedClosure = await collectClosure({
      aliases: options.aliases,
      dependencies: allowedDependencies,
      entries: roots,
      publicImports: [...new Set(options.publicImports)].sort(),
      root: join(output, 'vendor'),
    });
    const upstreamPaths = [...closure.files.keys()].sort();
    const patchedPaths = [...patchedClosure.files.keys()].sort();
    if (JSON.stringify(patchedPaths) !== JSON.stringify(upstreamPaths)) {
      fail('Inspector patch imports outside the declared source closure');
    }

    const files = await Promise.all([...closure.files.keys()].sort().map(async (path) => {
      const upstream = closure.files.get(path);
      const copied = await readFile(join(output, 'vendor', path));
      return {
        path,
        sha256: sha256(copied),
        upstreamSha256: sha256(upstream),
      };
    }));
    const usedPackages = [...new Set([...patchedClosure.externalImports].map(asPackageName))].sort();
    const testDependencyNames = new Set(options.testDependencies);
    const manifest = {
      aliases: [...options.aliases].sort(([left], [right]) => left.localeCompare(right)),
      commit: options.commit,
      dependencies: usedPackages.filter((dependency) => !testDependencyNames.has(dependency)),
      files,
      license: {
        path: hasUpstreamLicense ? licensePath : 'repository:LICENSE.inspector',
        sha256: sha256(license),
      },
      mcpSdkVersion: upstreamMetadata.mcpSdkVersion,
      patches,
      publicImports: [...patchedClosure.externalImports].filter((specifier) => specifier !== asPackageName(specifier)).sort(),
      repository: options.repository,
      retainedTests: [...new Set(options.tests.map((path) => normalizeRelativePath(path, '--test')))].sort(),
      schemaVersion: 1,
      testDependencies: usedPackages.filter((dependency) => testDependencyNames.has(dependency)),
      version: upstreamMetadata.version,
    };
    await writeFile(join(output, 'LICENSE.inspector'), license);
    await writeFile(join(output, 'UPSTREAM.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifySnapshot(output);
    process.stdout.write(`synced ${files.length} files from ${options.commit}; review with git diff -- ${relative(process.cwd(), output)}\n`);
  } finally {
    await source.cleanup?.();
  }
};

const main = async () => {
  const options = parseOptions(process.argv.slice(2));
  if (options.verify) {
    await verifySnapshot(resolve(options.out));
    process.stdout.write(`verified Inspector snapshot at ${options.out}\n`);
    return;
  }
  await syncSnapshot(options);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
