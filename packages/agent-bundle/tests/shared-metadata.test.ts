import { mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { claudeAdapter } from '../src/adapters/claude.ts';
import { codexAdapter } from '../src/adapters/codex.ts';
import { cursorAdapter } from '../src/adapters/cursor.ts';
import { portableAdapter } from '../src/adapters/portable.ts';
import { normalizeProject, validateSource, type NormalizationTargetRegistry } from '../src/config/index.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { AgentBundleConfig, AgentBundleSharedMetadata, NormalizedPlugin } from '../src/core/types.ts';

const hosts = ['portable', 'claude', 'codex', 'cursor'] as const;

const registry: NormalizationTargetRegistry = {
  configExtensions: () => hosts.map((host) => ({ key: host, target: host })),
  defaultTargetNames: () => [...hosts],
  has: (name) => (hosts as readonly string[]).includes(name),
  supports: () => true,
};

const withProject = async (
  files: Readonly<Record<string, unknown>>,
  run: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-shared-metadata-'));
  try {
    await writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n');
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(root, name), typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const loaded = (root: string, config: AgentBundleConfig): LoadedConfig => ({
  config,
  configPath: join(root, 'agent-bundle.config.ts'),
  context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
});

const pluginConfig = (
  plugin: Partial<AgentBundleConfig['plugin']> = {},
  rest: Partial<AgentBundleConfig> = {},
): AgentBundleConfig => ({ ...rest, plugin: { name: 'shared-fixture', ...plugin } });

/** The descriptive half of each host's plugin document, keyed by host. */
const projections = (model: NormalizedPlugin): Readonly<Record<string, unknown>> => {
  const documentAt = (adapter: typeof portableAdapter, path: string): Record<string, unknown> => {
    const plan = adapter.plan(model);
    expect(plan.diagnostics, path).toEqual([]);
    const entry = plan.entries
      .find((candidate) => candidate.kind === 'write' && candidate.relativePath === path);
    if (entry === undefined || entry.kind !== 'write') throw new Error(`No ${path} in the ${adapter.name} plan.`);
    return JSON.parse(entry.content) as Record<string, unknown>;
  };
  const marketplace = documentAt(claudeAdapter, '.claude-plugin/marketplace.json');
  const claudePlugin = Array.isArray(marketplace.plugins) ? marketplace.plugins[0] as Record<string, unknown> : {};
  return {
    claude: claudePlugin,
    codex: documentAt(codexAdapter, '.codex-plugin/plugin.json'),
    cursor: documentAt(cursorAdapter, '.cursor-plugin/plugin.json'),
    portable: documentAt(portableAdapter, 'plugin.json'),
  };
};

const packageJson = {
  author: 'Ada Lovelace <ada@example.test> (https://ada.example.test)',
  description: 'Shared metadata fixture.',
  keywords: ['research', 'crm'],
  license: 'MIT',
  name: 'shared-fixture',
  repository: { type: 'git', url: 'git+https://github.com/example/shared-fixture.git' },
  version: '1.4.0',
};

const modelFor = async (
  root: string,
  config: AgentBundleConfig,
): Promise<NormalizedPlugin> => normalizeProject(loaded(root, config), { skills: [] }, registry);

it('projects one package.json declaration into every host that carries the field', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    const model = await modelFor(root, pluginConfig());
    const documents = projections(model);

    // Declared once in package.json, emitted by every host that carries it.
    for (const host of hosts) {
      expect(documents[host]).toMatchObject({
        keywords: ['research', 'crm'],
        license: 'MIT',
        // `git+https://….git` is npm's own HTTPS form, so it converts.
        repository: 'https://github.com/example/shared-fixture',
      });
      // package.json declares no homepage, so no host invents one.
      expect(documents[host]).not.toHaveProperty('homepage');
    }
    // The author object narrows to each host's pinned schema: Cursor's is
    // closed to name and email, the other two admit the url.
    expect(documents.portable).toMatchObject({
      author: { email: 'ada@example.test', name: 'Ada Lovelace', url: 'https://ada.example.test' },
    });
    expect(documents.claude).toMatchObject({
      author: { email: 'ada@example.test', name: 'Ada Lovelace', url: 'https://ada.example.test' },
    });
    expect(documents.codex).toMatchObject({
      author: { email: 'ada@example.test', name: 'Ada Lovelace', url: 'https://ada.example.test' },
    });
    expect(documents.cursor).toMatchObject({ author: { email: 'ada@example.test', name: 'Ada Lovelace' } });
    expect((documents.cursor as Record<string, Record<string, unknown>>).author).not.toHaveProperty('url');
  });
});

