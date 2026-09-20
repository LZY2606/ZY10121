import type {
  AttributeASTNode,
  AttributeListASTNode,
  ClusterStatementASTNode,
  LiteralASTNode,
} from '../../types.js';
import { escape } from '../../dot-shim/printer/plugins/utils/escape.js';

/**
 * Serialize a DOT literal value, honoring an existing literal's quote style
 * when one is supplied.
 *
 * @internal
 */
export function renderValueLiteral(
  value: string,
  style?: LiteralASTNode['quoted'],
): string {
  if (value.startsWith('<') && value.endsWith('>') && value.length >= 2) {
    return value;
  }
  if (style === false && /^-?(\.[0-9]+|[0-9]+(\.[0-9]*)?)$/.test(value)) {
    return value;
  }
  if (style === false && /^[^\s"#<>\[\]=;,{}]+$/u.test(value)) {
    return value;
  }
  return `"${escape(value)}"`;
}

/**
 * Render the text of a single attribute inside an `[...]` list (no trailing
 * separator).
 *
 * @internal
 */
export function renderAttributeItem(
  key: string,
  value: string,
): string {
  return `${key}=${renderValueLiteral(value)}`;
}

/**
 * Find the byte offsets of the opening `[` and closing `]` brackets of an
 * attribute list statement in the original source.
 *
 * @internal
 */
export function findBrackets(
  source: string,
  list: AttributeListASTNode,
): { open: number; close: number } | null {
  const loc = list.location;
  if (!loc) {
    return null;
  }
  const start = loc.start.offset;
  const end = loc.end.offset;
  let depth = 0;
  let open = -1;
  for (let i = start; i < end; i++) {
    const ch = source[i];
    if (ch === '[') {
      if (depth === 0) {
        open = i;
      }
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return { open, close: i };
      }
    }
  }
  return null;
}

const isSpace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\t';

/**
 * Determine the insertion gap immediately before an attribute list's closing
 * bracket, preserving the original separator / spacing convention.
 *
 * @internal
 */
export function bracketInsertGap(
  source: string,
  list: AttributeListASTNode,
  brackets: { open: number; close: number },
): { at: number; prefix: string; suffix: string } {
  const attrs = list.children.filter(
    (v): v is AttributeASTNode => v.type === 'Attribute',
  );
  if (attrs.length === 0) {
    let i = brackets.open + 1;
    while (i < brackets.close && isSpace(source[i])) i++;
    return { at: i, prefix: '', suffix: i === brackets.open + 1 ? ' ' : '' };
  }
  const last = attrs[attrs.length - 1];
  let i = last.location ? last.location.end.offset : brackets.close;
  // Swallow an existing trailing separator and the following whitespace so the
  // new item keeps a single consistent separator.
  if (source[i] === ',' || source[i] === ';') {
    i++;
    const sep = source[i - 1];
    let j = i;
    while (j < brackets.close && isSpace(source[j])) j++;
    if (j === brackets.close) {
      return { at: i, prefix: `${sep} `, suffix: '' };
    }
    return { at: i, prefix: `${sep}`, suffix: '' };
  }
  let j = i;
  while (j < brackets.close && isSpace(source[j])) j++;
  if (j === brackets.close) {
    return { at: i, prefix: ', ', suffix: '' };
  }
  return { at: i, prefix: ',', suffix: '' };
}

/**
 * Choose a representative separator/space between attribute items.
 *
 * @internal
 */
export function representativeSeparator(
  source: string,
  list: AttributeListASTNode,
): string {
  const attrs = list.children.filter(
    (v): v is AttributeASTNode => v.type === 'Attribute',
  );
  for (const attr of attrs) {
    if (!attr.location) continue;
    let i = attr.location.end.offset;
    while (isSpace(source[i])) i++;
    if (source[i] === ',') {
      return source[i + 1] === ' ' ? ', ' : ',';
    }
    if (source[i] === ';') {
      return source[i + 1] === ' ' ? '; ' : ';';
    }
  }
  return ', ';
}

/** Detect the dominant line ending of a source. */
export function detectEOL(source: string): string {
  const crlfCount = (source.match(/\r\n/g) ?? []).length;
  const lfCount = (source.match(/(?<!\r)\n/g) ?? []).length;
  return crlfCount > lfCount ? '\r\n' : '\n';
}

const lineStart = (source: string, offset: number): number => {
  let i = offset;
  while (i > 0 && source[i - 1] !== '\n' && source[i - 1] !== '\r') {
    i--;
  }
  // Step over a possible CR when the line ended with CRLF.
  return i;
};

/** Leading horizontal whitespace of the line containing `offset`. */
export function lineIndent(source: string, offset: number): string {
  const start = lineStart(source, offset);
  let end = start;
  while (isSpace(source[end])) end++;
  return source.slice(start, end);
}

/**
 * Resolve a statement's full replacement range, expanding it to include the
 * leading indentation and a single trailing line break so deletions keep
 * surrounding blank lines byte-identical.
 *
 * @internal
 */
export function statementRemovalRange(
  source: string,
  stmt: ClusterStatementASTNode,
): { start: number; end: number } | null {
  const loc = stmt.location;
  if (!loc) {
    return null;
  }
  let end = loc.end.offset;
  // Consume exactly one terminating line break (LF, CRLF, or CR).
  if (source[end] === '\r' && source[end + 1] === '\n') {
    end += 2;
  } else if (source[end] === '\n' || source[end] === '\r') {
    end += 1;
  }
  const start = lineStart(source, loc.start.offset);
  return { start, end };
}

/**
 * Render an inserted cluster statement with the indentation of the line at
 * `anchor`.
 *
 * @internal
 */
export function renderInsertedStatement(
  source: string,
  anchor: number,
  text: string,
  eol: string,
): { at: number; replacement: string } {
  const start = lineStart(source, anchor);
  const indent = lineIndent(source, anchor);
  return { at: start, replacement: `${indent}${text}${eol}` };
}

/**
 * Render an append at the end of a cluster body, placed immediately before the
 * closing brace of `braceClose`.
 *
 * @internal
 */
export function renderClusterAppend(
  source: string,
  braceClose: number,
  indent: string,
  text: string,
  eol: string,
): { at: number; replacement: string } {
  // Find non-space content before the brace on the current (previous) lines.
  let line = braceClose;
  while (line > 0 && source[line - 1] !== '\n' && source[line - 1] !== '\r') {
    line--;
  }
  const linePrefix = source.slice(line, braceClose);
  const lineHasContent = /[^\s\r\n]/.test(linePrefix);

  if (lineHasContent) {
    return { at: line, replacement: `${indent}${text}${eol}${linePrefix}` };
  }
  // Empty cluster: insert on a fresh line before the brace line, reusing the
  // brace line indentation for the new statement.
  const braceIndent = lineIndent(source, line);
  let at = line;
  // Skip a CR when the preceding line ends with CRLF.
  if (source[at - 1] === '\r') at--;
  return {
    at,
    replacement: `${eol}${braceIndent}${indent}${text}${eol}${linePrefix}`,
  };
}

/**
 * Find the closing brace of a Graph/Subgraph AST node. Falls back to the node
 * range end when the brace cannot be located precisely.
 *
 * @internal
 */
export function findClosingBrace(
  source: string,
  body: { location?: { start: { offset: number }; end: { offset: number } } },
): number {
  const loc = body.location;
  if (!loc) {
    return -1;
  }
  for (let i = loc.end.offset - 1; i >= loc.start.offset; i--) {
    if (source[i] === '}') {
      return i;
    }
  }
  return loc.end.offset;
}
