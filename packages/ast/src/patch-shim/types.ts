import type { FileRange } from '../types.js';

/**
 * Byte range in the original DOT source.
 *
 * Offsets are UTF-16 code unit indices into the string passed to
 * {@link createPatchSession} (the same unit used by {@link FileRange}).
 *
 * @group Patch Plan
 */
export interface SourceRange {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/**
 * Machine-readable reason explaining why a patch was produced, or why a
 * fine-grained edit was degraded into rewriting a whole ancestor statement.
 *
 * @group Patch Plan
 */
export type PatchReason =
  | {
      /** A single attribute value was changed in place. */
      kind: 'attribute-value-changed';
      /** Attribute key that changed. */
      key: string;
    }
  | {
      /** A new attribute was added to an existing attribute list. */
      kind: 'attribute-added';
      /** Attribute key that was added. */
      key: string;
    }
  | {
      /** An attribute was removed from an attribute list. */
      kind: 'attribute-removed';
      /** Attribute key that was removed. */
      key: string;
    }
  | {
      /** A new attribute-list statement (`node [...]`, `edge [...]`, `graph [...]`) was emitted. */
      kind: 'attribute-list-added';
      /** Kind of default attribute list. */
      listKind: 'Graph' | 'Node' | 'Edge';
    }
  | {
      /** A bare `key = value;` statement was added to a graph or subgraph body. */
      kind: 'graph-attribute-added';
      /** Attribute key that was added. */
      key: string;
    }
  | {
      /** A node statement was inserted. */
      kind: 'node-added';
      /** Node id of the inserted node. */
      nodeId: string;
    }
  | {
      /** A node statement was removed. */
      kind: 'node-removed';
      /** Node id of the removed node. */
      nodeId: string;
    }
  | {
      /** An edge statement was inserted. */
      kind: 'edge-added';
    }
  | {
      /** An edge statement was removed. */
      kind: 'edge-removed';
    }
  | {
      /** A subgraph statement was inserted (including a move into a new cluster). */
      kind: 'subgraph-added';
    }
  | {
      /** A subgraph statement was removed (including a move out of an old cluster). */
      kind: 'subgraph-removed';
    }
  | {
      /** A leading comment attached to a model object was added, changed or removed. */
      kind: 'comment-changed';
    }
  | {
      /**
       * A safe local edit was not possible, so the nearest serializable
       * ancestor statement was regenerated in full.
       */
      kind: 'fallback-ancestor-rewrite';
      /** Type of the AST node that had to be regenerated. */
      ancestor:
        | 'AttributeList'
        | 'Node'
        | 'Edge'
        | 'Subgraph'
        | 'Graph';
      /** Human-readable explanation of why the fallback was necessary. */
      detail: string;
    }
  | {
      /**
       * Several edits overlapped and were merged into the single nearest
       * common serializable ancestor to avoid producing crossing patches.
       */
      kind: 'merged-ancestor-rewrite';
      /** Type of the AST node chosen as the merge target. */
      ancestor: 'Subgraph' | 'Graph';
      /** Reasons of the edits that were merged together. */
      merged: PatchReason[];
    };

/**
 * A single, independently applicable text replacement in the original DOT
 * source.
 *
 * @group Patch Plan
 */
export interface PatchEntry {
  /** Byte range of the original source that {@link replacement} substitutes. */
  range: SourceRange;
  /** Replacement text. An empty string deletes the range. */
  replacement: string;
  /**
   * Stable path of the model object the change originates from.
   *
   * The path follows model ownership (`graph` -> `subgraphs` / `nodes` /
   * `edges` / `attributes`) and is stable across repeated planning calls as
   * long as the originating object identity is unchanged.
   */
  targetPath: string;
  /** Structured form of {@link targetPath}. */
  targetPathSegments: ModelPathSegment[];
  /** Why the patch exists. */
  reason: PatchReason;
  /**
   * Precondition hash (`sha256:<hex>`) over the exact bytes currently found
   * at {@link range}. Application rejects the whole plan if any entry no
   * longer matches, so offsets are never re-guessed on drifted text.
   */
  preHash: string;
}

/**
 * One hop of a {@link PatchEntry.targetPathSegments stable model path}.
 *
 * @group Patch Plan
 */
export type ModelPathSegment =
  | { kind: 'graph' }
  | { kind: 'subgraphs'; index: number }
  | { kind: 'nodes'; key: string }
  | { kind: 'edges'; index: number }
  | { kind: 'attribute'; list: 'own' | 'graph' | 'node' | 'edge'; key: string };

/**
 * A candidate declaration offered to resolve an ambiguity.
 *
 * DOT allows the same node (or named subgraph) to be declared several times.
 * When a model object cannot be mapped to one declaration unambiguously, the
 * plan reports every candidate so the caller can pick the declaration to edit.
 *
 * @group Patch Plan
 */
export interface AmbiguousCandidate {
  /** Stable path of the candidate declaration. */
  declarationPath: string;
  /** Structured form of {@link declarationPath}. */
  declarationPathSegments: ASTPathSegment[];
  /** Original source range of the candidate declaration. */
  range: SourceRange;
  /** Original source text covered by {@link range}, for display purposes. */
  preview: string;
}

/**
 * A single hop of a declaration AST path.
 *
 * @group Patch Plan
 */
export type ASTPathSegment =
  | { kind: 'dot' }
  | { kind: 'graph' }
  | { kind: 'child'; index: number }
  | { kind: 'edge-target'; index: number };

/**
 * An unresolved ambiguity blocking part of the plan.
 *
 * @group Patch Plan
 */
export interface PatchAmbiguity {
  /** Stable path of the model object that could not be mapped uniquely. */
  targetPath: string;
  /** Structured form of {@link targetPath}. */
  targetPathSegments: ModelPathSegment[];
  /** Attribute key when the ambiguity is about an attribute; otherwise `undefined`. */
  key?: string;
  /** What the caller intends to do with the target. */
  intent: 'edit' | 'delete' | 'insert';
  /** Declarations the caller must choose between. */
  candidates: AmbiguousCandidate[];
}

/**
 * Result of planning model changes against an original DOT source.
 *
 * @group Patch Plan
 */
export interface PatchPlan {
  /**
   * Replacement entries sorted back-to-front by range.
   *
   * Ranges never overlap and never cross, so they can be applied directly in
   * descending offset order.
   */
  patches: PatchEntry[];
  /**
   * Unresolved ambiguities. When non-empty, {@link applyPatchPlan} refuses to
   * touch the source; resolve them via {@link PatchPlanOptions.declarations}
   * and re-plan.
   */
  ambiguities: PatchAmbiguity[];
  /** Hash over the complete original DOT source (`sha256:<hex>`). */
  sourceHash: string;
  /** Whether {@link patches} can be applied safely (no ambiguities). */
  get ready(): boolean;
}

/**
 * Selects one declaration for an ambiguous target.
 *
 * {@link declarationPath} is the value of
 * {@link AmbiguousCandidate.declarationPath}.
 *
 * @group Patch Plan
 */
export interface DeclarationSelection {
  /** Stable path of the model object to disambiguate. */
  targetPath: string;
  /** Attribute key when disambiguating an attribute edit/delete/insert. */
  key?: string;
  /** Intent the selection applies to. */
  intent?: 'edit' | 'delete' | 'insert';
  /** Chosen candidate declaration path. */
  declarationPath: string;
}

/**
 * Options for computing a {@link PatchPlan}.
 *
 * @group Patch Plan
 */
export interface PatchPlanOptions {
  /**
   * Explicit declaration choices used to resolve reported
   * {@link PatchPlan.ambiguities ambiguities}.
   */
  declarations?: readonly DeclarationSelection[];
}

/**
 * Thrown when a patch plan is applied to source text that no longer matches
 * the precondition hashes computed at planning time.
 *
 * @group Patch Plan
 */
export class PatchPreconditionError extends Error {
  constructor(
    /** Stable path of the entry whose precondition failed. */
    public readonly targetPath: string,
    /** Expected hash (`sha256:<hex>`). */
    public readonly expected: string,
    /** Hash actually observed at the target range. */
    public readonly actual: string,
  ) {
    super(
      `Refusing to apply patch for "${targetPath}": precondition hash mismatch (expected ${expected}, got ${actual}).`,
    );
    this.name = 'PatchPreconditionError';
  }
}

/**
 * Convert an AST {@link FileRange} to a {@link SourceRange}.
 *
 * @internal
 */
export function toSourceRange(location: FileRange): SourceRange {
  return { start: location.start.offset, end: location.end.offset };
}