it('lets a host block override a shared field and null keep it out of that one host', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    const model = await modelFor(root, pluginConfig({}, {
      claude: { marketplace: { plugin: { keywords: null } } },
      codex: { license: 'Apache-2.0' },
      cursor: { homepage: 'https://cursor.example.test', license: null },
      portable: { license: 'Apache-2.0' },
    }));
    const documents = projections(model) as Record<string, Record<string, unknown>>;

    expect(documents.portable?.license).toBe('Apache-2.0');
    expect(documents.codex?.license).toBe('Apache-2.0');
    expect(documents.claude?.license).toBe('MIT');
    // `null` is a deliberate absence, not a value, and only for its own host.
    expect(documents.cursor).not.toHaveProperty('license');
    expect(documents.claude).not.toHaveProperty('keywords');
    expect(documents.cursor?.homepage).toBe('https://cursor.example.test');
    // An override in one host never changes another host's document.
    expect(documents.portable?.keywords).toEqual(['research', 'crm']);
    expect(documents.cursor?.keywords).toEqual(['research', 'crm']);
  });
});

it('shares an author only with the hosts whose contract its fields satisfy', async () => {
  // An email-only author is a valid package.json declaration, and a valid
  // portable one; Cursor, Codex, and Claude all require author.name, so it
  // shares nothing there rather than failing their own validation.
  await withProject({
    'package.json': { author: { email: 'ada@example.test' }, name: 'bare', version: '1.0.0' },
  }, async (root) => {
    const model = await modelFor(root, pluginConfig());
    const plans = [portableAdapter, cursorAdapter, codexAdapter, claudeAdapter].map((adapter) => adapter.plan(model));
    expect(plans.flatMap((plan) => plan.diagnostics)).toEqual([]);

    const documents = projections(model) as Record<string, Record<string, unknown>>;
    expect(documents.portable?.author).toEqual({ email: 'ada@example.test' });
    expect(documents.cursor).not.toHaveProperty('author');
    expect(documents.claude).not.toHaveProperty('author');
    expect(documents.codex?.author).toEqual({ name: 'shared-fixture' });
  });
});

it('still judges a host block that declares no descriptive field of its own', async () => {
  await withProject({ 'package.json': { name: 'bare', version: '1.0.0' } }, async (root) => {
    // The shared layer must not turn an authored-but-unsupported block into a
    // silent no-op: Cursor documents no `nativeHooks` surface.
    const plan = cursorAdapter.plan(await modelFor(root, pluginConfig({}, {
      cursor: { nativeHooks: { hooks: {} } } as Record<string, unknown>,
    })));
    expect(plan.diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
      .toContain('Cursor config declares unsupported field "nativeHooks"');
  });
});

it('reads a null host-block author as an opt-out, not as a malformed author', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    const config = pluginConfig({}, { codex: { author: null }, portable: { author: null } });
    const model = await modelFor(root, config);
    const plans = [codexAdapter.plan(model), portableAdapter.plan(model)];

    expect(plans.flatMap((plan) => plan.diagnostics)).toEqual([]);
    const documents = projections(model) as Record<string, Record<string, unknown>>;
    // Codex keeps its own generated fallback; the shared author simply never
    // reaches either manifest, and the other hosts still carry it.
    expect(documents.codex?.author).toEqual({ name: 'shared-fixture' });
    expect(documents.portable).not.toHaveProperty('author');
    expect(documents.cursor?.author).toMatchObject({ name: 'Ada Lovelace' });
  });
});

