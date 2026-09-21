import { contentHash } from './hash.js';
import { type PatchPlan, PatchPreconditionError } from './types.js';

/**
 * Apply a planned patch to source text.
 *
 * The complete source hash and every per-operation range hash are verified
 * before any byte is changed. If verification fails, a
 * {@link PatchPreconditionError} is thrown and no edit is applied — offsets are
 * never re-guessed against changed text.
 *
 * Operations must be ordered back-to-front by range start; same-position
 * insertions must already have been merged by the planner.
 *
 * @group Patch
 */
export function applyPatchPlan(currentSource: string, plan: PatchPlan): string {
  if (plan.status !== 'ok') {
    throw new PatchPreconditionError(
      null,
      'Cannot apply an ambiguous patch plan; resolve every ambiguity first.',
    );
  }
  if (contentHash(currentSource) !== plan.sourceHash) {
    throw new PatchPreconditionError(
      null,
      'Source text has changed since the patch plan was created; re-plan before applying.',
    );
  }
  for (const operation of plan.operations) {
    const actual = currentSource.slice(
      operation.range.start,
      operation.range.end,
    );
    if (contentHash(actual) !== operation.preconditionHash) {
      throw new PatchPreconditionError(
        operation,
        `Precondition failed for a patch at offset ${operation.range.start}; the covered text has changed.`,
      );
    }
  }
  // Back-to-front application keeps earlier offsets valid.
  const ordered = [...plan.operations].sort(
    (a, b) => b.range.start - a.range.start,
  );
  let output = currentSource;
  for (const operation of ordered) {
    output =
      output.slice(0, operation.range.start) +
      operation.replacement +
      output.slice(operation.range.end);
  }
  return output;
}
