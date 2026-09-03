import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from '@rstest/core';

import { generatedMetaModuleSource, metaModuleSpecifier, projectMeta } from '../src/build/meta.ts';
import { isDiagnostic } from '../src/core/diagnostics.ts';
import { ProjectService } from '../src/dev/project-service.ts';
import type { AgentBundleMeta } from '../src/meta.ts';
import {
  META_UNAVAILABLE_CODE,
  META_UNAVAILABLE_RECOVERY,
  MetaUnavailableError,
  metaUnavailableDiagnostic,
} from '../src/meta-diagnostic.ts';
import { agentBundleRstest } from '../src/rstest/index.ts';
import { metaModuleAliasKey } from '../src/rstest/meta-module.ts';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/meta-consumer');
const metaModulePath = resolve(fixtureRoot, '.agent-bundle', 'test', 'meta.mjs');

type GeneratedMetaModule = AgentBundleMeta & { readonly default: AgentBundleMeta; readonly meta: AgentBundleMeta };

describe('agentBundleRstest aliases agent-bundle/meta (#386)', () => {
  it('routes the reserved specifier to a generated identity module under the project temp dir', async () => {
    const config = await agentBundleRstest({ root: fixtureRoot });

    expect(metaModuleAliasKey).toBe(`${metaModuleSpecifier}$`);
    expect(config.resolve).toEqual({ alias: { [metaModuleAliasKey]: metaModulePath } });
  });

  it('writes exactly the module the build injects, fed from the same package identity', async () => {
    await agentBundleRstest({ root: fixtureRoot });
    const written = await readFile(metaModulePath, 'utf8');

    // The build stamps `projectMeta(model.metadata)` from the same preparation.
    const prepared = await new ProjectService({ root: fixtureRoot }).prepare('inspect');
    expect(prepared.model).toBeDefined();
    const stamped = projectMeta(prepared.model!.metadata);
    expect(written).toBe(generatedMetaModuleSource(stamped));

    const packageJson = JSON.parse(await readFile(resolve(fixtureRoot, 'package.json'), 'utf8')) as {
      readonly name: string;
      readonly version: string;
    };
    expect(stamped).toEqual({
      name: 'meta-consumer',
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      version: packageJson.version,
    });

    const loaded = await import(pathToFileURL(metaModulePath).href) as GeneratedMetaModule;
    expect({
      name: loaded.name,
      packageName: loaded.packageName,
      packageVersion: loaded.packageVersion,
      version: loaded.version,
    }).toEqual(stamped);
    expect(loaded.meta).toEqual(stamped);
    expect(loaded.default).toBe(loaded.meta);
    expect(Object.isFrozen(loaded.meta)).toBe(true);
  });
});

describe('the published agent-bundle/meta module outside the compiler', () => {
  it('rejects with the AB4760 diagnostic carrying the exact recovery', async () => {
    let thrown: unknown;
    try {
      await import('../src/meta.ts');
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MetaUnavailableError);
    const error = thrown as MetaUnavailableError;
    expect(error.name).toBe('AgentBundleMetaUnavailableError');
    expect(error.code).toBe(META_UNAVAILABLE_CODE);
    expect(error.code).toBe('AB4760');
    expect(error.recovery).toBe(META_UNAVAILABLE_RECOVERY);
    expect(error.message).toContain('[AB4760] agent-bundle/meta is available only inside a surface Agent Bundle compiles');
    expect(error.message).toContain('recovery: Run the test under agentBundleRstest() or agentBundleBrowserRstest()');
    expect(error.message).toContain('alias `agent-bundle/meta`');
    expect(error.diagnostic).toEqual(metaUnavailableDiagnostic());
  });

  it('reports the diagnostic in the shared AB diagnostic shape', () => {
    const diagnostic = metaUnavailableDiagnostic();

    expect(isDiagnostic(diagnostic)).toBe(true);
    expect(diagnostic).toMatchObject({ code: 'AB4760', severity: 'error' });
    expect(diagnostic.recovery).toContain('agentBundleRstest()');
    expect(diagnostic.recovery).toContain('agent-bundle build');
    expect(diagnostic.recovery).toContain('.agent-bundle/test/meta.mjs');
    expect(Object.isFrozen(diagnostic)).toBe(true);
  });
});
