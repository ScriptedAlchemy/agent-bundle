// Serializes resolved host nodes ({ tag, props, children } and strings)
// into GitHub Flavored Markdown blocks.

import { BLOCK_BOUNDARY } from './resolve.js';

const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'pre', 'blockquote', 'ul', 'ol', 'hr', 'table', 'dt', 'dd',
  'div', 'section', 'article', 'main', 'header', 'footer',
  'aside', 'nav', 'figure', 'figcaption', 'details', 'summary', 'dl',
]);

// Tags with inline markdown semantics. Anything else that is not a block
// tag is transparent: its children flow into the surrounding content.
const INLINE_TAGS = new Set([
  'strong', 'b', 'em', 'i', 'del', 's', 'strike',
  'code', 'kbd', 'samp', 'a', 'img', 'br', 'input',
]);

// Pass-through block tags: they only imply a block boundary, so their
// children can be streamed one block at a time instead of buffered.
const CONTAINER_TAGS = new Set([
  'div', 'section', 'article', 'main', 'header', 'footer',
  'aside', 'nav', 'figure', 'figcaption', 'details', 'summary', 'dl',
]);

// Classifies a host tag for the resolver: 'container' children stream with
// block boundaries, 'transparent' children flow into surrounding content,
// 'buffer' means the serializer needs the fully resolved subtree.
export function streamMode(tag, opts) {
  if (opts.components && opts.components[tag]) return 'buffer';
  if (CONTAINER_TAGS.has(tag)) return 'container';
  if (!BLOCK_TAGS.has(tag) && !INLINE_TAGS.has(tag)) return 'transparent';
  return 'buffer';
}

