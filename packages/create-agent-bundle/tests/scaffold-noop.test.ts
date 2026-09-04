import { Effect, FileSystem, Layer, Option, Path, PlatformError } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { assertLocalFrameworkTarball } from '../src/framework.ts';
import { UsageError } from '../src/options.ts';
import { assertScaffoldTarget, scaffold } from '../src/scaffold.ts';

/**
 * Deterministic unit tests over `FileSystem.layerNoop`: every operation the
 * scaffolder performs is overridden explicitly (the noop defaults fail with
 * NotFound or die), so these tests pin the exact read/mkdir/write protocol
 * without touching the disk. OS semantics — real temp directories, tarball
 * inflation — stay in scaffold.test.ts and framework.test.ts.
 */

const fileInfo = (type: FileSystem.File.Type): FileSystem.File.Info => ({
  atime: Option.none(),
  birthtime: Option.none(),
  blksize: Option.none(),
  blocks: Option.none(),
  dev: 0,
  gid: Option.none(),
  ino: Option.none(),
  mode: 0o644,
  mtime: Option.none(),
  nlink: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  type,
  uid: Option.none(),
});

const notFound = (method: string, path: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: 'NotFound', method, module: 'FileSystem', pathOrDescriptor: path });

interface RecordedFileSystem {
  readonly directories: { readonly path: string; readonly recursive: boolean | undefined }[];
  readonly layer: Layer.Layer<FileSystem.FileSystem | Path.Path>;
  readonly written: Map<string, string>;
}

/** An in-memory template tree keyed by absolute POSIX path; directories are implied by their files. */
const templateFileSystem = (files: Readonly<Record<string, string>>): RecordedFileSystem => {
  const directories: RecordedFileSystem['directories'] = [];
  const written = new Map<string, string>();
  const children = (directory: string): string[] | undefined => {
    const prefix = `${directory}/`;
    const names = new Set<string>();
    for (const file of Object.keys(files)) {
      if (!file.startsWith(prefix)) continue;
      names.add(file.slice(prefix.length).split('/')[0]!);
    }
    return names.size === 0 ? undefined : [...names];
  };
  const fileSystem = FileSystem.layerNoop({
    makeDirectory: (path, options) => Effect.sync(() => {
      directories.push({ path, recursive: options?.recursive });
    }),
    readDirectory: (path) => {
      const entries = children(path);
      return entries === undefined ? Effect.fail(notFound('readDirectory', path)) : Effect.succeed(entries);
    },
    readFileString: (path) => {
      const contents = files[path];
      return contents === undefined ? Effect.fail(notFound('readFileString', path)) : Effect.succeed(contents);
    },
    stat: (path) => {
      if (path in files) return Effect.succeed(fileInfo('File'));
      if (children(path) !== undefined) return Effect.succeed(fileInfo('Directory'));
      return Effect.fail(notFound('stat', path));
    },
    writeFileString: (path, data) => Effect.sync(() => {
      written.set(path, data);
    }),
  });
  return { directories, layer: Layer.merge(fileSystem, Path.layer), written };
};

const templateRoot = '/templates/minimal';
const minimalTemplate = {
  [`${templateRoot}/README.md`]: '# my-agent-plugin\n',
  [`${templateRoot}/agent-bundle.config.ts`]: "export default { name: 'my-agent-plugin', targets: ['portable', 'codex', 'claude'] };\n",
  [`${templateRoot}/gitignore`]: 'node_modules\n',
  [`${templateRoot}/package_json`]: `${JSON.stringify({
    devDependencies: { 'agent-bundle': 'workspace:*' },
    name: 'my-agent-plugin',
  }, null, 2)}\n`,
  [`${templateRoot}/src/skills/getting-started/SKILL.md`]: '---\nname: my-agent-plugin\n---\n',
};

