import { MDXProvider } from '@mdx-js/react';
import type { SocialLink } from '@rspress/core';
import { Content, ThemeContext, useI18n, useLang, usePageData, withBase } from '@rspress/core/runtime';
import {
  EditLink as BasicEditLink,
  HomeLayout as BasicHomeLayout,
  Layout as BasicLayout,
  LlmsCopyRow as BasicLlmsCopyRow,
  LlmsHint as BasicLlmsHint,
  LlmsOpenRow as BasicLlmsOpenRow,
  NotFoundLayout as BasicNotFoundLayout,
  SocialLinks as BasicSocialLinks,
  HomeBackground,
  HomeFeature,
  HomeFooter,
  HomeHero,
  type HomeLayoutProps,
  IconEdit,
  IconMoon,
  IconSun,
  Link,
  SvgWrapper,
  getCustomMDXComponent,
} from '@rspress/core/theme-original';
import { type JSX, useContext, useEffect, useRef, useState } from 'react';

declare global {
  interface ImportMeta {
    /**
     * Defined by Rspress for every bundle it compiles (`node/initRsbuild.js`,
     * `source.define`): `true` only in the Markdown render that feeds
     * `@rspress/plugin-llms`. The default theme branches on the same flag; the
     * package ships no declaration for it.
     */
    readonly env: { readonly SSG_MD: boolean };
  }
}

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

/** Focus target of the skip link; placed as the first child of `<main>`. */
const contentId = 'ab-content';

/**
 * Zero-size, programmatically focusable marker. `DocLayout` opens `<main>`
 * with the `beforeDocContent` slot and `HomeLayout` below does the same, so
 * following the skip link moves focus (and the sequential-focus start) to the
 * top of the main content on every page that has one.
 */
const SkipTarget = () => <div id={contentId} tabIndex={-1} className="ab-skip-target" />;

/** Page types whose layout has no `<main>` and therefore no skip target. */
const pagesWithoutContent = new Set(['404', 'custom', 'blank']);

/**
 * First focusable element on the page, rendered through the `top` slot ahead
 * of the nav. A plain hash anchor, like the theme's own heading anchors and
 * `Link` for hash-only hrefs: the browser moves focus to the marker and
 * `useScrollAfterNav` scrolls it under the sticky nav.
 */
const SkipLink = () => {
  const lang = useLang();
  const { page } = usePageData();
  if (pagesWithoutContent.has(page.pageType)) return null;
  return (
    <a className="ab-skip-link" href={`#${contentId}`}>
      {lang === 'zh' ? '跳至主要内容' : 'Skip to main content'}
    </a>
  );
};

/**
 * The default `HomeLayout` has no `<main>`: hero, feature grid and footer are
 * siblings under `#root`, so the home page exposes no main landmark
 * (`DocLayout` gives doc pages one). `Layout` accepts a `HomeLayout` prop, so
 * this restates the default's markup with the hero and features inside
 * `<main>`; the background and the footer stay outside so the footer keeps its
 * `contentinfo` role. The Markdown render keeps the original, so the
 * `index.md` twin produced for `llms.txt` is unchanged.
 *
 * The hero title stays a `<div>` (`HomeHero` renders `.rp-home-hero__title`
 * as a div, upstream too); giving the home page an `<h1>` would mean forking
 * that component, so it is left as is.
 */
const HomeLayout = ({
  beforeHero,
  afterHero,
  beforeHeroActions,
  afterHeroActions,
  beforeFeatures,
  afterFeatures,
}: HomeLayoutProps) => {
  if (import.meta.env.SSG_MD) {
    return (
      <BasicHomeLayout
        beforeHero={beforeHero}
        afterHero={afterHero}
        beforeHeroActions={beforeHeroActions}
        afterHeroActions={afterHeroActions}
        beforeFeatures={beforeFeatures}
        afterFeatures={afterFeatures}
      />
    );
  }
  return (
    <>
      <HomeBackground />
      <main>
        <SkipTarget />
        {beforeHero}
        <HomeHero beforeHeroActions={beforeHeroActions} afterHeroActions={afterHeroActions} />
        {afterHero}
        {beforeFeatures}
        <HomeFeature />
        {afterFeatures}
      </main>
      <HomeFooter />
    </>
  );
};

const Layout = () => (
  <BasicLayout
    top={<SkipLink />}
    beforeDocContent={<SkipTarget />}
    afterFeatures={<HomeBody />}
    HomeLayout={HomeLayout}
  />
);

/**
 * The default `SwitchAppearance` is a click-only `<div>`: no role, no name,
 * not in the tab order. `Nav`, `NavScreen` and `NavHamburger` import it from
 * `@rspress/core/theme`, so this named export replaces it site-wide. It stays
 * a `<div>` — given `role="button"`, a translated name, a tab stop and
 * Enter/Space handling — instead of becoming a `<button>`, because
 * `NavHamburger` (rendered on every page, shown at widths ≤ 1280 px) mounts
 * the switch inside its own `<button>`, and a `<button>` inside a `<button>`
 * is invalid HTML that React reports on every render. The original class
 * names are kept so the theme's CSS still applies. `aria-pressed` is only
 * rendered after mount: the SSG HTML is rendered with the default theme while
 * the client's first render already knows the stored preference, so a state
 * attribute in the initial markup would mismatch on hydration. The original's
 * view-transition animation (`themeConfig.enableAppearanceAnimation`, off
 * for this site) is not reproduced.
 */
const SwitchAppearance = ({ onClick }: { onClick?: () => void }) => {
  const { theme, setTheme } = useContext(ThemeContext);
  const lang = useLang();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const isDark = theme === 'dark';
  const toggle = () => {
    setTheme?.(isDark ? 'light' : 'dark');
    onClick?.();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className="rp-switch-appearance"
      aria-label={lang === 'zh' ? '深色模式' : 'Dark mode'}
      aria-pressed={mounted ? isDark : undefined}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
      }}
    >
      <SvgWrapper
        className="rp-switch-appearance__icon rp-switch-appearance__icon--sun"
        icon={IconSun}
        fill="currentColor"
      />
      <SvgWrapper
        className="rp-switch-appearance__icon rp-switch-appearance__icon--moon"
        icon={IconMoon}
        fill="currentColor"
      />
    </div>
  );
};

/** Accessible name for a social link, from its host: `github.com`. */
const socialLinkName = (href: string): string => {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
};

/**
 * `SocialLink` (mode `link`) renders `<a target="_blank">` whose only child is
 * the icon SVG, so the link has no accessible name. `Nav`, `NavHamburger` and
 * `NavScreen` import `SocialLinks` from `@rspress/core/theme`, so this named
 * export replaces it. The anchor is created inside the default component and
 * its icon comes from a build-time virtual module, so rather than restating
 * the component the name is set on the rendered anchors after each render;
 * assistive technology reads the live DOM. `github-stars` links already carry
 * their own label and are left alone.
 */
const SocialLinks = (props: { socialLinks?: SocialLink[] }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const anchors =
      ref.current?.querySelectorAll<HTMLAnchorElement>('a.rp-social-links__item:not([aria-label])') ?? [];
    for (const anchor of anchors) anchor.setAttribute('aria-label', socialLinkName(anchor.href));
  });
  return (
    <div ref={ref} className="ab-social-links">
      <BasicSocialLinks {...props} />
    </div>
  );
};

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

export {
  EditLink,
  Layout,
  LlmsCopyRow,
  LlmsHint,
  LlmsOpenRow,
  NotFoundLayout,
  SocialLinks,
  SwitchAppearance,
};
export * from '@rspress/core/theme-original';
