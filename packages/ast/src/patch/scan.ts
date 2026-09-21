/**
 * Low level DOT lexical helpers used to locate exact source positions for
 * punctuation characters (`{`, `}`, `[`, `]`) and separators.
 *
 * The AST records statement ranges but not the positions of delimiters or the
 * whitespace between statements. Everything here walks raw source while
 * respecting quoted strings, HTML strings and comments so delimiters inside
 * them are never mistaken for syntax.
 *
 * @group Patch
 */

/**
 * A DOT lexical token relevant to structural scanning.
 */
export interface DotToken {
  type: '{' | '}' | '[' | ']' | ';' | ',' | 'comment' | 'other';
  start: number;
  end: number;
  text: string;
}

/**
 * Tokenize DOT source at the given range. Only tokens needed by the patch
 * planner are emitted individually; identifiers, literals and whitespace are
 * aggregated as `other`.
 */
export function tokenizeDot(
  source: string,
  from = 0,
  to = source.length,
): DotToken[] {
  const tokens: DotToken[] = [];
  let i = from;
  const pushOther = (start: number, end: number): void => {
    if (end > start) {
      tokens.push({
        type: 'other',
        start,
        end,
        text: source.slice(start, end),
      });
    }
  };
  let otherStart = i;
  while (i < to) {
    const ch = source[i];
    // Line comments.
    if (ch === '/' && source[i + 1] === '/') {
      pushOther(otherStart, i);
      const start = i;
      i += 2;
      while (i < to && source[i] !== '\n') {
        i++;
      }
      tokens.push({
        type: 'comment',
        start,
        end: i,
        text: source.slice(start, i),
      });
      otherStart = i;
      continue;
    }
    if (ch === '#') {
      pushOther(otherStart, i);
      const start = i;
      i++;
      while (i < to && source[i] !== '\n') {
        i++;
      }
      tokens.push({
        type: 'comment',
        start,
        end: i,
        text: source.slice(start, i),
      });
      otherStart = i;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      pushOther(otherStart, i);
      const start = i;
      i += 2;
      while (i < to && !(source[i] === '*' && source[i + 1] === '/')) {
        i++;
      }
      i = Math.min(to, i + 2);
      tokens.push({
        type: 'comment',
        start,
        end: i,
        text: source.slice(start, i),
      });
      otherStart = i;
      continue;
    }
    if (ch === '"') {
      pushOther(otherStart, i);
      const start = i;
      i++;
      while (i < to) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      tokens.push({
        type: 'other',
        start,
        end: i,
        text: source.slice(start, i),
      });
      otherStart = i;
      continue;
    }
    // HTML-like strings: balanced angle brackets.
    if (ch === '<') {
      pushOther(otherStart, i);
      const start = i;
      let depth = 0;
      while (i < to) {
        if (source[i] === '<') {
          depth++;
          i++;
          continue;
        }
        if (source[i] === '>') {
          depth--;
          i++;
          if (depth === 0) {
            break;
          }
          continue;
        }
        if (source[i] === '"') {
          // Quoted attribute value inside HTML.
          i++;
          while (i < to && source[i] !== '"') {
            if (source[i] === '\\') {
              i++;
            }
            i++;
          }
          i++;
          continue;
        }
        i++;
      }
      tokens.push({
        type: 'other',
        start,
        end: i,
        text: source.slice(start, i),
      });
      otherStart = i;
      continue;
    }
    if (
      ch === '{' ||
      ch === '}' ||
      ch === '[' ||
      ch === ']' ||
      ch === ';' ||
      ch === ','
    ) {
      pushOther(otherStart, i);
      tokens.push({
        type: ch as DotToken['type'],
        start: i,
        end: i + 1,
        text: ch,
      });
      i++;
      otherStart = i;
      continue;
    }
    i++;
  }
  pushOther(otherStart, to);
  return tokens;
}

/**
 * Find the position of the delimiter closing the opening delimiter at
 * `openOffset`, respecting nesting, strings and comments.
 *
 * @returns The offset of the closing delimiter, or -1 if unmatched.
 */
export function findClosingDelimiter(
  source: string,
  openOffset: number,
): number {
  const open = source[openOffset];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  const tokens = tokenizeDot(source, openOffset);
  for (const token of tokens) {
    if (token.type === open) {
      depth++;
    } else if (token.type === close) {
      depth--;
      if (depth === 0) {
        return token.start;
      }
    }
  }
  return -1;
}

/**
 * Determine the predominant end-of-line sequence used in a source range.
 */
export function detectEol(source: string): '\r\n' | '\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      if (source[i - 1] === '\r') {
        crlf++;
      } else {
        lf++;
      }
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Find the column offset (number of spaces/tabs) at the start of the line
 * containing `offset`.
 */
export function lineIndent(source: string, offset: number): string {
  let lineStart = offset;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') {
    lineStart--;
  }
  let end = lineStart;
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) {
    end++;
  }
  return source.slice(lineStart, end);
}
