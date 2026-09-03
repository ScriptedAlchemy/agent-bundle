import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { agentBundleBrowserRstest } from '../src/rstest/browser.ts';
import {
  AGENT_BROWSER_TEST_REGISTRY_SYMBOL_KEY,
  AGENT_BROWSER_TEST_REGISTRY_VERSION,
} from '../src/test/browser-registry.ts';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/route-harness');

describe('agentBundleBrowserRstest', () => {
  it('compiles every declared app once and writes the browser registry', { timeout: 30_000 }, async () => {
    const config = await agentBundleBrowserRstest({
      root: fixtureRoot,
      setupFiles: ['./tests/setup.ts'],
    });

    expect(config).toMatchObject({
      browser: {
        enabled: true,
        headless: true,
        provider: 'playwright',
        providerOptions: { launch: { channel: 'chrome' } },
        viewport: { height: 900, width: 1440 },
      },
      include: ['tests/browser-app/**/*.test.{ts,tsx}'],
      resolve: { alias: { 'agent-bundle/meta$': resolve(fixtureRoot, '.agent-bundle/test/meta.mjs') } },
      setupFiles: [
        resolve(fixtureRoot, '.agent-bundle/test/browser-app-setup.mjs'),
        './tests/setup.ts',
      ],
      tools: {
        rspack: {
          resolve: {
            extensionAlias: { '.js': ['.js', '.ts', '.tsx'], '.jsx': ['.jsx', '.tsx'] },
          },
        },
      },
    });

    const setup = await readFile(config.setupFiles[0]!, 'utf8');
    expect(setup).toContain(`"version":${String(AGENT_BROWSER_TEST_REGISTRY_VERSION)}`);
    expect(setup).toContain(`Symbol.for(${JSON.stringify(AGENT_BROWSER_TEST_REGISTRY_SYMBOL_KEY)})`);
    expect(setup).toContain('"name":"panel"');
    expect(setup).toContain('"resourceUri":"ui://harness/panel"');
    expect(setup).toContain('"serverIds":["mcp:harness"]');
    expect(setup).toContain('"target":"claude"');
    expect(setup).toContain('"html":"<!DOCTYPE html>');
    expect(setup).toContain('"proofLevel":"browser-app"');
    expect(setup).toContain('"output":');

    // The same compiler pass stamps the identity module `agent-bundle/meta`
    // resolves to inside the browser pool (#386).
    const metaModule = await readFile(config.resolve.alias['agent-bundle/meta$']!, 'utf8');
    expect(metaModule).toContain('export const name = "route-harness";');
    expect(metaModule).toContain('export const version = "1.0.0";');
    expect(metaModule).toContain('export const packageName = undefined;');
  });

  it('rejects a browser pool whose compiled manifest declares no apps', async () => {
    const root = resolve(import.meta.dirname, '../../../fixtures/integration/skills-only');

    await expect(agentBundleBrowserRstest({ root })).rejects.toThrow(
      `Browser-App test pool for ${JSON.stringify(resolve(root, 'agent-bundle.config.ts'))} declares no MCP Apps to prove.`,
    );
  });
});