it('resolves plugin.metadata over package.json, and null there shares nothing', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    const overridden = await modelFor(root, pluginConfig({
      metadata: { keywords: null, license: 'BSD-3-Clause' },
    }));
    for (const document of Object.values(projections(overridden)) as Record<string, unknown>[]) {
      expect(document.license).toBe('BSD-3-Clause');
      expect(document).not.toHaveProperty('keywords');
    }
    expect(overridden.metadata.shared?.value).toMatchObject({ license: 'BSD-3-Clause' });
    expect(overridden.metadata.shared?.value).not.toHaveProperty('keywords');
  });
});

it('shares nothing, and reports nothing, for a project with no package metadata', async () => {
  await withProject({ 'package.json': { name: 'bare-fixture', version: '1.0.0' } }, async (root) => {
    const model = await modelFor(root, pluginConfig());
    expect(model.metadata.shared).toBeUndefined();
    const documents = projections(model) as Record<string, Record<string, unknown>>;
    for (const [host, document] of Object.entries(documents)) {
      for (const field of ['homepage', 'keywords', 'license', 'repository']) {
        expect(document, host).not.toHaveProperty(field);
      }
    }
    // Codex's manifest carries its own generated author fallback, which the
    // shared layer replaces only when there is something to share.
    expect(documents.codex?.author).toEqual({ name: 'shared-fixture' });
    for (const host of ['portable', 'claude', 'cursor'] as const) {
      expect(documents[host], host).not.toHaveProperty('author');
    }
    expect(validateSource(loaded(root, pluginConfig()), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4014' || diagnostic.code === 'AB4015')).toEqual([]);
  });
});

it('reads an empty package.json field as no value, not as a malformed one', async () => {
  await withProject({
    'package.json': { author: { email: '', name: 'Ada' }, keywords: [], license: '', name: 'bare', version: '1.0.0' },
  }, async (root) => {
    const config = pluginConfig();
    const model = await modelFor(root, config);
    expect(model.metadata.shared?.value).toEqual({ author: { name: 'Ada' } });
    expect(validateSource(loaded(root, config), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4015')).toEqual([]);
  });
});

it('withholds a repository form it cannot convert, and reports it against package.json', async () => {
  await withProject({
    'package.json': { ...packageJson, homepage: 'not-a-url', repository: 'example/shared-fixture' },
  }, async (root) => {
    const config = pluginConfig();
    const model = await modelFor(root, config);
    expect(model.metadata.shared?.value).not.toHaveProperty('repository');
    expect(model.metadata.shared?.value).not.toHaveProperty('homepage');
    // The fields it can share still reach every host.
    expect(model.metadata.shared?.value.license).toBe('MIT');

    const reported = validateSource(loaded(root, config), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4015');
    expect(reported.map((diagnostic) => diagnostic.severity)).toEqual(['warning', 'warning']);
    expect(reported.every((diagnostic) => diagnostic.sourcePath === join(root, 'package.json'))).toBe(true);
    expect(reported.map((diagnostic) => diagnostic.message).sort()).toEqual([
      'package.json homepage must be an absolute HTTP or HTTPS URL. It is not shared with any host manifest.',
      'package.json repository must be an absolute HTTP or HTTPS URL, or the git+https URL npm writes for one; ' +
      'shorthand and SSH forms are not converted. It is not shared with any host manifest.',
    ]);
  });
});

it.each([
  { label: 'an owner/repo shorthand', repository: 'example/shared-fixture' },
  { label: 'a github: shorthand', repository: 'github:example/shared-fixture' },
  { label: 'an SSH URL', repository: 'git@github.com:example/shared-fixture.git' },
  { label: 'a git+ssh URL', repository: 'git+ssh://git@github.com/example/shared-fixture.git' },
  { label: 'a git protocol URL', repository: 'git://github.com/example/shared-fixture.git' },
  { label: 'a git+http URL', repository: 'git+http://github.com/example/shared-fixture.git' },
])('withholds $label rather than rewriting it into a web URL', async ({ repository }) => {
  await withProject({ 'package.json': { ...packageJson, repository } }, async (root) => {
    const config = pluginConfig();
    expect((await modelFor(root, config)).metadata.shared?.value).not.toHaveProperty('repository');
    expect(validateSource(loaded(root, config), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4015')).toMatchObject([{
      message: expect.stringContaining('package.json repository must be an absolute HTTP or HTTPS URL'),
      severity: 'warning',
    }]);
  });
});

it('refuses a blank or empty plugin.metadata value instead of reading it as an opt-out', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    const config = pluginConfig({ metadata: { keywords: [], license: '  ' } });
    const reported = validateSource(loaded(root, config), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4014');

    expect(reported.map((diagnostic) => diagnostic.message)).toEqual([
      'Shared plugin.metadata.license must be a nonempty string.',
      'Shared plugin.metadata.keywords must be a nonempty array of nonempty strings.',
    ]);
    // Withheld rather than read as an opt-out or guessed from the package:
    // AB4014 is an error, so the build stops instead of shipping either.
    const model = await modelFor(root, config);
    expect(model.metadata.shared?.value).not.toHaveProperty('license');
    expect(model.metadata.shared?.value).not.toHaveProperty('keywords');
  });
});

it.each([
  { field: 'homepage', label: 'a URL character the pinned uri format refuses', value: 'https://example.test/a|b' },
  { field: 'homepage', label: 'a non-ASCII URL', value: 'https://example.test/p\u00e4th' },
  { field: 'homepage', label: 'an uppercase scheme', value: 'HTTPS://example.test' },
  { field: 'author', label: 'a doubled dot in an address', value: { email: 'a..b@example.test' } },
  { field: 'author', label: 'an address without a domain', value: { email: 'ada@example' } },
])('withholds $label rather than letting a host refuse it', async ({ field, value }) => {
  await withProject({
    'package.json': { ...packageJson, author: 'Ada', [field]: value, name: 'bare' },
  }, async (root) => {
    const config = pluginConfig();
    const model = await modelFor(root, config);
    expect(model.metadata.shared?.value).not.toHaveProperty(field);
    // Reported once against package.json, and every host still plans: the
    // whole point is that a package field cannot become a host manifest error.
    expect(validateSource(loaded(root, config), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4015')).toHaveLength(1);
    for (const adapter of [portableAdapter, cursorAdapter, codexAdapter, claudeAdapter]) {
      expect(adapter.plan(model).diagnostics, adapter.name).toEqual([]);
    }
  });
});

it('trims a shared URL rather than shipping the padding a host would refuse', async () => {
  await withProject({
    'package.json': { ...packageJson, homepage: ' https://padded.example.test ', name: 'bare' },
  }, async (root) => {
    const config = pluginConfig();
    expect((await modelFor(root, config)).metadata.shared?.value.homepage).toBe('https://padded.example.test');
    expect(validateSource(loaded(root, config), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4015')).toEqual([]);
  });
});

it('keeps package.json out of the Claude entry its overlay overrides', async () => {
  await withProject({
    'package.json': { license: 'MIT', name: 'bare-fixture', version: '1.0.0' },
  }, async (root) => {
    const model = await modelFor(root, pluginConfig({}, {
      claude: { marketplace: { plugin: { license: 'Apache-2.0' } } },
    }));
    expect(model.metadata.shared?.packageSource).toBe(join(root, 'package.json'));

    const entry = claudeAdapter.plan(model).entries
      .find((candidate) => candidate.kind === 'write' && candidate.relativePath === '.claude-plugin/marketplace.json');
    expect(entry?.kind === 'write' ? entry.sourceInputs : []).not.toContain(join(root, 'package.json'));
    expect(projections(model)).toMatchObject({ claude: { license: 'Apache-2.0' } });
  });
});

it('refuses a malformed plugin.metadata block as the config author\'s own error', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    const config = pluginConfig({ metadata: { homepage: 'not-a-url' } });
    const reported = validateSource(loaded(root, config), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4014');
    expect(reported).toMatchObject([{ severity: 'error', sourcePath: join(root, 'agent-bundle.config.ts') }]);
    expect(reported[0]?.message).toBe('Shared plugin.metadata.homepage must be an absolute HTTP or HTTPS URL.');

    // A field beyond the five is the same error, named against the block.
    const unknown = pluginConfig({ metadata: { descriptoin: 'typo' } as AgentBundleSharedMetadata });
    expect(validateSource(loaded(root, unknown), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4014'))
      .toMatchObject([{
        message: expect.stringContaining('shares only author, homepage, keywords, license, repository'),
        recovery: expect.stringContaining('Correct plugin.metadata in the config'),
      }]);

    // A package field the config replaced is not also reported.
    const replaced = pluginConfig({ metadata: { repository: 'https://example.test/repo' } });
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...packageJson, repository: 'example/repo' }));
    expect(validateSource(loaded(root, replaced), { skills: [] }, registry)
      .filter((diagnostic) => diagnostic.code === 'AB4015')).toEqual([]);
  });
});

it('records package.json among the source inputs of every projection that emits a shared value', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    const model = await modelFor(root, pluginConfig());
    const packagePath = join(root, 'package.json');
    expect(model.metadata.shared?.packageSource).toBe(packagePath);

    for (const [adapter, path] of [
      [portableAdapter, 'plugin.json'],
      [cursorAdapter, '.cursor-plugin/plugin.json'],
      [codexAdapter, '.codex-plugin/plugin.json'],
      [claudeAdapter, '.claude-plugin/marketplace.json'],
    ] as const) {
      const entry = adapter.plan(model).entries
        .find((candidate) => candidate.kind === 'write' && candidate.relativePath === path);
      expect(entry?.kind === 'write' ? entry.sourceInputs : []).toContain(packagePath);
    }
  });
});

