import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(websiteRoot, 'doc_build');

/**
 * Every public `agent-bundle` export entry module, mapped to the page name
 * TypeDoc's `kind` router derives from it.
 *
 * `pluginTypeDoc` skips its output silently when TypeDoc conversion fails, and
 * the committed API `_meta.json` sidebars are only rewritten by hand, so this
 * table is what makes a dropped export or a stale sidebar loud.
 */
const publicApiEntryModules = {
  'index.ts': 'index',
  'api.ts': 'api',
  'cli-entry.ts': 'cli-entry',
  'config/index.ts': 'config',
  'eval/index.ts': 'eval',
  'mcp-apps.ts': 'mcp-apps',
  'meta.ts': 'meta',
  'mcp-entry.ts': 'mcp-entry',
  'rstest/index.ts': 'rstest',
  'test/index.ts': 'test',
  'test/browser.ts': 'test_browser',
};

const apiRoutePrefixes = ['api', 'zh/api'];

const requiredArtifacts = [
  { artifact: 'index.html', reason: 'English homepage' },
  { artifact: 'zh/index.html', reason: 'Chinese homepage' },
  { artifact: 'api/index.html', reason: 'English generated API reference' },
  { artifact: 'zh/api/index.html', reason: 'Chinese generated API reference' },
  { artifact: 'llms.txt', reason: 'English llms.txt' },
  { artifact: 'llms-full.txt', reason: 'English llms-full.txt' },
  { artifact: 'zh/llms.txt', reason: 'Chinese llms.txt' },
  { artifact: 'zh/llms-full.txt', reason: 'Chinese llms-full.txt' },
  { artifact: 'sitemap.xml', reason: 'sitemap' },
  ...apiRoutePrefixes.flatMap(prefix =>
    Object.entries(publicApiEntryModules).map(([entry, moduleName]) => ({
      artifact: `${prefix}/modules/${moduleName}.html`,
      reason: `generated API page for export entry "${entry}"`,
    })),
  ),
];

const missing = [];
for (const { artifact, reason } of requiredArtifacts) {
  try {
    await access(path.join(outputRoot, artifact));
  } catch {
    missing.push(`${artifact} (${reason})`);
  }
}

if (missing.length > 0) {
  throw new Error(`Missing documentation build artifacts:\n- ${missing.join('\n- ')}`);
}

console.log(`Verified ${requiredArtifacts.length} documentation build artifacts.`);
