import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import * as Report from '../../fixtures/route-harness/src/cli/report.tsx';
import * as Catalog from '../../fixtures/route-harness/src/mcp/harness/tools/catalog.tsx';
import * as Summary from '../../fixtures/route-harness/src/scripts/summary.tsx';
import { AgentTestError } from '../../src/test/errors.ts';
import { loadRouteModule, renderRoute } from '../../src/test/render.ts';
import { testManifest } from '../../src/test/registry.ts';

const rejection = async (load: Promise<unknown>): Promise<AgentTestError> => {
  try {
    await load;
  } catch (thrown: unknown) {
    return thrown as AgentTestError;
  }
  throw new Error('The load resolved, so no harness diagnostic was produced.');
};

/**
 * `loadRouteModule` (#493) is the supported replacement for a hand-maintained
 * list of static route imports in a schema-identity suite: the evaluated
 * module comes back through the same registered loader `renderRoute` uses, so
 * its schemas are the route's own instances, not copies.
 */
describe('loadRouteModule', () => {
  it('returns the evaluated tool module whose schemas are the very instances the route exports', async () => {
    const module = await loadRouteModule('tool:harness/catalog');

    // Identity, not shape: the same objects the statically imported module holds.
    expect(module.inputSchema).toBe(Catalog.inputSchema);
    expect(module.resultSchema).toBe(Catalog.resultSchema);
    expect(module.default).toBe(Catalog.default);
    expect(module.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(module.resultSchema).toBeInstanceOf(z.ZodObject);
    expect(typeof module.default).toBe('function');
    // The static config the compiler extracted into the manifest is the module's.
    expect(module.config).toEqual(testManifest().routes['tool:harness/catalog']!.config);
  });

  it('loads every renderable route id the manifest reports, including CLI commands and scripts', async () => {
    const manifest = testManifest();
    // Loading evaluates the module exactly as an import does. The fixture's
    // scripts include deliberately broken, blank, self-executing, and
    // never-settling modules for the script-dispatch level, so scripts are
    // loaded by name below and every other renderable kind is swept here.
    const loadable = Object.values(manifest.routes)
      .filter((route) => route.kind !== 'app' && route.kind !== 'script');
    expect(loadable.map((route) => route.kind)).toEqual(expect.arrayContaining(['cli', 'event-route', 'prompt', 'resource', 'tool']));

    for (const route of loadable) {
      const module = await loadRouteModule(route.id);
      expect(typeof module.default, route.id).toBe('function');
      // The compiler records `{}` for a module that exports no static config.
      expect(module.config ?? {}, route.id).toEqual(route.config);
    }

    const report = await loadRouteModule('cli:report');
    expect(report.inputSchema).toBe(Report.inputSchema);
    expect(report.resultSchema).toBe(Report.resultSchema);
    expect(report.config).toBe(Report.config);

    // A rendered script default-exports its component; a plain `.ts` script's
    // contract is `main`, so `default` is not required of it.
    const summary = await loadRouteModule('script:summary');
    expect(summary.default).toBe(Summary.default);
    expect(summary.inputSchema).toBeUndefined();

    const checksum = await loadRouteModule('script:checksum');
    expect(checksum.default).toBeUndefined();
    expect(typeof checksum['main']).toBe('function');
  });

  it('returns one module instance per route, the one renderRoute renders', async () => {
    const [first, second] = await Promise.all([
      loadRouteModule('tool:harness/echo'),
      loadRouteModule('tool:harness/echo'),
    ]);
    expect(first).toBe(second);

    // The rendered document's value parses through the very schema the loaded
    // module exports, so the harness and the consumer agree on one contract.
    const rendered = await renderRoute('tool:harness/echo', { input: { message: 'identity' } });
    expect(first.resultSchema!.parse(rendered.document.value)).toEqual(rendered.result);
  });

  it('rejects an id the manifest does not compile with the compiled ids', async () => {
    const error = await rejection(loadRouteModule('tool:harness/missing'));

    expect(error).toBeInstanceOf(AgentTestError);
    expect(error.code).toBe('route-not-found');
    expect(error.message).toContain('tool:harness/catalog');
  });

  it('refuses an App route, which is a browser build', async () => {
    const appId = Object.values(testManifest().routes).find((route) => route.kind === 'app')?.id;
    expect(appId).toBeDefined();

    const error = await rejection(loadRouteModule(appId!));
    expect(error.code).toBe('unsupported-route-kind');
  });

  it('fails closed for a manifest whose loaders are not the registered ones', async () => {
    const compiled = testManifest();
    const foreign = { ...compiled, digest: `${compiled.digest}-foreign`, projectRoot: `${compiled.projectRoot}-sibling` };

    const error = await rejection(loadRouteModule('tool:harness/catalog', { manifest: foreign }));

    expect(error).toBeInstanceOf(AgentTestError);
    expect(error.code).toBe('manifest-unavailable');
    expect(error.message).toContain('not the ones registered in this test process');
    expect(error.message).toContain(`registered:   ${compiled.digest}`);
  });
});
