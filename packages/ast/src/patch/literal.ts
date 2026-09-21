import { escape } from '../dot-shim/printer/plugins/utils/escape.js';
import type { LiteralASTNode } from '../types.js';

const BARE_IDENTIFIER = /^[^\s"\\#;,=[\]{}<>:-](?:[^\s"\\#;,=[\]{}<>]*)?$/;
const BARE_NUMBER = /^-?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)$/;
const COMPASS = /^(?:n|ne|e|se|s|sw|w|nw)$/;

/**
 * Whether `value` can be printed without quotes using the DOT bare literal
 * rules accepted by the parser (UNICODE_STRING / NUMBER).
 *
 * @group Patch
 */
export function canBeBare(value: string): boolean {
  if (BARE_NUMBER.test(value)) {
    return true;
  }
  if (COMPASS.test(value)) {
    return true;
  }
  return BARE_IDENTIFIER.test(value);
}

/**
 * Serialize an attribute value for insertion into source, preserving the
 * quote style of an existing literal when possible.
 *
 * Values wrapped in `<>...` are treated as HTML-like labels.
 *
 * @param value The new model value (a string; numeric/boolean model values are
 * stringified by the caller).
 * @param style The quote style to preserve, taken from the original literal.
 * @returns `{ text, downgraded }` where `downgraded` is true when the
 * requested style could not be preserved and quoting was forced.
 * @group Patch
 */
export function printValueLiteral(
  value: string,
  style: LiteralASTNode['quoted'],
): { text: string; downgraded: boolean } {
  if (style === 'html') {
    if (value.length >= 2 && value.startsWith('<') && value.endsWith('>')) {
      return { text: value, downgraded: false };
    }
    // The new value is not HTML-like; quote it instead of emitting broken
    // angle brackets.
    return { text: `"${escape(value)}"`, downgraded: true };
  }
  if (style === true) {
    return { text: `"${escape(value)}"`, downgraded: false };
  }
  if (canBeBare(value)) {
    return { text: value, downgraded: false };
  }
  return { text: `"${escape(value)}"`, downgraded: true };
}

/**
 * Serialize an attribute key. Keys are DOT identifiers; the original style is
 * preserved when the key is unchanged.
 *
 * @group Patch
 */
export function printKeyLiteral(value: string): string {
  return canBeBare(value) ? value : `"${escape(value)}"`;
}
