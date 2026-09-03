import path from 'node:path';
import { defineConfig } from '@rspress/core';
import { pluginLlms } from '@rspress/plugin-llms';
import { pluginSitemap } from '@rspress/plugin-sitemap';
import { pluginTwoslash } from '@rspress/plugin-twoslash';
import { pluginTypeDoc } from '@rspress/plugin-typedoc';
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
} from '@shikijs/transformers';
import { cleanGeneratedApiMarkdown, mirrorApiLocale } from './plugins/mirror-api-locale.ts';

const websiteDir = import.meta.dirname;
const docsDir = path.join(websiteDir, 'docs');

const packageSource = path.join(websiteDir, '..', 'packages', 'agent-bundle', 'src');

const publicApiEntryPoints = [
  'index.ts',
  'api.ts',
  'cli-entry.ts',
  'config/index.ts',
  'eval/index.ts',
  'mcp-apps.ts',
  'meta.ts',
  'mcp-entry.ts',
  'rstest/index.ts',
  'test/index.ts',
  'test/browser.ts',
].map(entry => path.join(packageSource, entry));

const generatedApiDir = 'en/api';
const mirroredApiDirs = ['zh/api'];

const repositoryUrl = 'https://github.com/ScriptedAlchemy/agent-bundle';
const siteTitle = 'agent-bundle';
const siteDescription =
  'Compile skills, hooks, MCP servers, and scripts from one typed config into installable Claude Code, Codex, and Cursor artifacts.';
const siteDescriptionZh =
  '用一份带类型的配置描述技能、钩子、MCP 服务器与脚本，编译为可直接安装到 Claude Code、Codex 与 Cursor 的产物。';

/**
 * `llms.txt` and `llms-full.txt` are emitted as build assets rather than
 * routes, so the route-based dead-link check cannot see them.
 */
const isGeneratedLlmsTarget = (url: string): boolean => /(?:^|\/)llms(?:-full)?\.txt$/.test(url);

export default defineConfig({
  root: docsDir,
  base: '/agent-bundle/',
  siteOrigin: 'https://scriptedalchemy.github.io',
  lang: 'en',
  title: siteTitle,
  description: siteDescription,
  icon: '/logo.svg',
  logo: '/logo.svg',
  logoText: siteTitle,
  locales: [
    {
      lang: 'en',
      label: 'English',
      title: siteTitle,
      description: siteDescription,
    },
    {
      lang: 'zh',
      label: '简体中文',
      title: siteTitle,
      description: siteDescriptionZh,
    },
  ],
  search: {
    codeBlocks: true,
  },
  route: {
    cleanUrls: true,
    localeRedirect: 'never',
  },
  markdown: {
    shiki: {
      transformers: [
        transformerNotationDiff(),
        transformerNotationHighlight(),
        transformerNotationFocus(),
      ],
    },
    link: {
      checkDeadLinks: { excludes: isGeneratedLlmsTarget },
      checkAnchors: true,
    },
    image: {
      checkDeadImages: true,
    },
  },
  languageParity: {
    enabled: true,
    include: ['index.md', 'guide', 'reference', 'examples', 'contributing'],
    exclude: ['api'],
  },
  themeConfig: {
    llmsUI: { placement: 'outline' },
    editLink: {
      docRepoBaseUrl: `${repositoryUrl}/tree/main/website/docs`,
    },
    socialLinks: [{ icon: 'github', mode: 'link', content: repositoryUrl }],
  },
  plugins: [
    pluginTypeDoc({
      entryPoints: publicApiEntryPoints,
      outDir: generatedApiDir,
      setup: () => cleanGeneratedApiMarkdown(path.join(docsDir, generatedApiDir)),
    }),
    mirrorApiLocale({
      sourceDir: generatedApiDir,
      targetDirs: mirroredApiDirs,
    }),
    pluginTwoslash({
      twoslashOptions: {
        compilerOptions: {
          paths: {
            'agent-bundle': [path.join(packageSource, 'index.ts')],
            'agent-bundle/config': [path.join(packageSource, 'config/index.ts')],
            'agent-bundle/test': [path.join(packageSource, 'test/index.ts')],
            'agent-bundle/eval': [path.join(packageSource, 'eval/index.ts')],
          },
        },
      },
    }),
    // Passing options replaces the plugin's per-locale defaults instead of
    // merging with them, so both locale outputs are spelled out here.
    pluginLlms([
      {
        llmsTxt: { name: 'llms.txt' },
        llmsFullTxt: { name: 'llms-full.txt' },
        include: ({ page }) => page.lang === 'en',
        exclude: ({ page }) => page.routePath.includes('/api/'),
      },
      {
        // The plugin reads the site-level title and description, so the
        // Chinese summary has to be restated here.
        llmsTxt: {
          name: 'zh/llms.txt',
          onTitleGenerate: () => `# ${siteTitle}\n\n> ${siteDescriptionZh}`,
        },
        llmsFullTxt: { name: 'zh/llms-full.txt' },
        include: ({ page }) => page.lang === 'zh',
        exclude: ({ page }) => page.routePath.includes('/api/'),
      },
    ]),
    pluginSitemap(),
  ],
});
