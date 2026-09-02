import { mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { ArtifactService } from '../src/dev/artifacts/artifact-service.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import { ProjectEventHub, startForegroundServer } from '../src/dev/index.ts';
import { ProjectService } from '../src/dev/project-service.ts';
import { SkillDocumentService } from '../src/dev/skill-document-service.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';

class TrackingEpochStore extends EpochStore {
  acquisitions = 0;
  releases = 0;

  override async acquireEpochReference(epochId: string) {
    this.acquisitions += 1;
    const reference = await super.acquireEpochReference(epochId);
    const close = reference.close.bind(reference);
    reference.close = async () => {
      this.releases += 1;
      await close();
    };
    return reference;
  }
}

const createProject = async (): Promise<string> => (await createProjectFixture({
  config: [
    'export default {',
    "  plugin: { name: 'skill-document-fixture', version: '1.0.0' },",
    "  targets: ['portable'],",
    '};',
    '',
  ].join('\n'),
  files: {
    'src/skills/review/SKILL.md': [
      '---',
      'name: review',
      'description: Reviews changed files',
      '---',
      '# Review',
      '',
      'Read [the guide](guide.md) and ![the image](assets/pixel.bin).',
      '',
    ].join('\n'),
    'src/skills/review/guide.md': '# Guide\n',
    'src/skills/review/assets/pixel.bin': new Uint8Array([0, 255, 17, 9]),
    'src/skills/review/assets/probe.html': '<script>window.__skillResourceExecuted = true</script>\n',
  },
  prefix: 'agent-bundle-skill-document-',
})).root;

it('serves parsed source documents and exact source resources by a model-owned Skill ID', async () => {
  const root = await createProject();
  try {
    const service = new SkillDocumentService({
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    });

    const document = await service.source('skill:review');
    const binary = await service.sourceResource('skill:review', ['assets', 'pixel.bin']);

    expect(document).toMatchObject({
      base: { kind: 'source', skillId: 'skill:review' },
      body: '# Review\n\nRead [the guide](guide.md) and ![the image](assets/pixel.bin).\n',
      frontmatter: { description: 'Reviews changed files', name: 'review' },
      id: 'skill:review',
      markdown: [
        '---',
        'name: review',
        'description: Reviews changed files',
        '---',
        '# Review',
        '',
        'Read [the guide](guide.md) and ![the image](assets/pixel.bin).',
        '',
      ].join('\n'),
      resources: [
        { relativePath: 'SKILL.md' },
        { relativePath: 'assets/pixel.bin' },
        { relativePath: 'assets/probe.html' },
        { relativePath: 'guide.md' },
      ],
    });
    expect(binary.contentType).toBe('application/octet-stream');
    expect(binary.body).toEqual(new Uint8Array([0, 255, 17, 9]));
    expect([...await readFile(join(root, 'src', 'skills', 'review', 'assets', 'pixel.bin'))]).toEqual([...binary.body]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('marks active Skill resources for download while preserving their exact bytes and MIME', async () => {
  const root = await createProject();
  try {
    const service = new SkillDocumentService({
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    });

    const resource = await service.sourceResource('skill:review', ['assets', 'probe.html']);

    expect(resource).toMatchObject({
      contentDisposition: 'attachment',
      contentType: 'text/html; charset=utf-8',
      relativePath: 'assets/probe.html',
    });
    expect(new TextDecoder().decode(resource.body)).toBe('<script>window.__skillResourceExecuted = true</script>\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('serves the generated parser result and byte-identical resources while pinning the exact epoch', async () => {
  const root = await createProject();
  try {
    const projectService = new ProjectService({ root });
    const prepared = await projectService.prepare('build');
    const epochStore = new EpochStore({ projectRoot: root });
    const built = await new ArtifactService({ epochStore }).build(prepared);
    expect(built.outcome).toBe('succeeded');
    if (built.outcome !== 'succeeded') throw new Error('Fixture artifact did not build.');
    const service = new SkillDocumentService({ epochStore, projectService, root });

    const document = await service.generated(built.epoch.id, 'portable', 'skill:review');
    const binary = await service.generatedResource(
      built.epoch.id,
      'portable',
      'skill:review',
      ['assets', 'pixel.bin'],
    );

    expect(document).toMatchObject({
      base: { epochId: built.epoch.id, kind: 'generated', skillId: 'skill:review', target: 'portable' },
      body: '# Review\n\nRead [the guide](guide.md) and ![the image](assets/pixel.bin).\n',
      frontmatter: { description: 'Reviews changed files', name: 'review' },
      id: 'skill:review',
      markdown: [
        '---',
        'name: review',
        'description: Reviews changed files',
        '---',
        '# Review',
        '',
        'Read [the guide](guide.md) and ![the image](assets/pixel.bin).',
        '',
      ].join('\n'),
    });
    expect(binary.body).toEqual(new Uint8Array([0, 255, 17, 9]));
    expect(binary.contentType).toBe('application/octet-stream');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reads generated documents from the acquired epoch reference root, never a similarly named alternate root', async () => {
  const protectedRoot = await createProject();
  const alternateRoot = await createProject();
  try {
    const protectedProject = new ProjectService({ root: protectedRoot });
    const epochStore = new EpochStore({ projectRoot: protectedRoot });
    const built = await new ArtifactService({ epochStore }).build(await protectedProject.prepare('build'));
    expect(built.outcome).toBe('succeeded');
    if (built.outcome !== 'succeeded') throw new Error('Fixture artifact did not build.');
    const alternateSkill = join(alternateRoot, '.agent-bundle', 'epochs', built.epoch.id, 'portable', 'skills', 'review');
    await mkdir(join(alternateSkill, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(alternateSkill, 'SKILL.md'), '---\nname: review\n---\n# Alternate\n'),
      writeFile(join(alternateSkill, 'assets', 'pixel.bin'), 'alternate'),
    ]);
    const service = new SkillDocumentService({
      epochStore,
      projectService: new ProjectService({ root: alternateRoot }),
      root: alternateRoot,
    });

    const document = await service.generated(built.epoch.id, 'portable', 'skill:review');
    const resource = await service.generatedResource(built.epoch.id, 'portable', 'skill:review', ['assets', 'pixel.bin']);

    expect(document.body).toContain('# Review');
    expect(document.body).not.toContain('# Alternate');
    expect(resource.body).toEqual(new Uint8Array([0, 255, 17, 9]));
    await expect(readFile(join(alternateSkill, 'SKILL.md'), 'utf8')).resolves.toContain('# Alternate');
  } finally {
    await Promise.all([
      rm(protectedRoot, { force: true, recursive: true }),
      rm(alternateRoot, { force: true, recursive: true }),
    ]);
  }
});

it('serves only typed source Skill routes and rejects encoded resource separators before lookup', async () => {
  const root = await createProject();
  try {
    const service = new SkillDocumentService({
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    });
    const server = await startForegroundServer({
      coordinator: {
        close: async () => undefined,
        rebuild: async () => undefined,
        start: async () => undefined,
        status: () => ({
          artifact: { state: 'missing' as const },
          build: { state: 'idle' as const },
          source: { diagnostics: [], state: 'unknown' as const },
        }),
      },
      eventHub: new ProjectEventHub(),
      port: 0,
      skillDocuments: service,
    });
    try {
      const [document, binary, active, malformed] = await Promise.all([
        fetch(`${server.url}/api/skills/source/skill%3Areview`),
        fetch(`${server.url}/api/skills/source/skill%3Areview/resources/assets/pixel.bin`),
        fetch(`${server.url}/api/skills/source/skill%3Areview/resources/assets/probe.html`),
        fetch(`${server.url}/api/skills/source/skill%3Areview/resources/assets%2Fpixel.bin`),
      ]);

      expect(document.status).toBe(200);
      await expect(document.json()).resolves.toMatchObject({
        document: { id: 'skill:review', frontmatter: { name: 'review' } },
      });
      expect(binary.headers.get('content-type')).toBe('application/octet-stream');
      expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 255, 17, 9]);
      expect(active.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(active.headers.get('content-disposition')).toContain('attachment');
      expect(active.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await active.text()).toBe('<script>window.__skillResourceExecuted = true</script>\n');
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toEqual({
        diagnostic: { code: 'AB8012', message: 'Skill route path is not valid.' },
      });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects traversal and symlink resource mutations after exact model membership is established', async () => {
  const root = await createProject();
  try {
    const service = new SkillDocumentService({
      epochStore: new EpochStore({ projectRoot: root }),
      projectService: new ProjectService({ root }),
      root,
    });
    const pixel = join(root, 'src', 'skills', 'review', 'assets', 'pixel.bin');
    const outside = join(root, 'outside.bin');
    await writeFile(outside, 'outside');

    await expect(service.sourceResource('skill:review', ['assets', '..', 'SKILL.md'])).rejects.toMatchObject({
      code: 'SKILL_RESOURCE_UNAVAILABLE',
    });
    await unlink(pixel);
    await symlink(outside, pixel);
    await expect(service.sourceResource('skill:review', ['assets', 'pixel.bin'])).rejects.toMatchObject({
      code: 'SKILL_RESOURCE_UNAVAILABLE',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('releases every acquired epoch reference after generated document and resource responses', async () => {
  const root = await createProject();
  try {
    const projectService = new ProjectService({ root });
    const epochStore = new TrackingEpochStore({ projectRoot: root });
    const built = await new ArtifactService({ epochStore }).build(await projectService.prepare('build'));
    expect(built.outcome).toBe('succeeded');
    if (built.outcome !== 'succeeded') throw new Error('Fixture artifact did not build.');
    const service = new SkillDocumentService({ epochStore, projectService, root });

    await service.generated(built.epoch.id, 'portable', 'skill:review');
    await service.generatedResource(built.epoch.id, 'portable', 'skill:review', ['assets', 'pixel.bin']);

    expect(epochStore.acquisitions).toBe(2);
    expect(epochStore.releases).toBe(2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
