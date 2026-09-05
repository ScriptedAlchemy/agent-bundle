import path from 'node:path';
import { defineConfig } from '@rspress/core';
import { pluginLlms } from '@rspress/plugin-llms';
import { pluginTwoslash } from '@rspress/plugin-twoslash';
import { pluginTypeDoc } from '@rspress/plugin-typedoc';
import { transformerNotationHighlight } from '@shikijs/transformers';
import ts from 'typescript';
import { generatedReference } from './plugins/generated-reference.ts';
import { cleanGeneratedApiMarkdown, mirrorApiLocale } from './plugins/mirror-api-locale.ts';
import { rehypeTableCellBreaks } from './plugins/rehype-table-cell-breaks.ts';
import { sitemapLastmod } from './plugins/sitemap-lastmod.ts';

const websiteDir = import.meta.dirname;
const docsDir = path.join(websiteDir, 'docs');
const repoRoot = path.join(websiteDir, '..');

const packageSource = path.join(repoRoot, 'packages', 'agent-bundle', 'src');
const typedocTsconfigPath = path.join(websiteDir, 'tsconfig.typedoc.json');

/**
 * The `paths` that resolve the workspace packages `packages/agent-bundle/src`
 * imports (`@agent-bundle/runtime`, `rsc-markdown-stream`) to their sources.
 * Their published declarations only exist after `pnpm build`, which the docs
 * build never runs, so a compiler that resolves them through `package.json`
 * types every one of those imports as `any`. TypeDoc reads the tsconfig
 * itself; twoslash takes its compiler options programmatically, so the same
 * map is read here rather than copied.
 *
 * The file is JSONC and the values are relative to the tsconfig, which is how
 * TypeScript resolves them; twoslash gets no `baseUrl` or config directory,
 * so each target is made absolute before it is handed over.
 */
function readSourceMappedPaths(tsconfigPath: string): Record<string, string[]> {
  const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (error) {
    throw new Error(
      `${tsconfigPath}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`,
    );
  }
  const paths: unknown = config?.compilerOptions?.paths;
  if (!paths || typeof paths !== 'object' || Object.keys(paths).length === 0) {
    throw new Error(`${tsconfigPath}: expected a non-empty compilerOptions.paths`);
  }
  const tsconfigDir = path.dirname(tsconfigPath);
  return Object.fromEntries(
    Object.entries(paths).map(([specifier, targets]) => {
      if (!Array.isArray(targets) || !targets.every(target => typeof target === 'string')) {
        throw new Error(`${tsconfigPath}: compilerOptions.paths["${specifier}"] must be string[]`);
      }
      return [specifier, targets.map(target => path.resolve(tsconfigDir, target))];
    }),
  );
}

/**
 * Twoslash samples import the package by its published name, which nothing in
 * `packages/agent-bundle/src` does, so those four entries live only here.
 */
const twoslashPaths: Record<string, string[]> = {
  'agent-bundle': [path.join(packageSource, 'index.ts')],
  'agent-bundle/config': [path.join(packageSource, 'config/index.ts')],
  'agent-bundle/test': [path.join(packageSource, 'test/index.ts')],
  'agent-bundle/eval': [path.join(packageSource, 'eval/index.ts')],
  ...readSourceMappedPaths(typedocTsconfigPath),
};

const publicApiEntryPoints = [
  'index.ts',
  'api.ts',
  'app/index.ts',
  'cli-entry.ts',
  'config/index.ts',
  'eval/index.ts',
  'launch-env.ts',
  'mcp-apps.ts',
  'meta.ts',
  'mcp-entry.ts',
  'routes/public.ts',
  'rstest/index.ts',
  'serve-app-command.ts',
  'test/index.ts',
  'test/browser.ts',
].map(entry => path.join(packageSource, entry));

const generatedApiDir = 'en/api';
const mirroredApiTargets = [
  {
    dir: 'zh/api',
    notice: 'API 参考仅提供英文版本；正文与英文站点相同。',
  },
];

const repositoryUrl = 'https://github.com/ScriptedAlchemy/agent-bundle';
const siteTitle = 'agent-bundle';
const siteDescription =
  'Compile skills, hooks, MCP servers, and scripts from one typed config into installable Claude Code, Codex, and Cursor artifacts.';
const siteDescriptionZh =
  '用一份带类型的配置描述 Skill、钩子、MCP 服务器与脚本，编译为可直接安装到 Claude Code、Codex 与 Cursor 的产物。';
/** `--rp-c-brand` in `styles/index.css` (light theme; 4.83:1 on white). */
const brandColor = '#0b8072';

/**
 * `llms.txt` and `llms-full.txt` are emitted as build assets rather than
 * routes, so the route-based dead-link check cannot see them.
 */
const isGeneratedLlmsTarget = (url: string): boolean => /(?:^|\/)llms(?:-full)?\.txt$/.test(url);

