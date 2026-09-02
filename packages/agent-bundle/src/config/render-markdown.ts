/**
 * The minimal honest React-element-tree → Markdown renderer behind rendered
 * skills (`src/skills/<name>/SKILL.tsx`). It walks plain element objects (the
 * shape React's automatic JSX runtime produces) without depending on React
 * itself, resolves function components (sync or async), and hand-emits
 * Markdown for a documented element subset. Anything outside the subset is a
 * `MarkdownRenderError` naming the element — never a silent approximation.
 *
 * Supported elements: `h1`–`h6`, `p`, `ul`/`ol`/`li` (nested), `strong`/`b`,
 * `em`/`i`, `code`, `pre` (fenced, `language-*` class), `blockquote`, `a`,
 * `hr`, `br`, fragments, arrays, strings, and numbers.
 */

const reactFragment = Symbol.for('react.fragment');

/** Resolution depth cap: a component chain deeper than this is a cycle. */
const maxComponentDepth = 256;

type ElementProps = Readonly<Record<string, unknown>> & { readonly children?: unknown };

interface ElementLike {
  readonly props: ElementProps;
  readonly type: unknown;
}

export class MarkdownRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkdownRenderError';
  }
}

const isElementLike = (value: unknown): value is ElementLike =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  'props' in value &&
  typeof (value as ElementLike).props === 'object' &&
  (value as ElementLike).props !== null;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';

const componentName = (type: unknown): string =>
  typeof type === 'function' && type.name !== '' ? type.name : 'anonymous component';

/** Calls function components (awaiting async ones) until an intrinsic node remains. */
const resolveNode = async (node: unknown, depth = 0): Promise<unknown> => {
  if (depth > maxComponentDepth) {
    throw new MarkdownRenderError('Rendered skill component resolution exceeded the depth limit; check for a component rendering itself.');
  }
  if (!isElementLike(node) || typeof node.type !== 'function') return node;
  let rendered: unknown;
  try {
    rendered = (node.type as (props: ElementProps) => unknown)(node.props);
  } catch (error) {
    throw new MarkdownRenderError(
      `Rendered skill component ${componentName(node.type)} threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return resolveNode(isThenable(rendered) ? await rendered : rendered, depth + 1);
};

const childrenOf = (element: ElementLike): unknown => element.props.children;

/** Flattens arrays and fragments into one resolved child list. */
const resolveChildren = async (node: unknown): Promise<unknown[]> => {
  const resolved = await resolveNode(node);
  if (resolved === null || resolved === undefined || typeof resolved === 'boolean') return [];
  if (Array.isArray(resolved)) {
    const nested = await Promise.all(resolved.map((child) => resolveChildren(child)));
    return nested.flat();
  }
  if (isElementLike(resolved) && resolved.type === reactFragment) {
    return resolveChildren(childrenOf(resolved));
  }
  return [resolved];
};

const unsupported = (tag: string): never => {
  throw new MarkdownRenderError(
    `Rendered skill content contains unsupported element <${tag}>; supported elements are h1-h6, p, ul, ol, li, strong, b, em, i, code, pre, blockquote, a, hr, br, and fragments. Write the construct as plain Markdown text or hand-author SKILL.md instead.`,
  );
};

const headingLevels: Readonly<Record<string, number>> = Object.freeze({
  h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
});

const inlineTags = new Set(['a', 'b', 'br', 'code', 'em', 'i', 'strong']);

const flattenTextChildren = async (node: unknown, tag: string): Promise<string> => {
  const children = await resolveChildren(node);
  let text = '';
  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') {
      text += String(child);
      continue;
    }
    throw new MarkdownRenderError(`<${tag}> in rendered skill content may contain only text.`);
  }
  return text;
};

const renderInline = async (node: unknown): Promise<string> => {
  const children = await resolveChildren(node);
  let text = '';
  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') {
      text += String(child);
      continue;
    }
    if (!isElementLike(child) || typeof child.type !== 'string') {
      throw new MarkdownRenderError('Rendered skill content contains a value that is neither text nor a supported element.');
    }
    const tag = child.type;
    switch (tag) {
      case 'strong':
      case 'b':
        text += `**${await renderInline(childrenOf(child))}**`;
        break;
      case 'em':
      case 'i':
        text += `*${await renderInline(childrenOf(child))}*`;
        break;
      case 'code':
        text += `\`${await flattenTextChildren(childrenOf(child), 'code')}\``;
        break;
      case 'a': {
        const href = child.props.href;
        if (typeof href !== 'string' || href === '') {
          throw new MarkdownRenderError('<a> in rendered skill content requires a nonempty string href.');
        }
        text += `[${await renderInline(childrenOf(child))}](${href})`;
        break;
      }
      case 'br':
        text += '  \n';
        break;
      default:
        unsupported(tag);
    }
  }
  return text;
};

