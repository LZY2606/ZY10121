import { RootModelsContext } from '@ts-graphviz/common';
import { parse } from '../dot-shim/parser/parse.js';
import { applyPatchPlan } from './apply.js';
import { buildBindings } from './bindings.js';
import { diffModel } from './diff.js';
import { contentHash } from './hash.js';
import { mergeOverlappingOperations } from './merge.js';
import { formatPath } from './path.js';
import { planChanges } from './plan-changes.js';
import type {
  OpenPatchSessionOptions,
  PatchOperation,
  PatchPlan,
  PatchSession,
  PatchTargetPath,
} from './types.js';

/**
 * Open an opt-in patch session for a DOT document.
 *
 * The session parses the source and builds a mutable model that remembers the
 * AST declaration(s) behind every object. Mutate {@link PatchSession.model},
 * then call {@link PatchSession.plan} to obtain minimal text changes or
 * {@link PatchSession.apply} to plan and apply them in one step.
 *
 * @param source The original DOT source text.
 * @param options Parsing/model/ambiguity options.
 * @group Patch
 */
export function openPatchSession(
  source: string,
  options: OpenPatchSessionOptions = {},
): PatchSession {
  const ast = parse(source, options.parseOptions);
  if (ast.type !== 'Dot') {
    throw new Error('A patch session requires a complete Dot document.');
  }
  const models = options.models ?? RootModelsContext;
  const { model, bindings } = buildBindings(ast, source, models);

  const session: PatchSession = {
    ast,
    model,
    source,
    plan(): PatchPlan {
      const { changes, ambiguities } = diffModel(bindings);

      // Let the caller resolve ambiguities up front.
      const resolutions = new Map<string, number>();
      const remainingAmbiguities = ambiguities.filter((ambiguity) => {
        const resolved = options.resolveAmbiguity?.(ambiguity);
        if (!resolved) {
          return true;
        }
        const candidateIndex = ambiguity.candidates.findIndex(
          (candidate) => formatPath(candidate.target) === formatPath(resolved),
        );
        if (candidateIndex === -1) {
          return true;
        }
        // Key identifies the attribute owner independent of declaration.
        const stripped = stripDeclaration(ambiguity.target);
        const ownerTarget =
          stripped.kind === 'attribute' ||
          stripped.kind === 'default-attributes'
            ? stripped.owner
            : stripped;
        const ownerKey = formatPath(ownerTarget);
        resolutions.set(
          `${ownerKey}:${ambiguity.attributeKey ?? ''}`,
          candidateIndex,
        );
        return false;
      });

      const { operations: rawOperations, owners } = planChanges(
        bindings,
        changes,
        resolutions,
      );
      const merged = mergeSamePositionInsertions(rawOperations);
      const operations = mergeOverlappingOperations(
        source,
        bindings,
        merged.map((operation) => ({
          operation,
          ast:
            owners.find((entry) => entry.operation === operation)?.ast ?? ast,
        })),
      );
      operations.sort(compareOperations);

      return {
        sourceHash: contentHash(source),
        status: remainingAmbiguities.length > 0 ? 'ambiguous' : 'ok',
        operations,
        ambiguities: remainingAmbiguities,
      };
    },
    apply(currentSource = source) {
      const plan = session.plan();
      const output = applyPatchPlan(currentSource, plan);
      return { plan, output };
    },
  };
  return session;
}

/**
 * Merge multiple pure insertions at exactly the same offset into one
 * operation, keeping insertion text in model order.
 */
function mergeSamePositionInsertions(
  operations: PatchOperation[],
): PatchOperation[] {
  const byOffset = new Map<number, PatchOperation[]>();
  const result: PatchOperation[] = [];
  for (const operation of operations) {
    if (operation.range.start !== operation.range.end) {
      result.push(operation);
      continue;
    }
    const group = byOffset.get(operation.range.start) ?? [];
    group.push(operation);
    byOffset.set(operation.range.start, group);
  }
  for (const [offset, group] of byOffset) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // All insertions at one anchor (e.g. block end) are joined directly: each
    // insertion already carries its own indentation and trailing newline.
    const combined: PatchOperation = {
      ...group[0],
      replacement: group.map((operation) => operation.replacement).join(''),
      reason: {
        ...group[0].reason,
        message:
          'Multiple insertions at the same position merged in model order.',
      },
    };
    void offset;
    result.push(combined);
  }
  return result;
}

/**
 * Sort operations back-to-front by descending start offset; insertion order
 * stability for equal offsets is preserved from the planner.
 */
function compareOperations(a: PatchOperation, b: PatchOperation): number {
  if (b.range.start !== a.range.start) {
    return b.range.start - a.range.start;
  }
  return a.range.end - b.range.end;
}

export type { PatchTargetPath };

function stripDeclaration(path: PatchTargetPath): PatchTargetPath {
  if (path.kind === 'attribute' || path.kind === 'default-attributes') {
    return { ...path, owner: stripDeclaration(path.owner) };
  }
  if ('declaration' in path) {
    return { ...(path as object), declaration: 0 } as PatchTargetPath;
  }
  return path;
}
