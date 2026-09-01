import React, { lazy, Suspense, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { SkillDocumentBase } from '../../agent-bundle/src/contracts/skills.ts';

import { resourceUrlFor } from './skills-model.ts';
import { supportedShikiLanguage } from './shiki-languages.ts';

const LazyShikiCode = lazy(async () => {
  const module = await import('./shiki-code.tsx');
  return { default: module.ShikiCode };
});

export interface SkillMarkdownProps {
  readonly base: SkillDocumentBase;
  readonly body: string;
  readonly resources: readonly string[];
}

export interface MarkdownProjectorProps {
  readonly body: string;
  readonly resolveImage: (reference: string) => string | undefined;
  readonly resolveLink: (reference: string) => string | undefined;
}

type MarkdownElementProps<Tag extends keyof React.JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<Tag> & { readonly node?: unknown };

interface MarkdownNode {
  children?: MarkdownNode[];
  type?: string;
}

const inertHtml = () => (tree: MarkdownNode): void => {
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'html') node.type = 'text';
    node.children?.forEach(visit);
  };
  visit(tree);
};

const valueOf = (children: ReactNode): string => Array.isArray(children)
  ? children.map(valueOf).join('')
  : typeof children === 'string' || typeof children === 'number'
    ? String(children)
    : '';

const languageFor = (className: string | undefined): string | undefined => {
  const match = /(?:^|\s)language-([^\s]+)/u.exec(className ?? '');
  return match?.[1];
};

const PlainCode = ({ className, value }: { readonly className?: string; readonly value: string }) => (
  <pre className="skill-code-block"><code className={className}>{value}</code></pre>
);

const SkillCode = ({ children, className }: ComponentPropsWithoutRef<'code'>) => {
  const value = valueOf(children);
  const language = languageFor(className);
  if (language === undefined) return <code className={className}>{children}</code>;
  if (language.toLowerCase() === 'mermaid') {
    return <pre className="skill-mermaid-code"><code className={className}>{value}</code></pre>;
  }
  const supported = supportedShikiLanguage(language);
  if (supported === undefined) return <PlainCode className={className} value={value} />;
  return <Suspense fallback={<PlainCode className={className} value={value} />}>
    <LazyShikiCode language={supported} value={value} />
  </Suspense>;
};

const MarkdownLink = ({
  children,
  href,
  node: _node,
  resolve,
  ...properties
}: MarkdownElementProps<'a'> & Readonly<{
  readonly resolve: MarkdownProjectorProps['resolveLink'];
}>) => {
  const resolved = typeof href === 'string' ? resolve(href) : undefined;
  if (resolved === undefined) return <span className="skill-broken-link">{children}</span>;
  const external = /^https?:|^mailto:/u.test(resolved);
  return <a {...properties} href={resolved} {...(external ? { rel: 'noreferrer', target: '_blank' } : {})}>{children}</a>;
};

const MarkdownImage = ({
  alt,
  node: _node,
  resolve,
  src,
  ...properties
}: MarkdownElementProps<'img'> & Readonly<{
  readonly resolve: MarkdownProjectorProps['resolveImage'];
}>) => {
  const source = typeof src === 'string' ? src : undefined;
  const resolved = source === undefined ? undefined : resolve(source);
  if (resolved === undefined) {
    return <span className="skill-broken-image" role="img">
      {alt ?? 'Image unavailable'}
      {source === undefined ? undefined : <> · <code>{source}</code></>}
    </span>;
  }
  return <img {...properties} alt={alt ?? ''} src={resolved} />;
};

/** The audited inert-HTML/GFM projector shared by Skills and Agent Documents. */
export const MarkdownProjector = ({
  body,
  resolveImage,
  resolveLink,
}: MarkdownProjectorProps) => (
  <div className="skill-markdown">
    <ReactMarkdown
      components={{
        a: (properties) => <MarkdownLink {...properties} resolve={resolveLink} />,
        code: SkillCode,
        h1: ({ node: _node, ...properties }) => <h1 className="skill-heading skill-heading--one" {...properties} />,
        h2: ({ node: _node, ...properties }) => <h2 className="skill-heading skill-heading--two" {...properties} />,
        h3: ({ node: _node, ...properties }) => <h3 className="skill-heading skill-heading--three" {...properties} />,
        img: (properties) => <MarkdownImage {...properties} resolve={resolveImage} />,
        pre: ({ children }) => <>{children}</>,
        table: ({ node: _node, ...properties }) => <div className="skill-table-wrap"><table {...properties} /></div>,
      }}
      remarkPlugins={[remarkGfm, inertHtml]}
      urlTransform={(url) => url}
    >
      {body}
    </ReactMarkdown>
  </div>
);

/** Renders only the server-provided Markdown body and explicit typed resource base. */
export const SkillMarkdown = ({ base, body, resources }: SkillMarkdownProps) => (
  <MarkdownProjector
    body={body}
    resolveImage={(reference) => resourceUrlFor(base, reference, resources)}
    resolveLink={(reference) => resourceUrlFor(base, reference, resources)}
  />
);
