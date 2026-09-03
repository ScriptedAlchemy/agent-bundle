/**
 * Pinned host CLI versions for the binary-gated real-host proofs
 * (host-install-proof, packed-host-install-proof, packed-native-smoke's
 * Claude plugin validation, dev-host-install). The pin is the `hostCli` block
 * of each adapter's schema PROVENANCE.json — the same file that records which
 * CLI the pinned schemas were observed against — so bumping the CLI CI runs
 * is the same deliberate edit as re-pinning the schemas, and this script
 * refuses a `hostCli.version` that disagrees with `observedCliVersion`.
 *
 *   print              print the pins (and GITHUB_OUTPUT entries when set)
 *   install [--prefix] `npm install -g` the pinned packages
 *   verify             fail closed when `claude`/`codex --version` on PATH
 *                      is not the pin — one diagnostic line per host
 */
import { execFile as executeFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const hostCliHosts = Object.freeze(['claude', 'codex']);

export const hostCliProvenancePaths = Object.freeze({
  claude: 'packages/agent-bundle/src/adapters/schemas/claude/PROVENANCE.json',
  codex: 'packages/agent-bundle/src/adapters/schemas/codex/PROVENANCE.json',
});

const isNonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Validates one PROVENANCE document's `hostCli` block against its
 * `observedCliVersion`; the two must agree so a CLI bump cannot land without
 * re-recording what the schemas were observed against.
 */
export const hostCliPinFromProvenance = (host, provenancePath, document) => {
  const hostCli = document?.hostCli;
  const observed = document?.observedCliVersion;
  if (!isNonemptyString(observed)) {
    throw new Error(`${provenancePath} has no observedCliVersion; the ${host} CLI pin needs one.`);
  }
  if (hostCli === null || typeof hostCli !== 'object' || Array.isArray(hostCli)) {
    throw new Error(`${provenancePath} has no hostCli block; the ${host} CLI pin needs { package, version }.`);
  }
  if (!isNonemptyString(hostCli.package)) {
    throw new Error(`${provenancePath} hostCli.package must be a nonempty npm package name.`);
  }
  if (!isNonemptyString(hostCli.version) || !/^\d+\.\d+\.\d+$/u.test(hostCli.version)) {
    throw new Error(`${provenancePath} hostCli.version must be an exact semantic version.`);
  }
  if (hostCli.version !== observed) {
    throw new Error(
      `${provenancePath} pins hostCli.version ${hostCli.version} but observedCliVersion is ${observed}; `
      + 'bump both together after re-observing the schemas against the new CLI.',
    );
  }
  return Object.freeze({
    host,
    package: hostCli.package,
    provenancePath,
    version: hostCli.version,
  });
};

export const readHostCliPins = async (root = repositoryRoot) => {
  const entries = await Promise.all(hostCliHosts.map(async (host) => {
    const provenancePath = hostCliProvenancePaths[host];
    const document = JSON.parse(await readFile(join(root, provenancePath), 'utf8'));
    return [host, hostCliPinFromProvenance(host, provenancePath, document)];
  }));
  return Object.freeze(Object.fromEntries(entries));
};

/** Same shape the proofs accept from `claude --version` / `codex --version`. */
export const parseCliVersion = (stdout) => /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(stdout)?.[1];

/**
 * One line per host. `probe(host)` resolves to the `--version` result; an
 * `error` field (spawn failure) or a nonzero exit counts as missing.
 */
export const verifyHostCliPins = async (pins, probe) => {
  const results = [];
  for (const host of hostCliHosts) {
    const pin = pins[host];
    const probed = await probe(host);
    const remedy = `install ${pin.package}@${pin.version} or bump hostCli.version and observedCliVersion in ${pin.provenancePath} deliberately`;
    if (probed.error !== undefined || probed.exitCode !== 0) {
      const detail = probed.error !== undefined
        ? String(probed.error.message ?? probed.error)
        : (probed.stderr?.trim() || probed.stdout?.trim() || `exit code ${String(probed.exitCode)}`);
      results.push(Object.freeze({
        host,
        line: `host-cli pin unmet: \`${host} --version\` failed on PATH (${detail}); ${remedy}.`,
        status: 'missing',
      }));
      continue;
    }
    const installed = parseCliVersion(probed.stdout ?? '');
    if (installed === undefined) {
      results.push(Object.freeze({
        host,
        line: `host-cli pin unmet: \`${host} --version\` printed no semantic version (${(probed.stdout ?? '').trim()}); ${remedy}.`,
        status: 'missing',
      }));
      continue;
    }
    if (installed !== pin.version) {
      results.push(Object.freeze({
        host,
        installed,
        line: `host-cli pin mismatch: ${host} on PATH is ${installed} but ${pin.provenancePath} pins ${pin.package}@${pin.version}; ${remedy}.`,
        status: 'mismatch',
      }));
      continue;
    }
    results.push(Object.freeze({
      host,
      installed,
      line: `host-cli pin ok: ${host} ${installed} (${pin.package}@${pin.version})`,
      status: 'match',
    }));
  }
  return Object.freeze({
    ok: results.every((result) => result.status === 'match'),
    results: Object.freeze(results),
  });
};

/**
 * Cache-key identity of the pins: a readable `host-package-version` prefix per
 * host (characters outside actions/cache's safe set collapse to `-`) plus a
 * short SHA-256 of the exact, unsanitised `package@version` pairs, so a
 * deliberate re-pin misses the cache even when two package names normalise to
 * the same readable text (`@foo/bar` vs `foo-bar`).
 */
export const pinsCacheKey = (pins) => {
  const readable = hostCliHosts
    .flatMap((host) => [host, pins[host].package, pins[host].version])
    .map((part) => part.replaceAll(/[^A-Za-z0-9._-]+/gu, '-').replaceAll(/^-+|-+$/gu, ''))
    .join('-');
  const exact = createHash('sha256')
    .update(hostCliHosts.map((host) => `${host}=${pins[host].package}@${pins[host].version}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `${readable}-${exact}`;
};

/**
 * Where npm places global executables for a prefix: `<prefix>/bin` on POSIX,
 * the prefix itself on Windows (https://docs.npmjs.com/cli/configuring-npm/folders#executables).
 */
export const globalBinDirectory = (globalPrefix, platform = process.platform) =>
  platform === 'win32' ? globalPrefix : join(globalPrefix, 'bin');

/** `npm install -g` argument vector for the pinned packages. */
export const installArguments = (pins, prefix) => Object.freeze([
  'install',
  '-g',
  '--no-fund',
  '--no-audit',
  ...(prefix === undefined ? [] : ['--prefix', prefix]),
  ...hostCliHosts.map((host) => `${pins[host].package}@${pins[host].version}`),
]);

const probeOnPath = async (host, environment) => {
  try {
    const result = await execFile(host, ['--version'], { encoding: 'utf8', env: environment, timeout: 30_000 });
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    if (typeof error?.code === 'number') {
      return { exitCode: error.code, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
    }
    return { error };
  }
};

const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const options = { command, prefix: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--prefix') {
      options.prefix = rest[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
};

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const runNpm = async (args, environment) => {
  const result = await execFile(npm, args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600_000,
  });
  return result.stdout;
};

/**
 * Installs the pins, then makes sure Claude Code's native binary is linked:
 * its postinstall (`install.cjs`) is what links the platform package, and
 * npm 12+ blocks install scripts that are not on `allowScripts`, so a blocked
 * postinstall leaves `claude --version` failing until it is run by hand.
 */
const installPins = async (pins, prefix, environment) => {
  process.stdout.write(`npm ${installArguments(pins, prefix).join(' ')}\n`);
  await runNpm([...installArguments(pins, prefix)], environment);
  const prefixArguments = prefix === undefined ? [] : ['--prefix', prefix];
  const globalPrefix = (await runNpm(['prefix', '-g', ...prefixArguments], environment)).trim();
  const globalRoot = (await runNpm(['root', '-g', ...prefixArguments], environment)).trim();
  const binDirectory = globalBinDirectory(globalPrefix);
  const pathWithPrefix = `${binDirectory}${process.platform === 'win32' ? ';' : ':'}${environment.PATH ?? ''}`;
  const probeEnvironment = { ...environment, PATH: pathWithPrefix };
  const claude = await probeOnPath('claude', probeEnvironment);
  if (claude.exitCode !== 0) {
    const postinstall = join(globalRoot, pins.claude.package, 'install.cjs');
    process.stdout.write(`claude postinstall did not run (npm blocked it); running node ${postinstall}\n`);
    await execFile(process.execPath, [postinstall], { encoding: 'utf8', env: environment, timeout: 300_000 });
  }
  const verified = await verifyHostCliPins(pins, (host) => probeOnPath(host, probeEnvironment));
  for (const result of verified.results) process.stdout.write(`${result.line}\n`);
  if (!verified.ok) process.exitCode = 1;
  process.stdout.write(`host-cli bin directory: ${binDirectory}\n`);
};

export const runHostCliPins = async ({
  argv = process.argv.slice(2),
  env = process.env,
  root = repositoryRoot,
} = {}) => {
  const options = parseArgs(argv);
  const pins = await readHostCliPins(root);
  switch (options.command) {
    case 'print': {
      const lines = hostCliHosts.map((host) => `${host}=${pins[host].version}`);
      lines.push(`pins=${pinsCacheKey(pins)}`);
      for (const line of lines) process.stdout.write(`${line}\n`);
      const githubOutput = env.GITHUB_OUTPUT;
      if (githubOutput !== undefined && githubOutput.length > 0) {
        await appendFile(githubOutput, `${lines.join('\n')}\n`);
      }
      return pins;
    }
    case 'install': {
      await installPins(pins, options.prefix, env);
      return pins;
    }
    case 'verify': {
      const verified = await verifyHostCliPins(pins, (host) => probeOnPath(host, env));
      for (const result of verified.results) process.stdout.write(`${result.line}\n`);
      if (!verified.ok) process.exitCode = 1;
      return pins;
    }
    default:
      throw new Error('Usage: node scripts/host-cli-pins.mjs <print|install [--prefix <dir>]|verify>');
  }
};

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await runHostCliPins();
}
