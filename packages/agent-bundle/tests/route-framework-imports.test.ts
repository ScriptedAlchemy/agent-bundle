import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import {
  compilerCarryingSpecifiers,
  type FrameworkValueImport,
  scanFrameworkValueImports,
  validateRouteFrameworkImports,
} from '../src/routes/framework-imports.ts';

/**
 * AB4837 (#558): a route module that value-imports a compiler-carrying
 * framework entry — directly or through a relative helper — is reported at
 * route-graph compile time instead of failing inside the bundler. The scan
 * is static and must never report an import the bundler's SWC transform
 * would elide, so every rule below has its type-only mirror.
 */

const route = '/project/src/cli/dashboard.ts';

const scan = (
  text: string,
  modules: Readonly<Record<string, string>> = {},
  source = route,
): readonly FrameworkValueImport[] =>
  scanFrameworkValueImports(text, { readModule: (path) => modules[path], source });

const specifiersOf = (findings: readonly FrameworkValueImport[]): string[] =>
  findings.map((finding) => `${finding.form} ${finding.specifier}`);

const lines = (...text: readonly string[]): string => `${text.join('\n')}\n`;

describe('compilerCarryingSpecifiers', () => {
  it('names exactly the framework entries whose module graph carries the compiler', () => {
    expect([...compilerCarryingSpecifiers]).toEqual([
      'agent-bundle',
      'agent-bundle/api',
      'agent-bundle/config',
      'agent-bundle/eval',
      'agent-bundle/rstest',
      'agent-bundle/test',
      'agent-bundle/test/browser',
    ]);
    expect(Object.isFrozen(compilerCarryingSpecifiers)).toBe(true);
  });

  it('matches specifiers exactly and leaves bundle-safe entries and other packages alone', () => {
    const clean = scan(lines(
      "import 'agent-bundle/routes';",
      "import { appResourceUri } from 'agent-bundle/routes';",
      "import { launchEnv } from 'agent-bundle/launch-env';",
      "import { spawnServeApp } from 'agent-bundle/serve-app-command';",
      "import { deeper } from 'agent-bundle/api/deeper';",
      "import { z } from 'zod';",
      "import { local } from './local';",
      "export * from 'agent-bundle/meta';",
      "const later = await import('agent-bundle/mcp-entry');",
      'export default async () => [appResourceUri, launchEnv, spawnServeApp, deeper, z, local, later];',
    ));
    expect(clean).toEqual([]);
    expect(Object.isFrozen(clean)).toBe(true);
  });

  it('reports every compiler-carrying entry when imported as a value', () => {
    for (const specifier of compilerCarryingSpecifiers) {
      expect(specifiersOf(scan(`import ${JSON.stringify(specifier)};\n`))).toEqual([`side-effect ${specifier}`]);
    }
  });
});

describe('import forms', () => {
  it('reports a side-effect import', () => {
    expect(scan("import 'agent-bundle/api';\n")).toEqual([
      { form: 'side-effect', importer: route, specifier: 'agent-bundle/api' },
    ]);
  });

  it('reports a literal dynamic import anywhere in the module, including inside an async default export', () => {
    const findings = scan(lines(
      "import { z } from 'zod';",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ url: z.string() }).strict();',
      'export default async function dashboard() {',
      "  const { serveApp } = await import('agent-bundle/api');",
      "  const served = await serveApp({ app: 'curator/dashboard' });",
      '  return { url: served.url };',
      '}',
    ));
    expect(findings).toEqual([{ form: 'dynamic', importer: route, specifier: 'agent-bundle/api' }]);
    // A substitution-free template literal is a literal the bundler resolves too.
    expect(specifiersOf(scan('const api = () => import(`agent-bundle/api`);\n'))).toEqual(['dynamic agent-bundle/api']);
  });

  it('ignores a dynamic import with a non-literal argument', () => {
    expect(scan(lines(
      "const specifier = 'agent-bundle/api';",
      'export default async () => import(specifier);',
      'export const other = async (name: string) => import(`agent-bundle/${name}`);',
    ))).toEqual([]);
  });

  it('reports value re-exports and skips type-only ones', () => {
    expect(specifiersOf(scan("export { serveApp } from 'agent-bundle/api';\n"))).toEqual(['reexport agent-bundle/api']);
    expect(specifiersOf(scan("export * from 'agent-bundle/api';\n"))).toEqual(['reexport agent-bundle/api']);
    expect(specifiersOf(scan("export * as api from 'agent-bundle/api';\n"))).toEqual(['reexport agent-bundle/api']);
    expect(specifiersOf(scan("export { type ServeAppOptions, serveApp } from 'agent-bundle/api';\n"))).toEqual(['reexport agent-bundle/api']);
    expect(scan("export type { ServeAppOptions } from 'agent-bundle/api';\n")).toEqual([]);
    expect(scan("export { type ServeAppOptions, type ServeAppHandle } from 'agent-bundle/api';\n")).toEqual([]);
    expect(scan("export {} from 'agent-bundle/api';\n")).toEqual([]);
  });

  it('never reports import type or an import whose every specifier is type-qualified', () => {
    expect(scan(lines(
      "import type { ToolConfig, ToolRouteProps } from 'agent-bundle';",
      "import type Api from 'agent-bundle/api';",
      "import type * as Config from 'agent-bundle/config';",
      "import { type Suite, type Trial } from 'agent-bundle/eval';",
      "import {} from 'agent-bundle/test';",
      'export const config = { description: "x" } satisfies ToolConfig;',
      'export default async ({ input }: ToolRouteProps<Suite>) => [input, null as unknown as Api, null as unknown as Config.Options, null as Trial | null];',
    ))).toEqual([]);
  });
});