it('keeps package.json out of a projection whose host block overrides every shared field', async () => {
  await withProject({
    'package.json': { license: 'MIT', name: 'bare-fixture', version: '1.0.0' },
  }, async (root) => {
    const packagePath = join(root, 'package.json');
    const model = await modelFor(root, pluginConfig({}, {
      cursor: { license: 'Apache-2.0' },
      portable: { license: 'Apache-2.0' },
    }));
    // The shared layer resolved a package value; these two artifacts just do
    // not depend on it, so only they leave it out of their source inputs.
    expect(model.metadata.shared?.packageSource).toBe(packagePath);

    const inputsFor = (adapter: typeof portableAdapter, path: string): readonly string[] => {
      const entry = adapter.plan(model).entries
        .find((candidate) => candidate.kind === 'write' && candidate.relativePath === path);
      return entry?.kind === 'write' ? entry.sourceInputs : [];
    };
    expect(inputsFor(portableAdapter, 'plugin.json')).not.toContain(packagePath);
    expect(inputsFor(cursorAdapter, '.cursor-plugin/plugin.json')).not.toContain(packagePath);
    expect(inputsFor(codexAdapter, '.codex-plugin/plugin.json')).toContain(packagePath);
    expect(projections(model)).toMatchObject({
      codex: { license: 'MIT' },
      cursor: { license: 'Apache-2.0' },
      portable: { license: 'Apache-2.0' },
    });
  });
});

