import type { AttributeASTNode, AttributeListASTNode } from '../../types.js';
import {
  bracketInsertGap,
  findBrackets,
  renderAttributeItem,
  renderValueLiteral,
} from '../render/source-text.js';

/** Replacement operation over a raw source range. */
export interface TextOp {
  start: number;
  end: number;
  replacement: string;
}

const isSpace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\t';

/**
 * Build the replacement for an attribute value literal. The original quote
 * style is preserved whenever the new value is representable in that style.
 *
 * @internal
 */
export function editAttributeValue(
  source: string,
  attr: AttributeASTNode,
  newValue: string,
): TextOp | null {
  const loc = attr.value.location;
  if (!loc) {
    return null;
  }
  const replacement = renderValueLiteral(newValue, attr.value.quoted);
  return {
    start: loc.start.offset,
    end: loc.end.offset,
    replacement,
  };
}

/**
 * Insert a new `key=value` attribute into an existing attribute list, just
 * before its closing bracket.
 *
 * @internal
 */
export function insertAttributeIntoList(
  source: string,
  list: AttributeListASTNode,
  key: string,
  value: string,
): TextOp | null {
  const brackets = findBrackets(source, list);
  if (!brackets) {
    return null;
  }
  const gap = bracketInsertGap(source, list, brackets);
  const item = renderAttributeItem(key, value);
  return {
    start: gap.at,
    end: gap.at,
    replacement: `${gap.prefix}${item}${gap.suffix}`,
  };
}

/**
 * Insert a new attribute list immediately before a statement's terminating
 * semicolon (or directly after the statement when none is present).
 *
 * @internal
 */
export function insertListBeforeTerminator(
  source: string,
  stmtEnd: number,
  text: string,
): TextOp {
  if (source[stmtEnd - 1] === ';') {
    return { start: stmtEnd - 1, end: stmtEnd - 1, replacement: `${text};` };
  }
  return { start: stmtEnd, end: stmtEnd, replacement: text };
}

/**
 * Delete one attribute from an attribute list. Prefer consuming a leading
 * separator so the remaining `[...]` stays valid.
 *
 * @internal
 */
export function deleteAttributeFromList(
  source: string,
  list: AttributeListASTNode,
  attr: AttributeASTNode,
): TextOp | null {
  const brackets = findBrackets(source, list);
  const loc = attr.location;
  if (!brackets || !loc) {
    return null;
  }
  const attrs = list.children.filter(
    (v): v is AttributeASTNode => v.type === 'Attribute',
  );
  const index = attrs.indexOf(attr);

  // First try consuming the separator immediately before the attribute.
  let probe = loc.start.offset - 1;
  while (probe > brackets.open && isSpace(source[probe])) probe--;
  if (source[probe] === ',' || source[probe] === ';') {
    let end = loc.end.offset;
    // Trim a single following space so spacing stays consistent.
    if (isSpace(source[end])) end++;
    return { start: probe, end, replacement: '' };
  }

  // Otherwise consume a trailing separator (first item case).
  let end = loc.end.offset;
  if (source[end] === ',' || source[end] === ';') {
    end++;
    if (isSpace(source[end])) end++;
  } else {
    // No separator at all: trim a following space to avoid a double space.
    if (isSpace(source[end])) end++;
  }
  // If this is the last remaining item, swallow a preceding space near `[`.
  if (index === attrs.length - 1 && index === 0) {
    let start = loc.start.offset;
    while (start > brackets.open + 1 && isSpace(source[start - 1])) start--;
    return { start, end, replacement: '' };
  }
  return { start: loc.start.offset, end, replacement: '' };
}
