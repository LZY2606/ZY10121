import type {
  AttributeListASTNode,
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  SubgraphASTNode,
} from '../types.js';
import { findClosingDelimiter, tokenizeDot } from './scan.js';

/**
 * Position of the attribute-list brackets attached to a node/edge statement,
 * or the brackets of an AttributeList statement.
 *
 * @group Patch
 */
export interface ListRange {
  /** Offset of `[`. */
  open: number;
  /** Offset of `]`. */
  close: number;
}

function requireLocation(node: {
  location?: { start: { offset: number }; end: { offset: number } };
}): { start: number; end: number } {
  if (!node.location) {
    throw new Error('AST node has no source location; cannot patch.');
  }
  return {
    start: node.location.start.offset,
    end: node.location.end.offset,
  };
}

/**
 * Find the outermost `[ ... ]` attribute list range within a node/edge
 * statement range. Nested braces (anonymous subgraphs used as edge targets)
 * are ignored: the first unmatched `[` is the attribute list opener.
 */
export function findStatementListRange(
  source: string,
  statement: NodeASTNode | EdgeASTNode,
): ListRange | undefined {
  const { start, end } = requireLocation(statement);
  return findFirstBracketList(source, start, end);
}

/**
 * Find the bracket range of an `AttributeList` statement.
 */
export function findAttributeListRange(
  source: string,
  list: AttributeListASTNode,
): ListRange {
  const { start } = requireLocation(list);
  // The statement starts with `graph`/`node`/`edge`; locate its `[`.
  const range = findFirstBracketList(source, start, requireLocation(list).end);
  if (!range) {
    throw new Error('Malformed AttributeList AST: no brackets found.');
  }
  return range;
}

function findFirstBracketList(
  source: string,
  start: number,
  end: number,
): ListRange | undefined {
  let depth = 0;
  let open = -1;
  for (const token of tokenizeDot(source, start, end)) {
    if (token.type === '[') {
      if (depth === 0) {
        open = token.start;
      }
      depth++;
    } else if (token.type === ']') {
      depth--;
      if (depth === 0 && open !== -1) {
        return { open, close: token.start };
      }
    }
  }
  return undefined;
}

/**
 * The `{` / `}` offsets of a graph or subgraph AST node.
 *
 * @group Patch
 */
export interface BlockRange {
  open: number;
  close: number;
}

export function findBlockRange(
  source: string,
  block: GraphASTNode | SubgraphASTNode,
): BlockRange {
  const { start, end } = requireLocation(block);
  const tokens = tokenizeDot(source, start, end);
  let open = -1;
  let depth = 0;
  let close = -1;
  for (const token of tokens) {
    if (token.type === '{') {
      if (depth === 0) {
        open = token.start;
      }
      depth++;
    } else if (token.type === '}') {
      depth--;
      if (depth === 0) {
        close = token.start;
        break;
      }
    }
  }
  if (open === -1 || close === -1) {
    throw new Error('Malformed block AST: no braces found.');
  }
  return { open, close };
}

/**
 * Returns true when a statement ends with a semicolon within its AST range.
 */
export function hasTrailingSemicolon(
  source: string,
  statement: {
    location?: { start: { offset: number }; end: { offset: number } };
  },
): boolean {
  const { end } = requireLocation(statement);
  return source[end - 1] === ';';
}

/**
 * Range of the trailing semicolon of a statement, when present.
 */
export function trailingSemicolonRange(
  source: string,
  statement: NodeASTNode | EdgeASTNode,
): { start: number; end: number } | undefined {
  const { end } = requireLocation(statement);
  return source[end - 1] === ';' ? { start: end - 1, end } : undefined;
}

/**
 * Expand a statement range to include leading whitespace on its line (without
 * swallowing preceding blank lines or comments). The returned range starts at
 * the first non-newline whitespace character preceding the statement on the
 * same line.
 */
export function statementRemovalRange(
  source: string,
  statement:
    | NodeASTNode
    | EdgeASTNode
    | SubgraphASTNode
    | AttributeListASTNode
    | import('../types.js').AttributeASTNode,
): { start: number; end: number } {
  const { start, end } = requireLocation(statement);
  let removeStart = start;
  while (
    removeStart > 0 &&
    (source[removeStart - 1] === ' ' || source[removeStart - 1] === '\t')
  ) {
    removeStart--;
  }
  return { start: removeStart, end };
}

/**
 * Find the offset of the closing delimiter `}` for a block, given the offset
 * of its opening `{`.
 */
export function blockClose(source: string, openOffset: number): number {
  return findClosingDelimiter(source, openOffset);
}

/**
 * The raw text of a source range.
 *
 * @group Patch
 */
export function sliceRange(
  source: string,
  range: { start: number; end: number },
): string {
  return source.slice(range.start, range.end);
}

/**
 * Return the numeric `[start, end)` offsets of an AST node's location,
 * throwing when the node carries no source location.
 *
 * @group Patch
 */
export function offsetsOf(node: {
  location?: {
    start: { offset: number };
    end: { offset: number };
  };
}): { start: number; end: number } {
  if (!node.location) {
    throw new Error('AST node has no source location; cannot patch.');
  }
  return {
    start: node.location.start.offset,
    end: node.location.end.offset,
  };
}
