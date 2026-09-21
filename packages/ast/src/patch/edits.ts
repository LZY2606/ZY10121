import type { AttributeASTNode } from '../types.js';
import { contentHash } from './hash.js';
import { printValueLiteral } from './literal.js';
import { type DotToken, tokenizeDot } from './scan.js';
import type { PatchOperation, PatchReason, PatchTargetPath } from './types.js';

export function makeOperation(
  source: string,
  range: { start: number; end: number },
  replacement: string,
  target: PatchTargetPath,
  reason: PatchReason,
): PatchOperation {
  return {
    range,
    replacement,
    target,
    reason,
    preconditionHash: contentHash(source.slice(range.start, range.end)),
  };
}

/**
 * Replace the value literal of an attribute in place.
 */
export function replaceAttributeValue(
  source: string,
  attributeAST: AttributeASTNode,
  newValue: unknown,
  target: PatchTargetPath,
): PatchOperation {
  const valueLocation = attributeAST.value.location;
  if (!valueLocation) {
    throw new Error('Attribute value has no source location.');
  }
  const { text } = printValueLiteral(
    String(newValue),
    attributeAST.value.quoted,
  );
  return makeOperation(
    source,
    { start: valueLocation.start.offset, end: valueLocation.end.offset },
    text,
    target,
    {
      code: 'attribute-value-changed',
      message: `Replacing the value of "${attributeAST.key.value}" in place and preserving its original quote style.`,
    },
  );
}

/**
 * Whether the new value cannot use the original literal style.
 */
export function valueStyleDowngraded(
  attributeAST: AttributeASTNode,
  newValue: unknown,
): boolean {
  return printValueLiteral(String(newValue), attributeAST.value.quoted)
    .downgraded;
}

export interface ListInfo {
  open: number;
  close: number;
}

/**
 * Tokens belonging to the interior of a bracket list (excluding the brackets).
 */
export function listInteriorTokens(source: string, list: ListInfo): DotToken[] {
  return tokenizeDot(source, list.open + 1, list.close);
}

/**
 * Whether a bracket list contains any attribute items.
 */
export function listHasContent(source: string, list: ListInfo): boolean {
  return source.slice(list.open + 1, list.close).trim().length > 0;
}

/**
 * Find the separator token directly following an attribute within a list
 * (before any comment or the closing bracket).
 */
function followingSeparator(
  source: string,
  list: ListInfo,
  attributeAST: AttributeASTNode,
): DotToken | undefined {
  const attrEnd = attributeAST.location?.end.offset;
  if (attrEnd === undefined) {
    return undefined;
  }
  for (const token of listInteriorTokens(source, list)) {
    if (token.end <= attrEnd) {
      continue;
    }
    if (token.type === ',' || token.type === ';') {
      return token;
    }
    if (token.type === 'comment') {
      return undefined;
    }
  }
  return undefined;
}

function precedingSeparator(
  source: string,
  list: ListInfo,
  attributeAST: AttributeASTNode,
): DotToken | undefined {
  const attrStart = attributeAST.location?.start.offset;
  if (attrStart === undefined) {
    return undefined;
  }
  let previous: DotToken | undefined;
  for (const token of listInteriorTokens(source, list)) {
    if (token.start >= attrStart) {
      break;
    }
    if (token.type === ',' || token.type === ';') {
      previous = token;
    }
  }
  return previous;
}

/**
 * Remove a single attribute item from a bracket list, swallowing one adjacent
 * separator. Comments and blank lines are never included in the range.
 */
export function removeAttributeFromList(
  source: string,
  list: ListInfo,
  attributeAST: AttributeASTNode,
  target: PatchTargetPath,
): PatchOperation {
  const attrLocation = attributeAST.location;
  if (!attrLocation) {
    throw new Error('Attribute AST has no source location.');
  }
  const attrStart = attrLocation.start.offset;
  const attrEnd = attrLocation.end.offset;
  const after = followingSeparator(source, list, attributeAST);
  if (after) {
    let end = after.end;
    // Swallow trailing horizontal whitespace only (never newlines).
    while (end < list.close && /[ \t]/.test(source[end])) {
      end++;
    }
    let start = attrStart;
    while (start > list.open + 1 && /[ \t]/.test(source[start - 1])) {
      start--;
    }
    return makeOperation(source, { start, end }, '', target, {
      code: 'attribute-removed',
      message: 'Removing the attribute and its following separator.',
    });
  }
  const before = precedingSeparator(source, list, attributeAST);
  let start = attrStart;
  let end = attrEnd;
  if (before) {
    start = before.start;
    while (start > list.open + 1 && /[ \t]/.test(source[start - 1])) {
      start--;
    }
    // Keep whitespace after the separator up to the attribute by extending end
    // over horizontal whitespace before attrStart is already consumed from
    // separator start through the attribute text.
    end = attrEnd;
  } else {
    // Sole item: remove horizontal whitespace around it.
    while (start > list.open + 1 && /[ \t]/.test(source[start - 1])) {
      start--;
    }
    while (end < list.close && /[ \t]/.test(source[end])) {
      end++;
    }
  }
  return makeOperation(source, { start, end }, '', target, {
    code: 'attribute-removed',
    message:
      before !== undefined
        ? 'Removing the attribute and its preceding separator.'
        : 'Removing the only attribute item from the list.',
  });
}

/**
 * Separator style predominantly used inside a list.
 */
export function listSeparatorStyle(
  source: string,
  list: ListInfo,
): ',' | ';' | 'space' {
  let comma = 0;
  let semi = 0;
  for (const token of listInteriorTokens(source, list)) {
    if (token.type === ',') {
      comma++;
    } else if (token.type === ';') {
      semi++;
    }
  }
  if (comma > 0 && comma >= semi) {
    return ',';
  }
  if (semi > 0) {
    return ';';
  }
  return 'space';
}

/**
 * Locate the insertion anchor for a new attribute: immediately after the last
 * existing attribute item (and its separator), before any trailing comment.
 * Returns the offset and whether a separator must be emitted.
 */
export function listInsertionAnchor(
  source: string,
  list: ListInfo,
  attributeLocations: ReadonlyArray<{ start: number; end: number }>,
): { offset: number; needsLeadingSeparator: boolean } {
  if (attributeLocations.length === 0) {
    return {
      offset: list.open + 1,
      needsLeadingSeparator: false,
    };
  }
  const last = attributeLocations.reduce((acc, item) =>
    item.end > acc.end ? item : acc,
  );
  const following = (() => {
    for (const token of listInteriorTokens(source, list)) {
      if (token.end <= last.end) {
        continue;
      }
      if (token.type === ',' || token.type === ';') {
        return token;
      }
      if (token.type === 'comment') {
        return undefined;
      }
    }
    return undefined;
  })();
  if (following) {
    let offset = following.end;
    while (offset < list.close && /[ \t]/.test(source[offset])) {
      offset++;
    }
    return { offset, needsLeadingSeparator: false };
  }
  // Insert right before `]` or before a trailing comment: emit a leading
  // separator in the list's own style.
  let offset = list.close;
  // Skip horizontal whitespace before the bracket.
  while (offset > list.open + 1 && /[ \t]/.test(source[offset - 1])) {
    offset--;
  }
  return { offset, needsLeadingSeparator: true };
}