const fenceLanguage = (codeElement: ElementLike): string => {
  const className = codeElement.props.className;
  if (typeof className !== 'string') return '';
  const match = /(?:^|\s)language-([\w+-]+)/u.exec(className);
  return match?.[1] ?? '';
};

const renderCodeBlock = async (pre: ElementLike): Promise<string> => {
  const children = await resolveChildren(childrenOf(pre));
  let language = '';
  let text = '';
  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') {
      text += String(child);
      continue;
    }
    if (isElementLike(child) && child.type === 'code') {
      language = fenceLanguage(child);
      text += await flattenTextChildren(childrenOf(child), 'code');
      continue;
    }
    throw new MarkdownRenderError('<pre> in rendered skill content may contain only text or one <code> element.');
  }
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return `\`\`\`${language}\n${body}\n\`\`\``;
};

const indentContinuation = (text: string, indent: string): string =>
  text.split('\n').map((line, index) => (index === 0 || line === '' ? line : `${indent}${line}`)).join('\n');

const renderListItem = async (item: unknown, marker: string): Promise<string> => {
  if (!isElementLike(item) || item.type !== 'li') {
    throw new MarkdownRenderError('<ul> and <ol> in rendered skill content may contain only <li> elements.');
  }
  const blocks = await renderBlocks(childrenOf(item));
  const indent = ' '.repeat(marker.length);
  return `${marker}${indentContinuation(blocks.join('\n\n'), indent)}`;
};

const renderList = async (list: ElementLike): Promise<string> => {
  const items = await resolveChildren(childrenOf(list));
  const rendered = await Promise.all(items.map((item, index) =>
    renderListItem(item, list.type === 'ol' ? `${index + 1}. ` : '- ')));
  if (rendered.length === 0) {
    throw new MarkdownRenderError('<ul> and <ol> in rendered skill content require at least one <li>.');
  }
  return rendered.join('\n');
};

const renderBlockElement = async (element: ElementLike): Promise<string> => {
  const tag = element.type as string;
  const heading = headingLevels[tag];
  if (heading !== undefined) {
    return `${'#'.repeat(heading)} ${await renderInline(childrenOf(element))}`;
  }
  switch (tag) {
    case 'p':
      return renderInline(childrenOf(element));
    case 'ul':
    case 'ol':
      return renderList(element);
    case 'pre':
      return renderCodeBlock(element);
    case 'blockquote': {
      const blocks = await renderBlocks(childrenOf(element));
      return blocks.join('\n\n').split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
    }
    case 'hr':
      return '---';
    default:
      return unsupported(tag);
  }
};

/** Renders children as a sequence of Markdown blocks; loose inline content coalesces into paragraphs. */
const renderBlocks = async (node: unknown): Promise<string[]> => {
  const children = await resolveChildren(node);
  const blocks: string[] = [];
  let paragraph = '';
  const flush = (): void => {
    const trimmed = paragraph.trim();
    if (trimmed !== '') blocks.push(trimmed);
    paragraph = '';
  };
  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') {
      paragraph += String(child);
      continue;
    }
    if (!isElementLike(child) || typeof child.type !== 'string') {
      throw new MarkdownRenderError('Rendered skill content contains a value that is neither text nor a supported element.');
    }
    if (inlineTags.has(child.type)) {
      paragraph += await renderInline([child]);
      continue;
    }
    flush();
    blocks.push(await renderBlockElement(child));
  }
  flush();
  return blocks;
};

/**
 * Renders one resolved element tree to a Markdown document body ending in a
 * single trailing newline. Throws `MarkdownRenderError` outside the subset.
 */
export const renderElementToMarkdown = async (node: unknown): Promise<string> => {
  const blocks = await renderBlocks(node);
  if (blocks.length === 0) {
    throw new MarkdownRenderError('Rendered skill content produced no Markdown.');
  }
  return `${blocks.join('\n\n')}\n`;
};
