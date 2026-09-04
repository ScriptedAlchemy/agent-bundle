import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  discoverProject,
  normalizeProject,
  parseSkill,
  validateSource,
  type NormalizationTargetRegistry,
} from '../src/config/index.ts';
import { compileRenderedSkill } from '../src/config/rendered-skill.ts';
import { renderElementToMarkdown } from '../src/config/render-markdown.ts';
import { standardPluginArtifactPlan } from '../src/adapters/types.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import type { LoadedConfig } from '../src/config/load.ts';

const fixtureRoot = join(import.meta.dirname, 'fixtures', 'rendered-skill');

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: () => true,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const projectRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-rendered-skill-')));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
};

const loadedProject = (config: AgentBundleConfig, root: string): LoadedConfig => ({
  config,
  configPath: `${root}/agent-bundle.config.ts`,
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

/** Element helper mirroring the plain object shape the automatic JSX runtime produces. */
const element = (type: unknown, props: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ props, type });

describe('renderElementToMarkdown', () => {
  it('renders the supported block and inline subset', async () => {
    const markdown = await renderElementToMarkdown([
      element('h2', { children: 'Steps' }),
      'Loose text with ',
      element('code', { children: 'inline()' }),
      ' calls.',
      element('ul', {
        children: [
          element('li', { children: ['First ', element('em', { children: 'gently' })] }),
          element('li', {
            children: [
              'Second',
              element('ul', { children: [element('li', { children: 'Nested detail' })] }),
            ],
          }),
        ],
      }),
      element('hr'),
      element('p', { children: ['Line one', element('br'), 'line two'] }),
    ]);

    expect(markdown).toBe([
      '## Steps',
      '',
      'Loose text with `inline()` calls.',
      '',
      '- First *gently*',
      '- Second',
      '',
      '  - Nested detail',
      '',
      '---',
      '',
      'Line one  \nline two',
      '',
    ].join('\n'));
  });

  it('resolves sync and async function components', async () => {
    const Title = () => element('h1', { children: 'Rendered' });
    const Body = async () => element('p', { children: 'From an async component.' });
    const markdown = await renderElementToMarkdown([element(Title), element(Body)]);
    expect(markdown).toBe('# Rendered\n\nFrom an async component.\n');
  });

  it('rejects unsupported elements by name', async () => {
    await expect(renderElementToMarkdown(element('table'))).rejects.toThrow('unsupported element <table>');
    await expect(renderElementToMarkdown(element('p', { children: element('img', { src: 'x.png' }) })))
      .rejects.toThrow('unsupported element <img>');
  });

  it('rejects an empty document and a self-rendering component', async () => {
    await expect(renderElementToMarkdown([])).rejects.toThrow('produced no Markdown');
    const Loop = (): Record<string, unknown> => element(Loop);
    await expect(renderElementToMarkdown(element(Loop))).rejects.toThrow('depth limit');
  });
});

describe('rendered skill compilation', () => {
  const expectedBody = [
    '# Deploy checklist',
    '',
    'Run every step *in order*; the playbook in [references/playbook.md](references/playbook.md) has the details.',
    '',
    '1. **CI** — Green build on main.',
    '2. **Notes** — Changelog covers every merged PR.',
    '',
    '```sh',
    'agent-bundle build',
    '```',
    '',
    '> Ship only when the checklist is green.',
    '',
  ].join('\n');

  it('compiles the JSX fixture through jiti to the full SKILL.md document', async () => {
    const compiled = await compileRenderedSkill(
      join(fixtureRoot, 'src', 'skills', 'deploy-checklist', 'SKILL.tsx'),
    );
    expect(compiled.status).toBe('compiled');
    if (compiled.status !== 'compiled') return;
    expect(compiled.document.markdown).toBe([
      '---',
      'description: Walks a release through the deploy checklist with rendered, data-driven steps.',
      'name: deploy-checklist',
      '---',
      '',
      expectedBody,
    ].join('\n'));
  });

  it('parses a rendered skill directory: compiled body, module source, no source-file resource', async () => {
    const skill = await parseSkill(join(fixtureRoot, 'src', 'skills', 'deploy-checklist'), fixtureRoot);
    expect(skill.diagnostics).toEqual([]);
    expect(skill.rendered).toBe(true);
    expect(skill.source.endsWith('SKILL.tsx')).toBe(true);
    expect(skill.body).toBe(expectedBody);
    expect(skill.frontmatter).toEqual({
      description: 'Walks a release through the deploy checklist with rendered, data-driven steps.',
      name: 'deploy-checklist',
    });
    expect(skill.resources.map((resource) => resource.relativePath)).toEqual(['references/playbook.md']);
  });

  it('discovers rendered-only skill directories by convention and validates them cleanly', async () => {
    const loaded = loadedProject({ plugin: { name: 'rendered', version: '1.0.0' } }, fixtureRoot);
    const discovered = await discoverProject(fixtureRoot, loaded.config);
    expect(discovered.skills.map((skill) => skill.frontmatter.name)).toEqual(['deploy-checklist']);
    expect(validateSource(loaded, discovered, registry)).toEqual([]);

    const model = await normalizeProject(loaded, discovered, registry);
    expect(model.skills[0]).toMatchObject({
      markdown: expect.stringContaining('# Deploy checklist'),
      provenance: { kind: 'conventional' },
    });
  });

  it('emits the compiled SKILL.md as a generated write entry in artifact plans', async () => {
    const loaded = loadedProject({ plugin: { name: 'rendered', version: '1.0.0' } }, fixtureRoot);
    const model = await normalizeProject(loaded, await discoverProject(fixtureRoot, loaded.config), registry);
    const plan = standardPluginArtifactPlan({
      diagnostics: [],
      hookDocumentValid: true,
      hookEntries: [],
      hookManifestPath: 'hooks/hooks.json',
      isSelected: () => true,
      marketplaceRelativePath: 'marketplace.json',
      marketplaceValid: true,
      mcpValid: true,
      model,
      plugin: {},
      pluginRelativePath: 'plugin.json',
      targetName: 'portable',
    });
    const skillEntries = plan.entries.filter((entry) => entry.relativePath.startsWith('skills/'));
    expect(skillEntries).toEqual([
      expect.objectContaining({
        content: expect.stringContaining('# Deploy checklist'),
        kind: 'write',
        relativePath: 'skills/deploy-checklist/SKILL.md',
      }),
      expect.objectContaining({
        kind: 'copy',
        relativePath: 'skills/deploy-checklist/references/playbook.md',
      }),
    ]);
  });

  it('loads rendered modules that build plain element objects without react', async () => {
    const root = await projectRoot({
      'src/skills/plain/SKILL.ts': [
        "export const frontmatter = { description: 'A plain rendered skill.', name: 'plain' };",
        "const paragraph = { props: { children: 'Composed without JSX.' }, type: 'p' };",
        "export default () => [{ props: { children: 'Plain' }, type: 'h1' }, paragraph];",
        '',
      ].join('\n'),
    });
    const skill = await parseSkill(join(root, 'src', 'skills', 'plain'), root);
    expect(skill.diagnostics).toEqual([]);
    expect(skill.markdown).toBe([
      '---',
      'description: A plain rendered skill.',
      'name: plain',
      '---',
      '',
      '# Plain',
      '',
      'Composed without JSX.',
      '',
    ].join('\n'));
  });

  it('serves agent-bundle/meta to a rendered skill with the identity the model stamps (#440)', async () => {
    const skillSource = [
      "import { meta, name, packageName, packageVersion, version } from 'agent-bundle/meta';",
      '',
      "export const frontmatter = { description: 'Prints the plugin identity.', name: 'identity' };",
      'export default () => (',
      '  <>',
      '    <h1>{name}</h1>',
      '    <p>Version <code>{version}</code>; package <code>{String(packageName)}@{String(packageVersion)}</code>.</p>',
      '    <p>Aggregate: <code>{JSON.stringify(meta)}</code></p>',
      '  </>',
      ');',
      '',
    ].join('\n');
    const root = await projectRoot({
      'package.json': '{ "name": "@acme/identity-plugin", "version": "3.4.5", "type": "module" }\n',
      'src/skills/identity/SKILL.tsx': skillSource,
    });
    const loaded = loadedProject({ plugin: { name: 'identity-plugin' } }, root);

    const discovered = await discoverProject(root, loaded.config);
    const [skill] = discovered.skills;
    expect(skill?.diagnostics).toEqual([]);
    expect(skill?.body).toBe([
      '# identity-plugin',
      '',
      'Version `3.4.5`; package `@acme/identity-plugin@3.4.5`.',
      '',
      'Aggregate: `{"name":"identity-plugin","packageName":"@acme/identity-plugin","packageVersion":"3.4.5","version":"3.4.5"}`',
      '',
    ].join('\n'));

    // The skill observed exactly the identity normalization stamps.
    const model = await normalizeProject(loaded, discovered, registry);
    expect(model.metadata).toMatchObject({
      name: 'identity-plugin',
      packageName: '@acme/identity-plugin',
      packageVersion: '3.4.5',
      version: '3.4.5',
    });

    // An authored plugin.version wins over package.json, for the skill too.
    const authored = await discoverProject(root, { plugin: { name: 'identity-plugin', version: '9.0.0' } });
    expect(authored.skills[0]?.body).toContain('Version `9.0.0`; package `@acme/identity-plugin@3.4.5`.');

    // Without a caller-supplied identity the reserved specifier is not aliased:
    // it resolves however the project resolves `agent-bundle` — here, not at all.
    const direct = await parseSkill(join(root, 'src', 'skills', 'identity'), root);
    expect(direct.diagnostics).toEqual([expect.objectContaining({ code: 'AB3003' })]);

    // A config with no usable plugin.name is the validator's AB4000: discovery
    // still completes, and the skill is served no fabricated identity.
    for (const malformed of [{}, { plugin: null }, { plugin: { name: '' } }, { plugin: 'x' }]) {
      const config = malformed as unknown as AgentBundleConfig;
      const withoutIdentity = await discoverProject(root, config);
      expect(withoutIdentity.skills[0]?.diagnostics).toEqual([expect.objectContaining({ code: 'AB3003' })]);
      expect(validateSource(loadedProject(config, root), withoutIdentity, registry).map(({ code }) => code))
        .toContain('AB4000');
    }
  });

  it('compiles JSX against the loader element factory, not the consumer react/jsx-runtime (#441)', async () => {
    // A `react` whose jsx runtime throws stands in for the react-server
    // condition mismatch: the loader never resolves the consumer's runtime.
    const root = await projectRoot({
      'node_modules/react/index.js': 'module.exports = { Fragment: Symbol.for("react.fragment") };\n',
      'node_modules/react/jsx-dev-runtime.js': "throw new Error('consumer jsx-dev-runtime resolved');\n",
      'node_modules/react/jsx-runtime.js': "throw new Error('consumer jsx-runtime resolved');\n",
      'node_modules/react/package.json': '{ "name": "react", "version": "0.0.0-test", "main": "index.js" }\n',
      'src/skills/keyed/SKILL.tsx': [
        "import React from 'react';",
        '',
        "export const frontmatter = { description: 'Keyed list items.', name: 'keyed' };",
        "const items = ['one', 'two'];",
        'export default () => (',
        '  <>',
        '    <h1>Keyed</h1>',
        '    <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>',
        '    <p>{React.Fragment === Symbol.for("react.fragment") ? "react resolved" : "react missing"}</p>',
        '  </>',
        ');',
        '',
      ].join('\n'),
    });

    const skill = await parseSkill(join(root, 'src', 'skills', 'keyed'), root);
    expect(skill.diagnostics).toEqual([]);
    expect(skill.body).toBe('# Keyed\n\n- one\n- two\n\nreact resolved\n');
  });

  it('reports AB3003 for a module that fails to load', async () => {
    const root = await projectRoot({
      'src/skills/broken/SKILL.ts': "throw new Error('boom');\nexport default () => null;\n",
    });
    const skill = await parseSkill(join(root, 'src', 'skills', 'broken'), root);
    expect(skill.diagnostics).toEqual([expect.objectContaining({ code: 'AB3003', severity: 'error' })]);
  });

  it('reports AB3004 for a missing default component or frontmatter export', async () => {
    const root = await projectRoot({
      'src/skills/no-component/SKILL.ts': "export const frontmatter = { name: 'no-component' };\n",
      'src/skills/no-frontmatter/SKILL.ts': "export default () => ({ props: { children: 'x' }, type: 'p' });\n",
    });
    const noComponent = await parseSkill(join(root, 'src', 'skills', 'no-component'), root);
    expect(noComponent.diagnostics).toEqual([expect.objectContaining({
      code: 'AB3004',
      message: expect.stringContaining('default-export a component'),
    })]);
    const noFrontmatter = await parseSkill(join(root, 'src', 'skills', 'no-frontmatter'), root);
    expect(noFrontmatter.diagnostics).toEqual([expect.objectContaining({
      code: 'AB3004',
      message: expect.stringContaining('frontmatter'),
    })]);
  });

  it('reports AB3005 when the tree renders outside the supported subset', async () => {
    const root = await projectRoot({
      'src/skills/tabular/SKILL.ts': [
        "export const frontmatter = { description: 'Tables are unsupported.', name: 'tabular' };",
        "export default () => ({ props: {}, type: 'table' });",
        '',
      ].join('\n'),
    });
    const skill = await parseSkill(join(root, 'src', 'skills', 'tabular'), root);
    expect(skill.diagnostics).toEqual([expect.objectContaining({
      code: 'AB3005',
      message: expect.stringContaining('<table>'),
    })]);
  });

  it('nudges AB4735 when a hand-authored SKILL.md shadows the rendered source', async () => {
    const root = await projectRoot({
      'src/skills/both/SKILL.md': '---\nname: both\ndescription: The authored document wins.\n---\n\n# Both\n\nAuthored.\n',
      'src/skills/both/SKILL.tsx': [
        "export const frontmatter = { description: 'Never compiled.', name: 'both' };",
        "export default () => ({ props: { children: 'Rendered' }, type: 'h1' });",
        '',
      ].join('\n'),
    });
    const skill = await parseSkill(join(root, 'src', 'skills', 'both'), root);
    expect(skill.rendered).toBeUndefined();
    expect(skill.body).toContain('Authored.');
    expect(skill.diagnostics).toEqual([expect.objectContaining({
      code: 'AB4735',
      recovery: expect.stringContaining('Optional'),
      severity: 'info',
    })]);
    expect(skill.resources.map((resource) => resource.relativePath)).toEqual(['SKILL.md']);
  });
});