// `~` is escaped so literal ~~text~~ never becomes strikethrough and lines
// starting with ~~~ never open a tilde fence. `&` is escaped only where it
// would parse as an entity reference (`&amp;`, `&#169;`, `&#x1F;`), which a
// parser would otherwise decode. `_` between two word characters can never
// open or close emphasis (it is both left- and right-flanking without
// punctuation), so identifiers like `snake_case` stay readable.
const ENTITY_LIKE = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const escapeText = (text) =>
  text.replace(/[\\`*_[\]<~&]/g, (c, offset) => {
    if (c === '&') return ENTITY_LIKE.test(text.slice(offset)) ? '\\&' : '&';
    if (c === '_' && WORD_CHAR.test(text[offset - 1] ?? '') && WORD_CHAR.test(text[offset + 1] ?? '')) {
      return '_';
    }
    return '\\' + c;
  });
const collapseWs = (text) => text.replace(/\s+/g, ' ');
const singleLine = (text) =>
  text.replace(/\\\n/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();

function rawText(nodes) {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') out += node;
    else if (node.tag === 'br') out += '\n';
    else out += rawText(node.children);
  }
  return out;
}

const isBlockNode = (node, opts) =>
  typeof node !== 'string' &&
  (BLOCK_TAGS.has(node.tag) || Boolean(opts.components && opts.components[node.tag]));

// Trailing emphasis delimiter run of `text`, if it isn't escaped.
function trailingRun(text) {
  const match = /(\*+|~+)$/.exec(text);
  if (!match) return '';
  if (text[text.length - match[0].length - 1] === '\\') return '';
  return match[0];
}

const NO_ACTIVE = new Set();

// `active` holds the emphasis delimiters currently open around these nodes.
export function renderInline(nodes, opts, active = NO_ACTIVE) {
  let out = '';
  for (const node of nodes) {
    const fragment =
      typeof node === 'string' ? escapeText(collapseWs(node)) : inlineElement(node, opts, active);
    // Adjacent identical delimiter runs (<em>a</em><em>b</em> -> *a**b*)
    // parse incorrectly, and merging the wrappers renders identically.
    const open = /^(\*+|~+)/.exec(fragment)?.[0] ?? '';
    if (open !== '' && open === trailingRun(out)) {
      out = out.slice(0, -open.length) + fragment.slice(open.length);
    } else {
      out += fragment;
    }
  }
  return out;
}

function wrapInline(delimiter, node, opts, active) {
  // <em><em>x</em></em> means the same as <em>x</em>; re-wrapping would
  // produce `**x**` and change the meaning to strong.
  if (active.has(delimiter)) return renderInline(node.children, opts, active);
  const rendered = renderInline(node.children, opts, new Set(active).add(delimiter));
  const inner = rendered.trim();
  if (inner === '') return rendered === '' ? '' : ' ';
  // Emphasis delimiters must hug the content, so whitespace at the edges of
  // the children is hoisted outside (`<strong>a </strong>b` -> `**a** b`).
  const lead = /^\s/.test(rendered) ? ' ' : '';
  const trail = /\s$/.test(rendered) ? ' ' : '';
  return lead + delimiter + inner + delimiter + trail;
}

function inlineCode(text) {
  const content = text.replace(/\n/g, ' ');
  if (content === '') return '';
  let longestRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = '`'.repeat(longestRun + 1);
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
  return fence + pad + content + pad + fence;
}

function destination(url) {
  const text = String(url);
  if (/\s/.test(text)) return '<' + text + '>';
  return text.replace(/[()]/g, (c) => '\\' + c);
}

const titlePart = (title) =>
  title === null || title === undefined ? '' : ` "${String(title).replace(/"/g, '\\"')}"`;

function link(node, opts, active) {
  const { href, title } = node.props;
  const text = renderInline(node.children, opts, active).trim();
  if (href === null || href === undefined || href === '') return text;
  return `[${text || destination(href)}](${destination(href)}${titlePart(title)})`;
}

function image(node) {
  const { src = '', alt = '', title } = node.props;
  return `![${escapeText(collapseWs(String(alt)))}](${destination(src)}${titlePart(title)})`;
}

function inlineElement(node, opts, active) {
  switch (node.tag) {
    case 'strong':
    case 'b':
      return wrapInline('**', node, opts, active);
    case 'em':
    case 'i':
      return wrapInline('*', node, opts, active);
    case 'del':
    case 's':
    case 'strike':
      return wrapInline('~~', node, opts, active);
    case 'code':
    case 'kbd':
    case 'samp':
      return inlineCode(rawText(node.children));
    case 'a':
      return link(node, opts, active);
    case 'img':
      return image(node);
    case 'br':
      return '\\\n';
    case 'input':
      // GFM task list checkboxes; other inputs have no markdown meaning.
      if (node.props.type !== 'checkbox') return '';
      return node.props.checked ?? node.props.defaultChecked ? '[x]' : '[ ]';
    default:
      // Block tags degrade to their inline content here; unknown tags and
      // span-likes pass their children through.
      return renderInline(node.children, opts, active);
  }
}

function escapeLineStart(line) {
  if (/^[-=]+$/.test(line)) return '\\' + line; // hr / setext underline
  return line
    .replace(/^([#>+-])( |$)/, '\\$1$2')
    .replace(/^(\d+)([.)])( |$)/, '$1\\$2$3');
}

// Turn a run of inline nodes into zero or one paragraph blocks.
function paragraphBlock(run, opts) {
  const text = renderInline(run, opts);
  const lines = text.split('\n').map((line) => escapeLineStart(line.trim()));
  // Hard breaks (`<br>`, a lone trailing backslash) cannot start or end a
  // paragraph: at the end the backslash renders literally. Escaped
  // backslashes come in pairs, so an odd trailing run means a hard break.
  while (lines.length > 0 && (lines[0] === '' || lines[0] === '\\')) lines.shift();
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const run = /\\*$/.exec(last)[0].length;
    if (last !== '' && run % 2 === 0) break;
    const kept = last.slice(0, last.length - (run % 2)).trimEnd();
    if (kept === '') lines.pop();
    else {
      lines[lines.length - 1] = kept;
      break;
    }
  }
  const body = lines.join('\n');
  return body === '' ? [] : [body];
}

function heading(node, opts) {
  const level = Number(node.tag[1]);
  // A trailing run of `#` preceded by whitespace is an ATX closing sequence
  // and would be stripped by the parser.
  const text = singleLine(renderInline(node.children, opts)).replace(/(^|\s)(#+)$/, '$1\\$2');
  return [('#'.repeat(level) + ' ' + text).trimEnd()];
}

function fencedCode(node, opts) {
  let language = '';
  let contentNodes = node.children;
  const significant = node.children.filter(
    (child) => typeof child !== 'string' || child.trim() !== '',
  );
  if (significant.length === 1 && typeof significant[0] !== 'string' && significant[0].tag === 'code') {
    const className = String(significant[0].props.className ?? significant[0].props.class ?? '');
    const match = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(className);
    if (match) language = match[1];
    contentNodes = significant[0].children;
  }
  const text = rawText(contentNodes).replace(/^\n/, '').replace(/\n$/, '');
  let fenceLength = 3;
  for (const match of text.matchAll(/^\s*(`{3,})/gm)) {
    fenceLength = Math.max(fenceLength, match[1].length + 1);
  }
  const fence = '`'.repeat(fenceLength);
  return [`${fence}${language}\n${text}\n${fence}`];
}

function blockquote(node, opts) {
  const inner = serializeBlocks(node.children, opts);
  if (inner.length === 0) return [];
  const quoted = inner
    .join('\n\n')
    .split('\n')
    .map((line) => (line === '' ? '>' : '> ' + line))
    .join('\n');
  return [quoted];
}

// Blocks that may directly follow a paragraph line inside a list item
// without a separating blank line (they interrupt paragraphs in CommonMark).
const interruptsParagraph = (block) => /^(?:[-*+] |1[.)] |> |#{1,6} |`{3})/.test(block);

function listItemBody(children, opts) {
  const blocks = serializeBlocks(children, opts);
  let body = '';
  for (let i = 0; i < blocks.length; i++) {
    // A blank line is required between blocks (two paragraphs would merge
    // via lazy continuation), except before blocks that interrupt tightly.
    if (i > 0) body += interruptsParagraph(blocks[i]) ? '\n' : '\n\n';
    body += blocks[i];
  }
  return body;
}

// Two lists of the same kind separated only by a blank line parse as one
// loose list, so a list directly following another alternates its marker
// (`-`/`*`, `1.`/`1)`), which CommonMark defines as starting a new list.
const previousListDelimiter = (prev, ordered) => {
  if (typeof prev !== 'string') return null;
  const match = (ordered ? /^\d+([.)])(?: |$)/ : /^([-*+])(?: |$)/).exec(prev);
  return match ? match[1] : null;
};

function list(node, opts, prev) {
  const ordered = node.tag === 'ol';
  const previous = previousListDelimiter(prev, ordered);
  const delimiter = ordered ? (previous === '.' ? ')' : '.') : previous === '-' ? '*' : '-';
  const requestedStart = Number(node.props.start);
  const start = Number.isInteger(requestedStart) && requestedStart >= 0 ? requestedStart : 1;
  const items = node.children.filter((child) => typeof child !== 'string' && child.tag === 'li');
  const lines = [];
  let index = start;
  for (const item of items) {
    const marker = ordered ? `${index}${delimiter} ` : `${delimiter} `;
    index += 1;
    const indent = ' '.repeat(marker.length);
    const itemLines = listItemBody(item.children, opts).split('\n');
    // A GFM task marker must be followed by whitespace to count.
    const first = itemLines[0].replace(/^(\[[ x]\])(?=\S)/, '$1 ');
    lines.push((marker + first).trimEnd());
    for (let i = 1; i < itemLines.length; i++) {
      lines.push(itemLines[i] === '' ? '' : indent + itemLines[i]);
    }
  }
  return lines.length === 0 ? [] : [lines.join('\n')];
}

function collectRows(node) {
  const rows = [];
  const visit = (child) => {
    if (typeof child === 'string') return;
    if (child.tag === 'tr') rows.push(child);
    else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
      child.children.forEach(visit);
    }
  };
  node.children.forEach(visit);
  return rows;
}

function cellAlign(cell) {
  const align = cell.props.align ?? cell.props.style?.textAlign;
  return align === 'left' || align === 'center' || align === 'right' ? align : null;
}

function table(node, opts) {
  const rows = collectRows(node);
  if (rows.length === 0) return [];
  // GFM has no caption syntax; the caption becomes the paragraph above.
  const caption = node.children.find((child) => typeof child !== 'string' && child.tag === 'caption');
  const captionBlocks = caption ? paragraphBlock(caption.children, opts) : [];
  // colSpan > 1 pads with empty cells so later columns stay aligned.
  const cellsOf = (row) => {
    const cells = [];
    for (const child of row.children) {
      if (typeof child === 'string' || (child.tag !== 'th' && child.tag !== 'td')) continue;
      cells.push(child);
      const span = Math.floor(Number(child.props.colSpan ?? child.props.colspan ?? 1)) || 1;
      for (let i = 1; i < span; i++) cells.push(null);
    }
    return cells;
  };
  const renderCell = (cell) =>
    cell === null ? '' : singleLine(renderInline(cell.children, opts)).replace(/\|/g, '\\|');

  const isHeaderRow = (row) => cellsOf(row).some((cell) => cell !== null && cell.tag === 'th');
  let headerIndex = rows.findIndex(isHeaderRow);
  if (headerIndex === -1) headerIndex = 0;
  const headerCells = cellsOf(rows[headerIndex]);
  const bodyRows = rows.filter((_, i) => i !== headerIndex);

  const columnCount = Math.max(headerCells.length, ...bodyRows.map((row) => cellsOf(row).length), 1);
  const formatRow = (cells) =>
    '| ' + Array.from({ length: columnCount }, (_, i) => cells[i] ?? '').join(' | ') + ' |';

  const separators = Array.from({ length: columnCount }, (_, i) => {
    const align = headerCells[i] ? cellAlign(headerCells[i]) : null;
    if (align === 'left') return ':---';
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    return '---';
  });

  const lines = [
    formatRow(headerCells.map(renderCell)),
    formatRow(separators),
    ...bodyRows.map((row) => formatRow(cellsOf(row).map(renderCell))),
  ];
  return [...captionBlocks, lines.join('\n')];
}

// `prev` is the markdown of the block emitted just before this one in the
// same sequence (or null); lists use it to avoid merging with a neighbour.
export function serializeBlockNode(node, opts, prev = null) {
  const custom = opts.components && opts.components[node.tag];
  if (custom) {
    const helpers = {
      inline: () => renderInline(node.children, opts).trim(),
      blocks: () => serializeBlocks(node.children, opts).join('\n\n'),
    };
    const out = custom(node.props, helpers);
    if (out === null || out === undefined || out === '') return [];
    return [String(out).replace(/^\n+|\n+$/g, '')];
  }
  switch (node.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return heading(node, opts);
    case 'p':
    case 'dt':
    case 'dd':
      return paragraphBlock(node.children, opts);
    case 'pre':
      return fencedCode(node, opts);
    case 'blockquote':
      return blockquote(node, opts);
    case 'ul':
    case 'ol':
      return list(node, opts, prev);
    case 'hr':
      return ['---'];
    case 'table':
      return table(node, opts);
    default:
      // div-like blocks pass through: their children form sibling blocks.
      return serializeBlocks(node.children, opts, prev);
  }
}

// Groups a stream of host nodes into markdown blocks: consecutive inline
// content becomes a paragraph, block elements are serialized on their own.
export class BlockGrouper {
  constructor(opts = {}, prev = null) {
    this.opts = opts;
    this.run = [];
    this.last = prev;
  }

  push(node) {
    if (node === BLOCK_BOUNDARY) return this.flush();
    if (typeof node !== 'string' && !isBlockNode(node, this.opts) && !INLINE_TAGS.has(node.tag)) {
      // Transparent element (span, unknown tag): flatten its children so
      // any blocks nested inside still become blocks.
      const out = [];
      for (const child of node.children) out.push(...this.push(child));
      return out;
    }
    if (!isBlockNode(node, this.opts)) {
      this.run.push(node);
      return [];
    }
    const flushed = this.flush();
    flushed.push(...this.emit(serializeBlockNode(node, this.opts, this.last)));
    return flushed;
  }

  emit(blocks) {
    if (blocks.length > 0) this.last = blocks[blocks.length - 1];
    return blocks;
  }

  flush() {
    if (this.run.length === 0) return [];
    const run = this.run;
    this.run = [];
    return this.emit(paragraphBlock(run, this.opts));
  }

  end() {
    return this.flush();
  }
}

export function serializeBlocks(nodes, opts, prev = null) {
  const grouper = new BlockGrouper(opts, prev);
  const out = [];
  for (const node of nodes) out.push(...grouper.push(node));
  out.push(...grouper.end());
  return out;
}
