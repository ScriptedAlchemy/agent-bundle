import type { Element, ElementContent, Root } from 'hast';

/**
 * Insert `<wbr>` into long `code` and link text inside table cells.
 *
 * Rspress tables use `table-layout: auto`, so an unbreakable token (a dotted
 * capability key, a path, a URL) widens its column and the table scrolls
 * sideways. `overflow-wrap: anywhere` shrinks the columns instead, but breaks
 * short identifiers mid-word once five columns share the content width. A
 * `<wbr>` after separators and at camelCase boundaries is taken only when the
 * token does not fit, and the Markdown source, search index, `llms-full.txt`,
 * and clipboard keep the plain token.
 */

/** Shorter tokens fit Rspress's 8rem cell minimum. */
const MIN_LENGTH = 16;

/** After a separator that ends a segment (`https://`, `a.b`, `x/y`), or between camelCase words. */
const BREAK_AFTER = /(?<=[\w/][./@,_-])(?=\S)|(?<=[a-z0-9])(?=[A-Z])/g;

const wbr = (): Element => ({ type: 'element', tagName: 'wbr', properties: {}, children: [] });

const isElement = (node: { readonly type: string }): node is Element => node.type === 'element';

function addBreaks(node: Element): void {
  node.children = node.children.flatMap((child): ElementContent[] => {
    if (child.type !== 'text' || child.value.length < MIN_LENGTH) {
      return [child];
    }
    return child.value
      .split(BREAK_AFTER)
      .flatMap((value, index) => (index === 0 ? [{ type: 'text', value }] : [wbr(), { type: 'text', value }]));
  });
}

function walk(node: Element | Root, inCell: boolean): void {
  for (const child of node.children) {
    if (!isElement(child)) {
      continue;
    }
    const cell = inCell || child.tagName === 'td' || child.tagName === 'th';
    if (cell && (child.tagName === 'code' || child.tagName === 'a')) {
      addBreaks(child);
    }
    walk(child, cell);
  }
}

export function rehypeTableCellBreaks() {
  return (tree: Root): void => walk(tree, false);
}
