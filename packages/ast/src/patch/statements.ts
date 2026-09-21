import type {
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  SubgraphASTNode,
} from '../types.js';
import { makeOperation } from './edits.js';
import { detectEol, lineIndent } from './scan.js';
import type { PatchOperation, PatchTargetPath } from './types.js';

export interface BlockInfo {
  ast: GraphASTNode | SubgraphASTNode;
  open: number;
  close: number;
}

/**
 * Child indentation inside a block: the indent of the first non-empty child
 * line, or parent indent + two spaces.
 */
/**
 * Indentation used for child statements of a block: the indentation of the
 * first non-empty line inside the block, or the parent indent + two spaces.
 */
export function inferChildIndent(source: string, block: BlockInfo): string {
  const parentIndent = lineIndent(source, block.open);
  // Only look at lines before the closing brace line, so the closing brace's
  // own indentation is never mistaken for a child indent.
  let regionEnd = block.close;
  while (regionEnd > block.open && source[regionEnd - 1] !== '\n') {
    regionEnd--;
  }
  const interior = source.slice(block.open + 1, regionEnd);
  for (const line of interior.split(/\r?\n/)) {
    if (line.trim().length > 0) {
      const match = /^[ \t]+/.exec(line);
      if (match) {
        return match[0];
      }
      return `${parentIndent}  `;
    }
  }
  return `${parentIndent}  `;
}

function _eol(source: string): string {
  return detectEol(source);
}

/**
 * The offset at which a new child statement should be inserted when appending
 * to a block: before the closing brace, but after the brace's line
 * indentation (so indentation is supplied with the replacement text and the
 * closing brace indentation bytes are untouched).
 */
/**
 * Anchor for appending child statements:
 *
 * - empty block (`{}`): insert between the braces as a complete new line;
 * - non-empty block: insert at the end of the last child line (right after the
 *   last byte before the closing brace's line break), prefixed with a line
 *   break and the child indentation. The closing brace indentation is never
 *   touched.
 */
function appendAnchor(
  source: string,
  block: BlockInfo,
): { offset: number; prefix: string; suffix: string } {
  const closeIndent = lineIndent(source, block.close);
  const line = detectEol(source);
  const interior = source.slice(block.open + 1, block.close);
  if (interior.trim().length === 0) {
    // The block holds only whitespace. If it already ends in a line break,
    // anchor directly before the closing brace indentation and reuse that
    // break; otherwise (a one-line `{}`) synthesize the surrounding breaks.
    const offset = block.close - closeIndent.length;
    if (source.slice(offset - line.length, offset) === line) {
      return { offset, prefix: '', suffix: line + closeIndent };
    }
    if (line === '\r\n' && source[offset - 1] === '\n') {
      return {
        offset: offset - 1,
        prefix: '',
        suffix: line + closeIndent,
      };
    }
    return {
      offset: block.close,
      prefix: line,
      suffix: `${line}${closeIndent}`,
    };
  }
  // Non-empty block: append right after the last byte of existing interior
  // content. Walk back from the closing brace over indentation and blank
  // lines, consuming exactly one line break as the separator before the new
  // statement. Any further blank lines remain after the inserted statement
  // (untouched), so e.g. `a;\n\n}` gains content between `a;` and the blank
  // line without deleting the blank line.
  let offset = block.close - closeIndent.length;
  let consumedBreak = false;
  while (offset > block.open + 1) {
    const ch = source[offset - 1];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (!consumedBreak && ch === '\n') {
        consumedBreak = true;
        if (line === '\r\n' && source[offset - 2] === '\r') {
          offset -= 2;
          continue;
        }
      }
      offset--;
      continue;
    }
    break;
  }
  return {
    offset,
    prefix: consumedBreak ? line : line,
    suffix: consumedBreak ? '' : line + closeIndent,
  };
}

/**
 * Build the insertion operation for one or more new statements appended to a
 * block. The supplied `text` must already be indented for the block's child
 * column; only the leading line break (and, for empty blocks, the closing
 * layout) is added around it.
 */
export function insertStatements(
  source: string,
  block: BlockInfo,
  text: string,
  target: PatchTargetPath,
): PatchOperation {
  const { offset, prefix, suffix } = appendAnchor(source, block);
  return makeOperation(
    source,
    { start: offset, end: offset },
    `${prefix}${text}${suffix}`,
    target,
    {
      code: 'statement-added',
      message: 'Inserting the new statement in model order at the block end.',
    },
  );
}

/**
 * Remove a statement from its block, consuming its line indentation and the
 * following line break when the statement occupies its own line, but leaving
 * blank lines and comments intact.
 */
export function removeStatement(
  source: string,
  statement: NodeASTNode | EdgeASTNode | SubgraphASTNode,
  target: PatchTargetPath,
): PatchOperation {
  const startLocation = statement.location?.start.offset;
  const endLocation = statement.location?.end.offset;
  if (startLocation === undefined || endLocation === undefined) {
    throw new Error('Statement has no source location.');
  }
  let start = startLocation;
  while (start > 0 && /[ \t]/.test(source[start - 1])) {
    start--;
  }
  let end = endLocation;
  // Swallow one following line break so no empty line remains, but never
  // swallow a second newline (that would delete a blank line).
  if (source[end] === '\r' && source[end + 1] === '\n') {
    end += 2;
  } else if (source[end] === '\n') {
    end += 1;
  }
  return makeOperation(source, { start, end }, '', target, {
    code: 'statement-removed',
    message:
      'Removing the statement and its own line break; adjacent blank lines are preserved.',
  });
}

/**
 * Move a subgraph by removing its statement from the old block and inserting
 * it into the new block. Produced as two ranges; the planner merges them with
 * other overlapping operations at the LCA.
 */
export function moveSubgraphOperations(
  source: string,
  statement: SubgraphASTNode,
  oldBlock: BlockInfo,
  newBlock: BlockInfo,
  movedText: string,
  target: PatchTargetPath,
): { removal: PatchOperation; insertion: PatchOperation } {
  void oldBlock;
  const removal = removeStatement(source, statement, target);
  const insertion = insertStatements(source, newBlock, movedText, target);
  // Mark both as moves for diagnostics.
  removal.reason = {
    code: 'statement-moved',
    message: 'Removing the subgraph statement from its original container.',
  };
  insertion.reason = {
    code: 'statement-moved',
    message:
      'Inserting the moved subgraph into its new container in model order.',
  };
  return { removal, insertion };
}
