import type { PatchOperation, PatchSession } from './types.js';

/**
 * Apply patch operations and return the untouched regions of the original
 * source so tests can prove byte-for-byte preservation outside patched
 * ranges.
 */
export function untouchedRegions(
  source: string,
  operations: PatchOperation[],
): Array<{ start: number; end: number; text: string }> {
  const ordered = [...operations].sort((a, b) => a.range.start - b.range.start);
  const regions: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  for (const operation of ordered) {
    if (operation.range.start > cursor) {
      regions.push({
        start: cursor,
        end: operation.range.start,
        text: source.slice(cursor, operation.range.start),
      });
    }
    cursor = Math.max(cursor, operation.range.end);
  }
  if (cursor < source.length) {
    regions.push({
      start: cursor,
      end: source.length,
      text: source.slice(cursor),
    });
  }
  return regions;
}

/**
 * Assert every region outside patched ranges is byte-identical between the
 * original source and patched output.
 */
export function assertUntouchedBytesKept(
  source: string,
  output: string,
  operations: PatchOperation[],
): void {
  // Replay replacements on an index map and compare all non-patched spans in
  // their original order.
  const sorted = [...operations].sort((a, b) => a.range.start - b.range.start);
  let originalCursor = 0;
  let outputCursor = 0;
  for (const operation of sorted) {
    const originalSpan = source.slice(originalCursor, operation.range.start);
    const outputSpan = output.slice(
      outputCursor,
      outputCursor + originalSpan.length,
    );
    if (originalSpan !== outputSpan) {
      throw new Error(
        `Bytes outside a patched range changed before offset ${operation.range.start}.\n` +
          `expected: ${JSON.stringify(originalSpan)}\n` +
          `actual:   ${JSON.stringify(outputSpan)}`,
      );
    }
    originalCursor = operation.range.end;
    outputCursor += originalSpan.length + operation.replacement.length;
  }
  const tail = source.slice(originalCursor);
  const outputTail = output.slice(outputCursor);
  if (tail !== outputTail) {
    throw new Error(
      `Trailing bytes changed.\nexpected: ${JSON.stringify(tail)}\nactual:   ${JSON.stringify(outputTail)}`,
    );
  }
}

/**
 * Plan and apply a session, expecting an ok plan.
 */
export function applyOk(session: PatchSession): {
  output: string;
  operations: PatchOperation[];
} {
  const plan = session.plan();
  if (plan.status !== 'ok') {
    throw new Error(
      `Expected an ok plan but got ambiguities: ${plan.ambiguities
        .map((a) => a.message)
        .join('; ')}`,
    );
  }
  const { output } = session.apply();
  return { output, operations: plan.operations };
}
