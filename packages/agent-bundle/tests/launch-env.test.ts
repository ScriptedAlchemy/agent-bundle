import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  OPERATOR_ENV_FILE_VARIABLE,
  applyOperatorEnv,
  operatorEnvFilePaths,
  operatorEnvPluginRoot,
  parseOperatorEnv,
} from '../src/launch-env.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-launch-env-'));
  roots.push(root);
  return root;
};

describe('the operator .env layer of an installed pack (#469)', () => {
  it('parses the dotenv grammar the shells accept, without interpolation', () => {
    expect(parseOperatorEnv([
      '# a comment',
      '',
      'PLAIN=value',
      'export EXPORTED=yes',
      'SPACED = padded ',
      'DOUBLE="two\\nlines \\"quoted\\""',
      "SINGLE='keep \\n literally'",
      'BACKTICK=`ticks`',
      'INLINE=value # trailing comment',
      'HASH_IN_QUOTES="a # b"',
      'LITERAL=${NOT_EXPANDED}',
      'MULTI="first',
      'second"',
      'REPEATED=first',
      'REPEATED=second',
      'not a pair',
      '9BAD=ignored',
    ].join('\n'))).toEqual({
      BACKTICK: 'ticks',
      DOUBLE: 'two\nlines "quoted"',
      EXPORTED: 'yes',
      HASH_IN_QUOTES: 'a # b',
      INLINE: 'value',
      LITERAL: '${NOT_EXPANDED}',
      MULTI: 'first\nsecond',
      PLAIN: 'value',
      REPEATED: 'second',
      SINGLE: 'keep \\n literally',
      SPACED: 'padded',
    });
  });

  it('reads an inline comment after a closing quote and keeps a quoted value on one line', () => {
    expect(parseOperatorEnv([
      'TOKEN="s3cr3t" # operator note',
      "SINGLE='one' # note",
      'TICK=`two` # note',
      'ESCAPED="a \\" b" # note',
      'NEXT=still-parsed',
      'TRAILER="x" not-a-comment',
      'OPEN="never closed',
    ].join('\n'))).toEqual({
      ESCAPED: 'a " b',
      NEXT: 'still-parsed',
      // dotenv reads a quoted value followed by anything but a comment as an unquoted literal.
      OPEN: '"never closed',
      SINGLE: 'one',
      TICK: 'two',
      TOKEN: 's3cr3t',
      TRAILER: '"x" not-a-comment',
    });
  });

  it('reserves host keys case-insensitively on Windows only', async () => {
    const root = await createRoot();
    await writeFile(join(root, '.env'), 'PATH=from-file\nAPI_KEY=from-file\nOTHER=1\n');
    const windows: NodeJS.ProcessEnv = { Api_Key: 'host', Path: 'host' };
    expect(applyOperatorEnv({ env: windows, platform: 'win32', pluginRoot: root }).applied).toEqual(['OTHER']);
    expect(windows).toEqual({ Api_Key: 'host', OTHER: '1', Path: 'host' });

    const posix: NodeJS.ProcessEnv = { Api_Key: 'host', Path: 'host' };
    expect(applyOperatorEnv({ env: posix, platform: 'linux', pluginRoot: root }).applied).toEqual(['API_KEY', 'OTHER', 'PATH']);
    expect(posix).toEqual({ API_KEY: 'from-file', Api_Key: 'host', OTHER: '1', PATH: 'from-file', Path: 'host' });
  });

  it('resolves the plugin root with the anchor precedence the runtime uses', () => {
    expect(operatorEnvPluginRoot('/artifact/claude', {})).toBe('/artifact/claude');
    expect(operatorEnvPluginRoot('/artifact/claude', { AGENT_BUNDLE_PLUGIN_ROOT: '/installs/curator' })).toBe('/installs/curator');
    expect(operatorEnvPluginRoot('/artifact/claude', { AGENT_BUNDLE_PLUGIN_ROOT: '  ' })).toBe('/artifact/claude');
    // A configured path is resolved exactly as written, like the runtime's resolvePluginRoot (#468).
    expect(operatorEnvPluginRoot('/artifact/claude', { AGENT_BUNDLE_PLUGIN_ROOT: '/installs/curator ' })).toBe('/installs/curator ');
    // An unexpanded host token is treated as unset, never joined into a path.
    expect(operatorEnvPluginRoot('/artifact/claude', { AGENT_BUNDLE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}' })).toBe('/artifact/claude');
    expect(operatorEnvPluginRoot('/artifact/claude', { AGENT_BUNDLE_PLUGIN_ROOT: './' })).toBe(resolve('./'));
  });

  it('considers the conventional pair, an explicit list, or nothing for "none"', () => {
    expect(operatorEnvFilePaths('/installs/curator', {})).toEqual(['/installs/curator/.env', '/installs/curator/.env.local']);
    expect(operatorEnvFilePaths('/installs/curator', { [OPERATOR_ENV_FILE_VARIABLE]: `/etc/curator.env${delimiter}./local.env` }))
      .toEqual(['/etc/curator.env', resolve('./local.env')]);
    expect(operatorEnvFilePaths('/installs/curator', { [OPERATOR_ENV_FILE_VARIABLE]: 'none' })).toEqual([]);
  });

  it('fills only the variables the host did not set, .env.local over .env, and never mutates a host value', async () => {
    const root = await createRoot();
    await writeFile(join(root, '.env'), 'FROM_FILE=s3cr3t-token\nHOST_WINS=s3cr3t-token\nLOCAL_WINS=base\n');
    await writeFile(join(root, '.env.local'), 'LOCAL_WINS=local\nLOCAL_ONLY=1\n');
    const env: NodeJS.ProcessEnv = { HOST_WINS: 'host', UNRELATED: 'kept' };

    const result = applyOperatorEnv({ env, pluginRoot: root });

    expect(env).toEqual({ FROM_FILE: 's3cr3t-token', HOST_WINS: 'host', LOCAL_ONLY: '1', LOCAL_WINS: 'local', UNRELATED: 'kept' });
    expect(result).toEqual({
      applied: ['FROM_FILE', 'LOCAL_ONLY', 'LOCAL_WINS'],
      files: [
        { applied: 2, path: join(root, '.env'), state: 'loaded' },
        { applied: 2, path: join(root, '.env.local'), state: 'loaded' },
      ],
    });
    // Nothing about a value is in the report.
    expect(JSON.stringify(result)).not.toContain('s3cr3t');
  });

  it('is a no-op with absent files and reports them as absent', async () => {
    const root = await createRoot();
    const env: NodeJS.ProcessEnv = { KEEP: '1' };

    expect(applyOperatorEnv({ env, pluginRoot: root })).toEqual({
      applied: [],
      files: [
        { path: join(root, '.env'), state: 'absent' },
        { path: join(root, '.env.local'), state: 'absent' },
      ],
    });
    expect(env).toEqual({ KEEP: '1' });
  });

  it('honours AGENT_BUNDLE_ENV_FILE from the environment it fills, including "none"', async () => {
    const root = await createRoot();
    await writeFile(join(root, '.env'), 'CONVENTIONAL=1\n');
    await mkdir(join(root, 'etc'));
    await writeFile(join(root, 'etc', 'a.env'), 'A=1\nSHARED=a\n');
    await writeFile(join(root, 'etc', 'b.env'), 'B=1\nSHARED=b\n');

    const explicit: NodeJS.ProcessEnv = { [OPERATOR_ENV_FILE_VARIABLE]: [join(root, 'etc', 'a.env'), join(root, 'etc', 'b.env')].join(delimiter) };
    expect(applyOperatorEnv({ env: explicit, pluginRoot: root }).applied).toEqual(['A', 'B', 'SHARED']);
    expect(explicit).toMatchObject({ A: '1', B: '1', SHARED: 'b' });
    expect(explicit).not.toHaveProperty('CONVENTIONAL');

    const disabled: NodeJS.ProcessEnv = { [OPERATOR_ENV_FILE_VARIABLE]: 'none' };
    expect(applyOperatorEnv({ env: disabled, pluginRoot: root })).toEqual({ applied: [], files: [] });
    expect(disabled).not.toHaveProperty('CONVENTIONAL');
  });

  it('skips an unreadable file without failing the launch', async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const root = await createRoot();
    await writeFile(join(root, '.env'), 'SECRET=1\n');
    await chmod(join(root, '.env'), 0o000);
    const env: NodeJS.ProcessEnv = {};
    try {
      const result = applyOperatorEnv({ env, pluginRoot: root });
      expect(result.files[0]).toEqual({ path: join(root, '.env'), state: 'unreadable' });
      expect(env).toEqual({});
    } finally {
      await chmod(join(root, '.env'), 0o600);
    }
  });
});