describe('static import value positions', () => {
  const rendered = '/project/src/cli/dashboard.tsx';
  const staticImport = (body: string, clause = '{ serveApp }', source = route): readonly FrameworkValueImport[] =>
    scan(`import ${clause} from 'agent-bundle/api';\n${body}\n`, {}, source);
  const reported = (body: string, clause?: string, source?: string): boolean =>
    staticImport(body, clause, source).length === 1;

  it('reports a binding read in a value position', () => {
    expect(staticImport('export default async () => serveApp({ app: "x" });')).toEqual([
      { form: 'static', importer: route, specifier: 'agent-bundle/api' },
    ]);
    expect(reported('const run = serveApp;')).toBe(true);
    expect(reported('export default serveApp;')).toBe(true);
    expect(reported('const value = typeof serveApp;')).toBe(true);
    expect(reported('const handle = new serveApp();')).toBe(true);
    expect(reported('const uri = serveApp.url;')).toBe(true);
    expect(reported('const uri = serveApp?.url;')).toBe(true);
    expect(reported('const entry = registry[serveApp];')).toBe(true);
    expect(reported('const keyed = { [serveApp]: 1 };')).toBe(true);
    expect(reported('enum Modes { Serve = serveApp }')).toBe(true);
    expect(reported('const tagged = serveApp`template`;')).toBe(true);
    expect(reported('const dashboard = <ServeApp />;', '{ ServeApp }', rendered)).toBe(true);
    expect(reported('const dashboard = <ServeApp.Panel />;', '{ ServeApp }', rendered)).toBe(true);
    expect(reported('const element = <div onClick={serveApp} />;', '{ serveApp }', rendered)).toBe(true);
    expect(reported('const { url = serveApp } = {};')).toBe(true);
    expect(reported('@serveApp class Decorated {}')).toBe(true);
  });

  it('treats a shorthand property, a local re-export, a class extends, and the value side of as/satisfies as value references', () => {
    expect(reported('export const config = { serveApp };')).toBe(true);
    expect(reported('export { serveApp };')).toBe(true);
    expect(reported('export { serveApp as run };')).toBe(true);
    expect(reported('export { serveApp as default };')).toBe(true);
    expect(reported('class Dashboard extends serveApp {}', '{ serveApp }')).toBe(true);
    expect(reported('class Dashboard extends serveApp<string> {}', '{ serveApp }')).toBe(true);
    expect(reported('const checked = serveApp satisfies unknown;')).toBe(true);
    expect(reported('const cast = serveApp as unknown;')).toBe(true);
  });

  it('does not report a binding used only in type positions, with or without the type keyword', () => {
    expect(reported('let options: serveApp;')).toBe(false);
    expect(reported('let options: serveApp<string>;')).toBe(false);
    expect(reported('let handle: typeof serveApp;')).toBe(false);
    expect(reported('let handle: ReturnType<typeof serveApp>;')).toBe(false);
    expect(reported('type Handle = serveApp;')).toBe(false);
    expect(reported('interface Handle extends serveApp {}')).toBe(false);
    expect(reported('interface Handle { open(): serveApp }')).toBe(false);
    expect(reported('class Dashboard implements serveApp {}')).toBe(false);
    expect(reported('class Dashboard extends Base<serveApp> {}')).toBe(false);
    expect(reported('const run = <T extends serveApp>(value: T) => value;')).toBe(false);
    expect(reported('function open(options: serveApp): serveApp { return options; }')).toBe(false);
    expect(reported('const cast = value as serveApp;')).toBe(false);
    expect(reported('const checked = value satisfies serveApp;')).toBe(false);
    expect(reported('const asserted = (value: unknown): value is serveApp => true;')).toBe(false);
    expect(reported("let api: typeof import('agent-bundle/api');")).toBe(false);
    expect(reported("let handle: import('agent-bundle/api').ServeAppHandle;")).toBe(false);
    expect(reported('declare const ambient: serveApp;')).toBe(false);
    expect(reported('declare class Ambient extends serveApp {}')).toBe(false);
    expect(reported('export type { serveApp };')).toBe(false);
    expect(reported('export { type serveApp };')).toBe(false);
  });

  it('does not count a property, member, or declaration name that merely spells the binding', () => {
    expect(reported('const uri = registry.serveApp;')).toBe(false);
    expect(reported('const options = { serveApp: 1 };')).toBe(false);
    expect(reported('const options = { serveApp() { return 1; } };')).toBe(false);
    expect(reported('const options = { get serveApp() { return 1; } };')).toBe(false);
    expect(reported('class Dashboard { serveApp = 1; }')).toBe(false);
    expect(reported('class Dashboard { serveApp() { return 1; } }')).toBe(false);
    expect(reported('interface Dashboard { serveApp: string }')).toBe(false);
    expect(reported('enum Dashboard { serveApp }')).toBe(false);
    expect(reported('const { serveApp: local } = registry;')).toBe(false);
    expect(reported('function open({ serveApp }: { serveApp: string }) { return 1; }')).toBe(false);
    expect(reported('const element = <div serveApp="x" />;', '{ serveApp }', rendered)).toBe(false);
    // A lowercase JSX tag is an intrinsic element (`jsx("serveApp")`), never the binding.
    expect(reported('const element = <serveApp />;', '{ serveApp }', rendered)).toBe(false);
    expect(reported("import { meta } from 'agent-bundle';\nconst here = import.meta.url;", '{ serveApp }')).toBe(false);
    expect(reported('serveApp: for (const step of []) { break serveApp; }')).toBe(false);
  });

  it('reports default and namespace bindings by the same rule', () => {
    expect(specifiersOf(staticImport('export default async () => api.serveApp();', '* as api'))).toEqual(['static agent-bundle/api']);
    expect(staticImport('let options: api.ServeAppOptions;', '* as api')).toEqual([]);
    expect(staticImport('let handle: typeof api.serveApp;', '* as api')).toEqual([]);
    expect(specifiersOf(staticImport('export default async () => api();', 'api'))).toEqual(['static agent-bundle/api']);
    expect(staticImport('let handle: api;', 'api')).toEqual([]);
    expect(specifiersOf(staticImport('export default async () => api();', 'api, { type ServeAppOptions }'))).toEqual(['static agent-bundle/api']);
    expect(staticImport('let handle: Api;', 'Api, { type ServeAppOptions }')).toEqual([]);
  });

  it('reports the specifier once when several bindings of one import are used', () => {
    expect(specifiersOf(scan(lines(
      "import { build, serveApp } from 'agent-bundle/api';",
      "import { defineConfig } from 'agent-bundle/config';",
      'export default async () => [build, serveApp];',
      'export const unused: typeof defineConfig | undefined = undefined;',
    )))).toEqual(['static agent-bundle/api']);
  });
});

