import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(websiteRoot, 'doc_build');
const requiredArtifacts = [
  'index.html',
  'zh/index.html',
  'api/index.html',
  'zh/api/index.html',
  'llms.txt',
  'llms-full.txt',
  'zh/llms.txt',
  'zh/llms-full.txt',
  'sitemap.xml',
];

const missing = [];
for (const artifact of requiredArtifacts) {
  try {
    await access(path.join(outputRoot, artifact));
  } catch {
    missing.push(artifact);
  }
}

if (missing.length > 0) {
  throw new Error(`Missing documentation build artifacts:\n- ${missing.join('\n- ')}`);
}

console.log(`Verified ${requiredArtifacts.length} documentation build artifacts.`);
