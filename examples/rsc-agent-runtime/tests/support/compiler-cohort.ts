import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Minimal on-disk compiler cohort fixture shared by generation and checkpoint suites. */

export const definitionJson = '{"nativeHooks":[],"resources":[],"tools":[]}';

export const runtimeFiles = {
  'chunks/101.js': 'async-chunk',
  'dev/definition.js': `process.stdout.write(${JSON.stringify(`${definitionJson}\n`)});\n`,
  'dev/invoke.js': 'invoke-worker',
  'hook/index.js': 'hook-entry',
  'mcp/http.js': 'http-entry',
  'mcp/stdio.js': 'stdio-entry',
  'rsc/index.js': 'rsc-entry',
} as const;

export const widgetFiles = {
  'rsc/index.html': '<!doctype html><script src="/static/js/rsc/index.js"></script>',
  'static/js/rsc/index.js': 'client-reference',
} as const;

export const appFiles = {
  'edit-timeline-v1.html': '<!doctype html><main>Timeline</main>',
  'edit-timeline-v2.html': '<!doctype html><main>Timeline v2</main>',
  'activity-v1.html': '<!doctype html><main>Activity</main>',
} as const;

export const writeTree = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  await Promise.all(Object.entries(files).map(async ([path, contents]) => {
    const destination = join(root, ...path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, 'utf8');
  }));
};

export const writeCompilerCohort = async (
  compilerRoot: string,
  options: Readonly<{
    readonly appFiles?: Readonly<Record<string, string>>;
    readonly rscFiles?: Readonly<Record<string, string>>;
    readonly widgetFiles?: Readonly<Record<string, string>>;
  }> = {},
): Promise<void> => {
  const rscRoot = join(compilerRoot, 'rsc');
  await writeTree(rscRoot, { ...runtimeFiles, ...options.rscFiles });
  await mkdir(join(compilerRoot, 'app'), { recursive: true });
  await writeTree(join(compilerRoot, 'app'), options.appFiles ?? appFiles);
  await writeTree(join(compilerRoot, 'widget'), { ...widgetFiles, ...options.widgetFiles });
  await writeFile(join(rscRoot, 'runtime-assets.json'), JSON.stringify({
    allFiles: Object.keys(runtimeFiles).map((path) => `/${path}`),
    entries: {
      'dev/definition': { initial: { js: ['/dev/definition.js'] } },
      'dev/invoke': { initial: { js: ['/dev/invoke.js'] } },
      'hook/index': { initial: { js: ['/hook/index.js'] } },
      'mcp/http': { async: { js: ['/chunks/101.js'] }, initial: { js: ['/mcp/http.js'] } },
      'mcp/stdio': { async: { js: ['/chunks/101.js'] }, initial: { js: ['/mcp/stdio.js'] } },
      'rsc/index': { async: { js: ['/chunks/101.js'] }, initial: { js: ['/rsc/index.js'] } },
    },
  }), 'utf8');
};