describe('relative import graph', () => {
  const helpers: Readonly<Record<string, string>> = {
    '/project/src/cli/serve.ts': lines(
      "import { serveApp } from 'agent-bundle/api';",
      'export const open = async () => serveApp({ app: "x" });',
    ),
    '/project/src/cli/serve-types.ts': lines(
      "import { serveApp } from 'agent-bundle/api';",
      'export type Open = typeof serveApp;',
    ),
    '/project/src/cli/widgets/index.tsx': lines(
      "import { build } from 'agent-bundle';",
      'export const Widget = () => build;',
    ),
    '/project/src/shared/leaf.ts': "import 'agent-bundle/test';\n",
    '/project/src/shared/a.ts': lines(
      "import { b } from './b.ts';",
      "import { leaf } from './leaf.ts';",
      'export const a = () => [b, leaf];',
    ),
    '/project/src/shared/b.ts': lines(
      "import { a } from './a.ts';",
      "import { leaf } from './leaf.ts';",
      'export const b = () => [a, leaf];',
    ),
    '/project/src/cli/cycle-a.ts': "export { b } from './cycle-b.ts';\n",
    '/project/src/cli/cycle-b.ts': "export { a } from './cycle-a.ts';\n",
    '/project/src/cli/quiet.ts': "export const quiet = 1;\n",
  };

  it('follows a relative value import and names the helper as the importer', () => {
    expect(scan(lines(
      "import { open } from './serve.ts';",
      'export default async () => open();',
    ), helpers)).toEqual([
      { form: 'static', importer: '/project/src/cli/serve.ts', specifier: 'agent-bundle/api' },
    ]);
  });

  it('follows every value-import form of a relative module, using the shared candidate order', () => {
    // A `.js` spelling maps onto its TypeScript source; an extensionless directory resolves its index module.
    expect(scan("import { open } from './serve.js';\nexport default open;\n", helpers)).toHaveLength(1);
    expect(scan("import { Widget } from './widgets';\nexport default Widget;\n", helpers)).toEqual([
      { form: 'static', importer: '/project/src/cli/widgets/index.tsx', specifier: 'agent-bundle' },
    ]);
    expect(scan("import './serve.ts';\n", helpers)).toHaveLength(1);
    expect(scan("export * from './serve.ts';\n", helpers)).toHaveLength(1);
    expect(scan("export { open } from './serve.ts';\n", helpers)).toHaveLength(1);
    expect(scan("export * as serve from './serve.ts';\n", helpers)).toHaveLength(1);
    expect(scan("export default async () => import('./serve.ts');\n", helpers)).toHaveLength(1);
  });

  it('does not follow a relative import the bundler would elide', () => {
    expect(scan("import type { Open } from './serve.ts';\nexport default (open: Open) => open;\n", helpers)).toEqual([]);
    expect(scan("import { open } from './serve.ts';\nexport default (run: typeof open) => run;\n", helpers)).toEqual([]);
    expect(scan("export type { Open } from './serve.ts';\n", helpers)).toEqual([]);
    expect(scan("import { type Open } from './serve.ts';\n", helpers)).toEqual([]);
  });

  it('applies the value rules inside the helper too', () => {
    expect(scan("import type { Open } from './serve-types.ts';\nexport default (open: Open) => open;\n", helpers)).toEqual([]);
    expect(scan("export * from './serve-types.ts';\n", helpers)).toEqual([]);
    expect(scan("export * from './quiet.ts';\n", helpers)).toEqual([]);
  });

  it('terminates on import cycles and scans a shared module once', () => {
    expect(scan("export * from './cycle-a.ts';\n", helpers)).toEqual([]);
    expect(scan("import { a } from '../shared/a.ts';\nexport default a;\n", helpers)).toEqual([
      { form: 'side-effect', importer: '/project/src/shared/leaf.ts', specifier: 'agent-bundle/test' },
    ]);
  });

  it('ignores a relative import no candidate file satisfies', () => {
    expect(scan("import { missing } from './missing.ts';\nexport default missing;\n", helpers)).toEqual([]);
  });

  it('lists the scanned module\'s own findings first, then helpers by importer, specifier, and form', () => {
    const findings = scan(lines(
      "import { open } from './serve.ts';",
      "import { Widget } from './widgets';",
      "import { z } from 'agent-bundle/test';",
      "export * from 'agent-bundle/config';",
      "import 'agent-bundle/config';",
      'export default async () => [open, Widget, z];',
    ), helpers);
    expect(findings).toEqual([
      { form: 'reexport', importer: route, specifier: 'agent-bundle/config' },
      { form: 'side-effect', importer: route, specifier: 'agent-bundle/config' },
      { form: 'static', importer: route, specifier: 'agent-bundle/test' },
      { form: 'static', importer: '/project/src/cli/serve.ts', specifier: 'agent-bundle/api' },
      { form: 'static', importer: '/project/src/cli/widgets/index.tsx', specifier: 'agent-bundle' },
    ]);
    expect(findings.every((finding) => Object.isFrozen(finding))).toBe(true);
  });
});