it('resolves all three precedence levels at once, and records the file each value came from', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    const model = await modelFor(root, pluginConfig({
      metadata: { homepage: 'https://shared.example.test', license: 'Apache-2.0' },
    }, { cursor: { license: 'BSD-3-Clause' } }));
    const documents = projections(model) as Record<string, Record<string, unknown>>;

    // Host block, then plugin.metadata, then package.json — in one build.
    expect(documents.cursor?.license).toBe('BSD-3-Clause');
    expect(documents.portable?.license).toBe('Apache-2.0');
    expect(documents.portable?.homepage).toBe('https://shared.example.test');
    expect(documents.portable?.keywords).toEqual(['research', 'crm']);
    expect(model.metadata.shared?.packageSource).toBe(join(root, 'package.json'));
  });
});

it('reads a symlinked package.json through the path the source snapshot records', async () => {
  await withProject({ 'package.json': packageJson }, async (root) => {
    await rename(join(root, 'package.json'), join(root, 'package.real.json'));
    await symlink(join(root, 'package.real.json'), join(root, 'package.json'));
    const model = await modelFor(root, pluginConfig());

    // One provenance path for one file: the resolved one, which is what
    // `snapshotProjectSource` puts in the project revision.
    expect(model.metadata.shared?.packageSource).toBe(await realpath(join(root, 'package.real.json')));
  });
});