export default defineConfig({
  root: docsDir,
  base: '/agent-bundle/',
  siteOrigin: 'https://scriptedalchemy.github.io',
  globalStyles: path.join(websiteDir, 'styles/index.css'),
  lang: 'en',
  title: siteTitle,
  description: siteDescription,
  icon: '/logo.svg',
  logo: '/logo.svg',
  logoText: siteTitle,
  // Only rendered at SSG (`renderHtmlTemplate`); `rspress dev` leaves the head
  // marker untouched, so the tag is absent from the dev server. Per-route
  // entries (`route => ['link', { rel: 'canonical', ... }]`) are typed but
  // cannot be combined with `ssg.experimentalWorker`: `renderPages` ships
  // `config.head` to the worker threads through `workerData`, and a function
  // fails structured cloning (`DataCloneError`) before the first page renders.
  head: [['meta', { name: 'theme-color', content: brandColor }]],
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
  route: {
    cleanUrls: true,
    localeRedirect: 'never',
  },
  // Renders the ~900 routes across a tinypool of worker threads instead of one
  // process; output is identical.
  ssg: {
    experimentalWorker: true,
  },
  builderConfig: {
    performance: {
      // The per-asset table is one line per route (plus chunks) and buries the
      // dead-link and parity results; the total is still printed.
      printFileSize: { detail: false },
    },
  },
  markdown: {
    shiki: {
      // Twoslash hovers render JSDoc code fences from dependency types, so the
      // grammar set cannot be inferred from page sources alone (same fix as
      // the upstream rspress.rs site).
      langs: ['markdown', 'mdx', 'ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'yaml', 'css', 'html'],
      // Only `[!code highlight]` is used in the docs; add the diff or focus
      // transformer back alongside the first page that needs its notation.
      transformers: [transformerNotationHighlight()],
    },
    link: {
      checkDeadLinks: { excludes: isGeneratedLlmsTarget },
      checkAnchors: true,
    },
    // Long keys, paths, and URLs in table cells wrap instead of widening the table.
    rehypePlugins: [rehypeTableCellBreaks],
    image: {
      checkDeadImages: true,
    },
  },
  // `include` entries are directories, so listing the homepage there would
  // silently drop it from the check. The default walks each locale root.
  languageParity: {
    enabled: true,
    exclude: ['api'],
  },
  themeConfig: {
    llmsUI: { placement: 'outline' },
    editLink: {
      docRepoBaseUrl: `${repositoryUrl}/tree/main/website/docs`,
    },
    socialLinks: [{ icon: 'github', mode: 'link', content: repositoryUrl }],
    // Rendered by `HomeFooter` on the home layout only, and read from the
    // site-level theme config, so one message serves both locales.
    footer: {
      message: `Released under the <a href="${repositoryUrl}/blob/main/LICENSE">Apache-2.0 License</a>.`,
    },
  },
  plugins: [
    // TypeDoc and twoslash compile packages/agent-bundle/src with the
    // `typescript` pinned in website/package.json. That pin is TypeScript 6
    // because typedoc 0.28 peers on `<= 6.0.x` while the repo root is on
    // TypeScript 7, so TS7-only syntax in the package fails here first, with
    // an error that names the docsite rather than the cause.
    pluginTypeDoc({
      entryPoints: publicApiEntryPoints,
      outDir: generatedApiDir,
      setup: async app => {
        await cleanGeneratedApiMarkdown(path.join(docsDir, generatedApiDir));
        // Rspress derives sidebar and prev/next labels from the raw `# ` line,
        // so typedoc-plugin-markdown's escaped underscores (`FOO\_BAR`) would
        // surface verbatim. Intraword underscores are not emphasis in
        // CommonMark, so the member title is safe to emit unescaped.
        // `includeVersion` is unset, so `{version}` would only leave a
        // trailing space in the title.
        app.options.setValue('pageTitleTemplates', {
          index: '{projectName}',
          module: '{kind}: {name}',
          member: ({ kind, name }: { kind: string; name: string }) =>
            `${kind}: ${name.replace(/\\_/g, '_')}`,
        });
        // One page per entry point instead of one per exported symbol (#590):
        // the plugin's default `kind` router emitted 916 pages per locale whose
        // SSR'd sidebar was 93 % of the HTML. Members become headings on their
        // module page; authored links use `/api/<module>#<member>`.
        app.options.setValue('router', 'module');
        return app;
      },
    }),
    mirrorApiLocale({
      sourceDir: generatedApiDir,
      targets: mirroredApiTargets,
    }),
    generatedReference({
      repoRoot,
      locales: [
        { lang: 'en', dir: 'en' },
        { lang: 'zh', dir: 'zh' },
      ],
    }),
    pluginTwoslash({
      twoslashOptions: {
        compilerOptions: {
          paths: twoslashPaths,
        },
      },
    }),
    // Passing options replaces the plugin's per-locale defaults instead of
    // merging with them, so both locale outputs are spelled out here.
    pluginLlms([
      {
        llmsTxt: { name: 'llms.txt' },
        llmsFullTxt: { name: 'llms-full.txt' },
        // Strip theme imports and unwrap JSX so the homepage ships as Markdown.
        mdFiles: { mdxToMd: true },
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
        mdFiles: { mdxToMd: true },
        include: ({ page }) => page.lang === 'zh',
        exclude: ({ page }) => page.routePath.includes('/api/'),
      },
    ]),
    sitemapLastmod({ repoRoot }),
  ],
});