describe('validateRouteFrameworkImports', () => {
  const recovery =
    'Keep framework calls in a host process: serve an MCP App from a routed command with spawnServeApp from agent-bundle/serve-app-command, which spawns agent-bundle serve-app; use import type for framework types; otherwise move the call into a package.json script or a hand-written .mjs run from the checkout.';

  it('reports one AB4837 naming the route, the specifier, and the executable', () => {
    const diagnostics = validateRouteFrameworkImports(
      lines(
        "import { z } from 'zod';",
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ url: z.string() }).strict();',
        'export default async function dashboard() {',
        "  const { serveApp } = await import('agent-bundle/api');",
        "  return { url: (await serveApp({ app: 'curator/dashboard' })).url };",
        '}',
      ),
      'src/cli/dashboard.ts',
      route,
      'routed CLI executable',
    );
    expect(diagnostics).toEqual([{
      code: 'AB4837',
      message: 'Route module src/cli/dashboard.ts imports "agent-bundle/api" as a value; the routed CLI executable is self-contained and cannot bundle the compiler, so the build would fail deep inside the generated executable (an unresolvable compiler module or AB6005) instead of at this import.',
      recovery,
      severity: 'error',
      sourcePath: route,
    }]);
    expect(Object.isFrozen(diagnostics)).toBe(true);
  });

  it('reports at most one diagnostic per module, the first finding in scan order', () => {
    const diagnostics = validateRouteFrameworkImports(
      lines(
        "import 'agent-bundle/test';",
        "import { defineConfig } from 'agent-bundle/config';",
        "export * from 'agent-bundle/eval';",
        'export default async () => defineConfig({});',
      ),
      'src/scripts/rebuild.ts',
      '/project/src/scripts/rebuild.ts',
      'script executable',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe(
      'Route module src/scripts/rebuild.ts imports "agent-bundle/config" as a value; the script executable is self-contained and cannot bundle the compiler, so the build would fail deep inside the generated executable (an unresolvable compiler module or AB6005) instead of at this import.',
    );
  });

  it('returns a frozen empty list for a module with no compiler-carrying value import', () => {
    const diagnostics = validateRouteFrameworkImports(
      "import type { ToolConfig } from 'agent-bundle';\nexport const config = {} satisfies ToolConfig;\nexport default async () => undefined;\n",
      'src/mcp/curator/tools/inspect.tsx',
      '/project/src/mcp/curator/tools/inspect.tsx',
      'generated MCP server',
    );
    expect(diagnostics).toEqual([]);
    expect(Object.isFrozen(diagnostics)).toBe(true);
  });

  it('addresses layouts and providers by the subject the caller names', () => {
    const [diagnostic] = validateRouteFrameworkImports(
      "import { build } from 'agent-bundle/api';\nexport default ({ children }) => [build, children];\n",
      'src/layout.tsx',
      '/project/src/layout.tsx',
      'generated executable',
      'Layout module',
    );
    expect(diagnostic?.message).toBe(
      'Layout module src/layout.tsx imports "agent-bundle/api" as a value; the generated executable is self-contained and cannot bundle the compiler, so the build would fail deep inside the generated executable (an unresolvable compiler module or AB6005) instead of at this import.',
    );
    expect(diagnostic?.sourcePath).toBe('/project/src/layout.tsx');
  });
});