describe('scaffold over FileSystem.layerNoop', () => {
  it.effect('copies the template through readDirectory/stat/readFileString/makeDirectory/writeFileString', () => {
    const recorded = templateFileSystem(minimalTemplate);
    return Effect.gen(function* () {
      const files = yield* scaffold({
        frameworkSpec: '0.4.0',
        packageName: '@scope/status-plugin',
        pluginName: 'status-plugin',
        targetDirectory: '/project',
        targets: ['portable', 'cursor'],
        templateRoot,
      });
      // Sorted in code-unit order; the rename table restored the real names.
      expect(files).toEqual([
        '.gitignore',
        'README.md',
        'agent-bundle.config.ts',
        'package.json',
        'src/skills/getting-started/SKILL.md',
      ]);
      // Every directory on the way down is created recursively, parent first.
      expect(recorded.directories).toEqual([
        { path: '/project', recursive: true },
        { path: '/project/src', recursive: true },
        { path: '/project/src/skills', recursive: true },
        { path: '/project/src/skills/getting-started', recursive: true },
      ]);
      expect([...recorded.written.keys()].sort()).toEqual([
        '/project/.gitignore',
        '/project/README.md',
        '/project/agent-bundle.config.ts',
        '/project/package.json',
        '/project/src/skills/getting-started/SKILL.md',
      ]);
      expect(recorded.written.get('/project/.gitignore')).toBe('node_modules\n');
      expect(recorded.written.get('/project/README.md')).toBe('# status-plugin\n');
      expect(recorded.written.get('/project/src/skills/getting-started/SKILL.md')).toBe('---\nname: status-plugin\n---\n');
      expect(recorded.written.get('/project/agent-bundle.config.ts'))
        .toBe("export default { name: 'status-plugin', targets: ['portable', 'cursor'] };\n");
      expect(JSON.parse(recorded.written.get('/project/package.json') ?? '')).toEqual({
        devDependencies: { 'agent-bundle': '0.4.0' },
        name: '@scope/status-plugin',
      });
    }).pipe(Effect.provide(recorded.layer));
  });

  it.effect('validates the framework spec before creating or writing anything', () => {
    const recorded = templateFileSystem({
      ...minimalTemplate,
      [`${templateRoot}/package_json`]: `${JSON.stringify({
        dependencies: { '@agent-bundle/runtime': 'workspace:*' },
        name: 'my-agent-plugin',
      })}\n`,
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(scaffold({
        frameworkSpec: 'file:../agent-bundle-0.4.0.tgz',
        packageName: 'status-plugin',
        pluginName: 'status-plugin',
        targetDirectory: '/project',
        targets: ['portable'],
        templateRoot,
      }));
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain('Cannot inspect local package tarball "file:../agent-bundle-0.4.0.tgz"');
      expect(recorded.directories).toEqual([]);
      expect(recorded.written.size).toBe(0);
    }).pipe(Effect.provide(recorded.layer));
  });

  it.effect('reports the platform failure when the tarball cannot be read', () => Effect.gen(function* () {
    const error = yield* Effect.flip(assertLocalFrameworkTarball('file:/tmp/agent-bundle.tgz', '/project'));
    expect(error).toBeInstanceOf(UsageError);
    // No Node cause behind the noop error, so the PlatformError's own message is reported.
    expect((error as Error).message).toBe(
      'Cannot inspect local package tarball "file:/tmp/agent-bundle.tgz": '
      + 'NotFound: FileSystem.readFile (/tmp/agent-bundle.tgz): No such file or directory',
    );
  }).pipe(Effect.provide(Layer.merge(FileSystem.layerNoop({}), Path.layer))));
});

describe('assertScaffoldTarget over FileSystem.layerNoop', () => {
  const targetLayer = (entries: readonly string[] | PlatformError.PlatformError): Layer.Layer<FileSystem.FileSystem> =>
    FileSystem.layerNoop({
      readDirectory: () => (Array.isArray(entries) ? Effect.succeed([...entries]) : Effect.fail(entries as PlatformError.PlatformError)),
    });

  it.effect('treats a missing directory as available', () => Effect.gen(function* () {
    expect(yield* assertScaffoldTarget('/absent', 'absent')).toBeUndefined();
  }).pipe(Effect.provide(targetLayer(notFound('readDirectory', '/absent')))));

  it.effect('accepts an empty directory and a lone .git', () => Effect.gen(function* () {
    expect(yield* assertScaffoldTarget('/empty', 'empty').pipe(Effect.provide(targetLayer([])))).toBeUndefined();
    expect(yield* assertScaffoldTarget('/git-only', 'git-only').pipe(Effect.provide(targetLayer(['.git'])))).toBeUndefined();
  }));

  it.effect('rejects a directory with real contents as a usage error', () => Effect.gen(function* () {
    const error = yield* Effect.flip(assertScaffoldTarget('/occupied', 'my-plugin'));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toBe('Target directory "my-plugin" is not empty. Choose a new directory or empty it first.');
  }).pipe(Effect.provide(targetLayer(['.git', 'existing.txt']))));

  it.effect('lets every other platform failure through untouched', () => {
    const denied = PlatformError.systemError({
      _tag: 'PermissionDenied',
      method: 'readDirectory',
      module: 'FileSystem',
      pathOrDescriptor: '/locked',
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(assertScaffoldTarget('/locked', 'locked'));
      expect(error).toBe(denied);
    }).pipe(Effect.provide(targetLayer(denied)));
  });
});
