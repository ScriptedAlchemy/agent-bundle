import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { resolveNpmCliJs, type NpmCliResolutionIo } from './support/npm-cli.ts';

const io = (options: {
  readonly delimiter?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly files: Readonly<Record<string, string | true>>;
}): NpmCliResolutionIo => ({
  delimiter: options.delimiter ?? ':',
  env: options.env ?? {},
  execPath: options.execPath,
  exists: (candidate) => candidate in options.files,
  realpath: (candidate) => {
    const target = options.files[candidate];
    if (target === undefined) throw new Error(`ENOENT: ${candidate}`);
    return target === true ? candidate : target;
  },
});

it('resolves the official Windows layout beside node.exe', () => {
  const nodeDir = join('C:', 'Program Files', 'nodejs');
  const execPath = join(nodeDir, 'node.exe');
  const cli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  expect(resolveNpmCliJs(io({
    execPath,
    files: {
      [cli]: true,
      [join(nodeDir, 'npm.cmd')]: true,
    },
  }))).toBe(cli);
});

it('resolves the nvm Unix layout from bin/node and the bin/npm symlink', () => {
  const prefix = join('/home', 'u', '.nvm', 'versions', 'node', 'v22.19.0');
  const execPath = join(prefix, 'bin', 'node');
  const cli = join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const shim = join(prefix, 'bin', 'npm');
  expect(resolveNpmCliJs(io({
    execPath,
    files: {
      [cli]: true,
      [shim]: cli,
    },
  }))).toBe(cli);
});

it('finds npm-cli.js on PATH when process.execPath has no npm tree', () => {
  const orphan = join('/pnpm', 'nodejs', 'bin', 'node');
  const pathBin = join('/usr', 'local', 'bin');
  const cli = join('/usr', 'local', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  expect(resolveNpmCliJs(io({
    env: { PATH: pathBin },
    execPath: orphan,
    files: {
      [cli]: true,
      [join(pathBin, 'npm')]: cli,
    },
  }))).toBe(cli);
});

it('ignores npm_execpath when it is a Windows cmd shim, not npm-cli.js', () => {
  const nodeDir = join('C:', 'Program Files', 'nodejs');
  const execPath = join(nodeDir, 'node.exe');
  const cli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cmd = join(nodeDir, 'npm.cmd');
  expect(resolveNpmCliJs(io({
    env: { npm_execpath: cmd },
    execPath,
    files: { [cli]: true, [cmd]: true },
  }))).toBe(cli);
});

it('does not assume npm is a resolvable package from createRequire', () => {
  expect(() => resolveNpmCliJs(io({
    env: { PATH: '' },
    execPath: join('/pnpm', 'nodejs', 'bin', 'node'),
    files: {},
  }))).toThrow(/Unable to resolve npm-cli\.js from /u);
});