describe('validateRouteFrameworkImports through a relative helper', () => {
  // The validator reads helpers from disk, so the fixture is a real tree.
  const withProject = <T>(files: Readonly<Record<string, string>>, run: (root: string) => T): T => {
    const root = mkdtempSync(join(tmpdir(), 'agent-bundle-framework-imports-'));
    try {
      for (const [path, contents] of Object.entries(files)) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
      }
      return run(root);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  };

  it('names the helper project-relative when it lies inside the project', () => {
    withProject({
      'project/src/cli/serve.ts': "import { serveApp } from 'agent-bundle/api';\nexport const open = () => serveApp;\n",
    }, (root) => {
      const [diagnostic] = validateRouteFrameworkImports(
        "import { open } from './serve.ts';\nexport default async () => open();\n",
        'src/cli/dashboard.ts',
        join(root, 'project', 'src', 'cli', 'dashboard.ts'),
        'routed CLI executable',
      );
      expect(diagnostic?.message).toBe(
        'Route module src/cli/dashboard.ts imports "agent-bundle/api" as a value (via src/cli/serve.ts); the routed CLI executable is self-contained and cannot bundle the compiler, so the build would fail deep inside the generated executable (an unresolvable compiler module or AB6005) instead of at this import.',
      );
      expect(diagnostic?.sourcePath).toBe(join(root, 'project', 'src', 'cli', 'dashboard.ts'));
    });
  });

  it('falls back to a route-relative spelling for a helper outside the project root', () => {
    withProject({
      'shared/serve.ts': "import { serveApp } from 'agent-bundle/api';\nexport const open = () => serveApp;\n",
    }, (root) => {
      const [diagnostic] = validateRouteFrameworkImports(
        "import { open } from '../../../shared/serve.ts';\nexport default async () => open();\n",
        'src/cli/dashboard.ts',
        join(root, 'project', 'src', 'cli', 'dashboard.ts'),
        'routed CLI executable',
      );
      expect(diagnostic?.message).toContain('as a value (via ../../../shared/serve.ts);');
    });
  });
});
