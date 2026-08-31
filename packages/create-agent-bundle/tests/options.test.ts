import { describe, expect, it } from '@rstest/core';

import {
  UsageError,
  defaultTargets,
  detectPackageManager,
  formatProjectName,
  parseFlags,
  resolveOptions,
  type Prompter,
} from '../src/options.ts';

const unusedPrompter: Prompter = {
  multiselect: () => { throw new Error('multiselect must not be prompted'); },
  select: () => { throw new Error('select must not be prompted'); },
  text: () => { throw new Error('text must not be prompted'); },
};

describe('parseFlags', () => {
  it('reads the directory from the positional argument or --dir', () => {
    expect(parseFlags(['my-plugin']).directory).toBe('my-plugin');
    expect(parseFlags(['--dir', 'other']).directory).toBe('other');
    expect(parseFlags(['-d', 'short']).directory).toBe('short');
  });

  it('parses template, targets, package manager, install, and framework version', () => {
    const flags = parseFlags([
      'my-plugin',
      '--template', 'cli-tool',
      '--targets', 'portable, claude,portable',
      '--package-manager', 'pnpm',
      '--no-install',
      '--framework-version', 'file:/tmp/agent-bundle.tgz',
    ]);
    expect(flags).toMatchObject({
      directory: 'my-plugin',
      frameworkVersion: 'file:/tmp/agent-bundle.tgz',
      install: false,
      packageManager: 'pnpm',
      targets: ['portable', 'claude'],
      template: 'cli-tool',
    });
  });

  it('rejects unknown flags, templates, targets, and package managers', () => {
    expect(() => parseFlags(['--bogus'])).toThrow(UsageError);
    expect(() => parseFlags(['-t', 'fancy'])).toThrow('Unknown template "fancy"');
    expect(() => parseFlags(['--targets', 'portable,web'])).toThrow('Unknown target "web"');
    expect(() => parseFlags(['--targets', ' , '])).toThrow('--targets needs at least one');
    expect(() => parseFlags(['--package-manager', 'cargo'])).toThrow('Unknown package manager "cargo"');
    expect(() => parseFlags(['one', 'two'])).toThrow('at most one directory');
  });
});

describe('formatProjectName', () => {
  it('keeps simple names and takes the basename of paths', () => {
    expect(formatProjectName('foo')).toEqual({ packageName: 'foo', pluginName: 'foo', targetDir: 'foo' });
    expect(formatProjectName('foo/bar/')).toEqual({ packageName: 'bar', pluginName: 'bar', targetDir: 'foo/bar' });
    expect(formatProjectName('./foo/bar')).toEqual({ packageName: 'bar', pluginName: 'bar', targetDir: './foo/bar' });
  });

  it('keeps scoped package names but drops the scope from the plugin name', () => {
    expect(formatProjectName('@scope/tool')).toEqual({
      packageName: '@scope/tool',
      pluginName: 'tool',
      targetDir: '@scope/tool',
    });
  });

  it('sanitizes the plugin name to the safe package-output shape', () => {
    expect(formatProjectName('my plugin!').pluginName).toBe('my-plugin');
    expect(formatProjectName('--weird--').pluginName).toBe('weird');
  });
});

describe('detectPackageManager', () => {
  it('reads the invoking client from the npm user agent', () => {
    expect(detectPackageManager('pnpm/11.23.0 npm/? node/v22.19.0 linux x64')).toBe('pnpm');
    expect(detectPackageManager('yarn/4.5.0 npm/? node/v22.19.0')).toBe('yarn');
    expect(detectPackageManager('npm/11.0.0 node/v22.19.0')).toBe('npm');
  });

  it('defaults to npm for missing or unknown agents', () => {
    expect(detectPackageManager(undefined)).toBe('npm');
    expect(detectPackageManager('cargo/1.0.0')).toBe('npm');
  });
});

describe('resolveOptions', () => {
  it('requires a directory and a template when not interactive', async () => {
    await expect(resolveOptions(parseFlags([]), {
      interactive: false, prompter: unusedPrompter, userAgent: undefined,
    })).rejects.toThrow('A project directory is required');
    await expect(resolveOptions(parseFlags(['my-plugin']), {
      interactive: false, prompter: unusedPrompter, userAgent: undefined,
    })).rejects.toThrow('A template is required');
  });

  it('treats directory + template flags as a scripted run and asks nothing', async () => {
    const resolved = await resolveOptions(parseFlags(['my-plugin', '--template', 'minimal']), {
      interactive: true, prompter: unusedPrompter, userAgent: 'pnpm/11.23.0 npm/? node/v22.19.0',
    });
    expect(resolved).toEqual({
      install: true,
      packageManager: 'pnpm',
      packageName: 'my-plugin',
      pluginName: 'my-plugin',
      targetDir: 'my-plugin',
      targets: defaultTargets,
      template: 'minimal',
    });
  });

  it('prompts for missing values in interactive runs', async () => {
    const asked: string[] = [];
    const prompter: Prompter = {
      multiselect: async (options) => { asked.push(options.message); return ['portable', 'cursor']; },
      select: async (options) => { asked.push(options.message); return 'mcp-server'; },
      text: async (options) => { asked.push(options.message); return '@scope/status-plugin'; },
    };
    const resolved = await resolveOptions(parseFlags([]), { interactive: true, prompter, userAgent: undefined });
    expect(resolved).toMatchObject({
      packageManager: 'npm',
      packageName: '@scope/status-plugin',
      pluginName: 'status-plugin',
      targets: ['portable', 'cursor'],
      template: 'mcp-server',
    });
    expect(asked).toHaveLength(3);
  });

  it('rejects an empty interactive target selection', async () => {
    const prompter: Prompter = {
      ...unusedPrompter,
      multiselect: async () => [],
      select: async () => 'minimal',
      text: async () => 'my-plugin',
    };
    await expect(resolveOptions(parseFlags([]), { interactive: true, prompter, userAgent: undefined }))
      .rejects.toThrow('at least one host target');
  });

  it('respects explicit flags over prompts and detection', async () => {
    const resolved = await resolveOptions(
      parseFlags(['dir', '-t', 'cli-tool', '--targets', 'plugin', '--package-manager', 'bun', '--no-install']),
      { interactive: true, prompter: unusedPrompter, userAgent: 'pnpm/11.23.0' },
    );
    expect(resolved).toMatchObject({
      install: false,
      packageManager: 'bun',
      targets: ['plugin'],
      template: 'cli-tool',
    });
  });
});
