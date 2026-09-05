import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RspressPlugin, UserConfig } from '@rspress/core';
import { type PluginSitemapOptions, pluginSitemap } from '@rspress/plugin-sitemap';

const API_SOURCE = 'packages/agent-bundle/src';
const CAPABILITIES_SOURCE = 'packages/agent-bundle/src/adapters/capabilities';
const DIAGNOSTICS_SOURCE = 'docs/diagnostics.md';
const LASTMOD_PATTERN = /<lastmod>[^<]*<\/lastmod>/;
const LOC_PATTERN = /<loc>([^<]*)<\/loc>/;
const URL_PATTERN = /<url>[\s\S]*?<\/url>/g;

export interface SitemapLastmodRewriteOptions {
  readonly base: string;
  readonly siteOrigin: string;
  readonly lastmodForRoute: (routePath: string) => string | undefined;
}

export interface SitemapLastmodOptions {
  /** Absolute repository root used as the Git working directory. */
  readonly repoRoot: string;
  /** Passed through to `@rspress/plugin-sitemap`. */
  readonly sitemap?: PluginSitemapOptions;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function routeFromLoc(loc: string, siteOrigin: string, base: string): string | undefined {
  let location: URL;
  let siteBase: URL;
  try {
    location = new URL(decodeXmlText(loc));
    siteBase = new URL(base, siteOrigin);
  } catch {
    return undefined;
  }

  if (location.origin !== siteBase.origin) {
    return undefined;
  }

  const basePath = siteBase.pathname.endsWith('/') ? siteBase.pathname : `${siteBase.pathname}/`;
  const baseWithoutSlash = basePath.slice(0, -1);
  let routePath: string;
  if (location.pathname === baseWithoutSlash || location.pathname === basePath) {
    routePath = '/';
  } else if (location.pathname.startsWith(basePath)) {
    routePath = `/${location.pathname.slice(basePath.length)}`;
  } else {
    return undefined;
  }

  try {
    return decodeURIComponent(routePath);
  } catch {
    return undefined;
  }
}

/**
 * Replace only sitemap `lastmod` nodes, leaving every other byte untouched.
 *
 * The callback keeps this transformation independent of Git and filesystem
 * access so it can be exercised directly over emitted sitemap XML.
 */
export function rewriteSitemapLastmod(
  xml: string,
  options: SitemapLastmodRewriteOptions,
): string {
  return xml.replace(URL_PATTERN, urlNode => {
    const loc = LOC_PATTERN.exec(urlNode)?.[1];
    const routePath =
      loc === undefined ? undefined : routeFromLoc(loc, options.siteOrigin, options.base);
    const lastmod =
      routePath === undefined ? undefined : options.lastmodForRoute(routePath);

    if (lastmod === undefined) {
      return urlNode.replace(LASTMOD_PATTERN, '');
    }

    const lastmodNode = `<lastmod>${lastmod}</lastmod>`;
    return LASTMOD_PATTERN.test(urlNode)
      ? urlNode.replace(LASTMOD_PATTERN, lastmodNode)
      : urlNode.replace('</loc>', `</loc>${lastmodNode}`);
  });
}

function sourcePathForRoute(
  routePath: string,
  repoRoot: string,
): string | undefined {
  const normalized = routePath.replace(/^\/+|\/+$/g, '');
  const isChinese = normalized === 'zh' || normalized.startsWith('zh/');
  const locale = isChinese ? 'zh' : 'en';
  const relativeRoute = isChinese
    ? normalized.slice('zh'.length).replace(/^\/+/, '')
    : normalized;

  if (relativeRoute === 'api' || relativeRoute.startsWith('api/')) {
    return API_SOURCE;
  }
  if (
    relativeRoute === 'reference/hosts' ||
    relativeRoute === 'reference/events' ||
    relativeRoute === 'reference/notices'
  ) {
    return CAPABILITIES_SOURCE;
  }
  if (relativeRoute === 'reference/diagnostics') {
    return DIAGNOSTICS_SOURCE;
  }

  const routeSegments = relativeRoute === '' ? [] : relativeRoute.split('/');
  if (routeSegments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }

  const sourceStem = path.posix.join('website', 'docs', locale, ...routeSegments);
  const candidates = [
    `${sourceStem}.mdx`,
    `${sourceStem}.md`,
    path.posix.join(sourceStem, 'index.mdx'),
    path.posix.join(sourceStem, 'index.md'),
  ];
  return candidates.find(candidate => existsSync(path.join(repoRoot, ...candidate.split('/'))));
}

function isShallowRepository(repoRoot: string): boolean | undefined {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim() === 'true'
    );
  } catch {
    return undefined;
  }
}

export function createGitLastmodResolver(
  repoRoot: string,
): (routePath: string) => string | undefined {
  const shallow = isShallowRepository(repoRoot);
  const cache = new Map<string, string | undefined>();

  if (shallow !== false) {
    return () => undefined;
  }

  return routePath => {
    const sourcePath = sourcePathForRoute(routePath, repoRoot);
    if (sourcePath === undefined) {
      return undefined;
    }
    if (cache.has(sourcePath)) {
      return cache.get(sourcePath);
    }

    let lastmod: string | undefined;
    try {
      const value = execFileSync(
        'git',
        ['log', '-1', '--format=%cI', '--', sourcePath],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim();
      if (value !== '' && !Number.isNaN(Date.parse(value))) {
        lastmod = value;
      }
    } catch {
      lastmod = undefined;
    }
    cache.set(sourcePath, lastmod);
    return lastmod;
  };
}

function sitemapPath(config: UserConfig): string {
  const distPath =
    typeof config.builderConfig?.output?.distPath === 'string'
      ? config.builderConfig.output.distPath
      : config.builderConfig?.output?.distPath?.root;
  const outDir = config.outDir || distPath || 'doc_build';
  return path.resolve(outDir, 'sitemap.xml');
}

/**
 * `@rspress/plugin-sitemap` with `lastmod` taken from git history.
 *
 * Rspress runs every plugin's `afterBuild` in parallel
 * (`PluginDriver._runParallelAsyncHook`), so a second plugin cannot rely on
 * running after the sitemap has been written. This wraps the sitemap plugin
 * instead: its own hooks are kept as they are and the rewrite is chained onto
 * its `afterBuild`, so `sitemap.xml` exists before it is read.
 */
export function sitemapLastmod(options: SitemapLastmodOptions): RspressPlugin {
  const sitemap = pluginSitemap(options.sitemap);
  return {
    ...sitemap,
    name: 'agent-bundle/sitemap-lastmod',
    async afterBuild(config, isProd) {
      await sitemap.afterBuild?.(config, isProd);
      if (!isProd || !config.siteOrigin) {
        return;
      }

      const outputPath = sitemapPath(config);
      const xml = await readFile(outputPath, 'utf8');
      const rewritten = rewriteSitemapLastmod(xml, {
        base: config.base ?? '/',
        siteOrigin: config.siteOrigin,
        lastmodForRoute: createGitLastmodResolver(options.repoRoot),
      });
      if (rewritten !== xml) {
        await writeFile(outputPath, rewritten, 'utf8');
      }
    },
  };
}
