import { MDXProvider } from '@mdx-js/react';
import { Content } from '@rspress/core/runtime';
import { Layout as BasicLayout, getCustomMDXComponent } from '@rspress/core/theme-original';

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

export { Layout };
export * from '@rspress/core/theme-original';
