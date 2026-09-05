import { MDXProvider } from '@mdx-js/react';
import { Content, useI18n, usePageData, withBase } from '@rspress/core/runtime';
import {
  EditLink as BasicEditLink,
  Layout as BasicLayout,
  LlmsCopyRow as BasicLlmsCopyRow,
  LlmsHint as BasicLlmsHint,
  LlmsOpenRow as BasicLlmsOpenRow,
  NotFoundLayout as BasicNotFoundLayout,
  IconEdit,
  Link,
  SvgWrapper,
  getCustomMDXComponent,
} from '@rspress/core/theme-original';
import { type JSX, useEffect } from 'react';

/**
 * The default `HomeLayout` renders only the frontmatter hero and feature cards
 * and discards the page body. This slot renders the home page's MDX body below
 * the feature grid with the standard doc components, so the landing pages can
 * carry prose, code fences, tabs, and tables authored per locale in
 * `docs/<lang>/index.mdx`.
 */
const HomeBody = () => (
  <section className="ab-home-body">
    <div className="rp-doc rspress-doc">
      <MDXProvider components={getCustomMDXComponent()}>
        <Content />
      </MDXProvider>
    </div>
  </section>
);

const Layout = () => <BasicLayout afterFeatures={<HomeBody />} />;

/**
 * Same value as `repositoryUrl` in `rspress.config.ts`. The config runs in
 * Node and this module runs in the browser, so the constant is restated here
 * rather than imported.
 */
const repositoryUrl = 'https://github.com/ScriptedAlchemy/agent-bundle';

/**
 * Generated pages have no source under `website/docs`, so the default edit
 * link (`docRepoBaseUrl` + `page._relativePath`) would point at a file that
 * only exists in a build. These patterns must track `.gitignore` lines 20–27:
 * TypeDoc output under `<lang>/api/`, and the reference pages rendered from
 * `packages/agent-bundle/src/adapters/capabilities/*.json` and
 * `docs/diagnostics.md`.
 */
const generatedApiPage = /^(en|zh)\/api\//;
const generatedCapabilityPage = /^(en|zh)\/reference\/(hosts|events|notices)\.md$/;
const generatedDiagnosticsPage = /^(en|zh)\/reference\/diagnostics\.md$/;
const capabilitiesSourceUrl = `${repositoryUrl}/tree/main/packages/agent-bundle/src/adapters/capabilities`;
const diagnosticsSourceUrl = `${repositoryUrl}/blob/main/docs/diagnostics.md`;

/** Source location for a generated reference page, or `null` when it is authored. */
const generatedSourceUrl = (relativePath: string): string | null => {
  if (generatedCapabilityPage.test(relativePath)) return capabilitiesSourceUrl;
  if (generatedDiagnosticsPage.test(relativePath)) return diagnosticsSourceUrl;
  return null;
};

/**
 * `EditLink` from the default theme builds its href unconditionally. This
 * wrapper hides it on TypeDoc pages, points the generated reference pages at
 * the source they are rendered from, and defers to the original everywhere
 * else. Both the outline and the doc footer import `EditLink` from
 * `@rspress/core/theme`, so this named export replaces it site-wide.
 */
const EditLink = ({ isOutline }: { isOutline?: boolean }) => {
  const { page, siteData } = usePageData();
  const text = useI18n()('editLinkText');
  const relativePath = typeof page._relativePath === 'string' ? page._relativePath.replace(/\\/g, '/') : '';
  if (generatedApiPage.test(relativePath)) return null;
  const sourceUrl = generatedSourceUrl(relativePath);
  if (sourceUrl === null) return <BasicEditLink isOutline={isOutline} />;
  // Same disable conditions as the original `useEditLink`.
  if (!siteData.themeConfig?.editLink?.docRepoBaseUrl || !text) return null;
  if (isOutline) {
    return (
      <Link href={sourceUrl} className="rp-outline__action-row rp-edit-link">
        <SvgWrapper icon={IconEdit} width="16" height="16" />
        <span>{text}</span>
      </Link>
    );
  }
  return (
    <Link href={sourceUrl} className="rp-edit-link">
      {text}
    </Link>
  );
};

/**
 * Both `pluginLlms` entries in `rspress.config.ts` exclude `/api/`, so the
 * generated API routes have no Markdown twin and the copy / open-in-chat
 * actions (and the hidden agent hint) would 404. Mirrors that `exclude`.
 *
 * The outline imports the two rows from `@rspress/core/theme`, so these
 * exports replace them. The hint the runtime injects on every page
 * (`runtime/App.js`) imports `LlmsHint` from `theme-original` and bypasses
 * this file; only theme and MDX consumers get the guarded version.
 */
const hasMarkdownTwin = (routePath: string): boolean => !routePath.includes('/api/');

const LlmsCopyRow = () => {
  const { page } = usePageData();
  return hasMarkdownTwin(page.routePath) ? <BasicLlmsCopyRow /> : null;
};

const LlmsOpenRow = () => {
  const { page } = usePageData();
  return hasMarkdownTwin(page.routePath) ? <BasicLlmsOpenRow /> : null;
};

const LlmsHint = (): string | JSX.Element | null => {
  const { page } = usePageData();
  return hasMarkdownTwin(page.routePath) ? <BasicLlmsHint /> : null;
};

/**
 * `route.cleanUrls` emits `quick-start.html`, so on GitHub Pages a trailing
 * slash (`…/quick-start/`) is a 404 while `…/quick-start` resolves. Retry
 * without the slash. Directory index routes (`…/guide/start/`) are served as
 * `index.html` and never reach this layout, and the stripped path never ends
 * with a slash, so the redirect cannot loop.
 */
const NotFoundLayout = () => {
  useEffect(() => {
    const { pathname, search, hash } = window.location;
    if (pathname.length > withBase('/').length && pathname.endsWith('/')) {
      window.location.replace(pathname.replace(/\/+$/, '') + search + hash);
    }
  }, []);
  return <BasicNotFoundLayout />;
};

export { EditLink, Layout, LlmsCopyRow, LlmsHint, LlmsOpenRow, NotFoundLayout };
export * from '@rspress/core/theme-original';
