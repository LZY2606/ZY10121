import type {
  AttributeKey,
  EdgeTargetTuple,
  ModelsContext,
  RootGraphModel,
} from '@ts-graphviz/common';
import type {
  AttributeASTNode,
  ClusterStatementASTNode,
  CommentASTNode,
  DotASTNode,
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  SubgraphASTNode,
} from '../types.js';

/**
 * The kind of an {@link AttributeOrigin}: the attribute was declared on a
 * node/edge declaration, on a default `graph`/`node`/`edge` attribute list, or
 * as a bare `key = value;` statement on a graph/subgraph body.
 *
 * @group Patch
 */
export type AttributeOriginKind = 'declaration' | 'list' | 'body';

/**
 * Describes where a single model attribute value originated in the parsed
 * source.
 *
 * A single attribute key may have several origins (DOT allows the same node id
 * to be declared multiple times and several `node [...]` lists). In that case
 * the value of the last declaration wins, but every origin is recorded.
 *
 * @group Patch
 */
export interface AttributeOrigin {
  /**
   * Where the attribute was declared.
   */
  kind: AttributeOriginKind;
  /**
   * The AST attribute statement that holds this declaration.
   */
  attributeAST: AttributeASTNode;
  /**
   * For {@link AttributeOriginKind.declaration}, the node/edge statement that
   * owns the attribute. Otherwise `undefined`.
   */
  statementAST?: NodeASTNode | EdgeASTNode;
  /**
   * For {@link AttributeOriginKind.list}, the default attribute list that owns
   * the attribute. Otherwise `undefined`.
   */
  listAST?: Extract<ClusterStatementASTNode, { type: 'AttributeList' }>;
}

/**
 * Binding information for a model node.
 *
 * DOT allows the same node id to appear in multiple statements; every
 * statement is recorded in {@link NodeBinding.declarations}.
 *
 * @group Patch
 */
export interface NodeBinding {
  /**
   * Every `id [...]` statement referring to this node, in source order.
   */
  declarations: NodeASTNode[];
}

/**
 * Binding information for a model edge. Each edge model corresponds to exactly
 * one edge statement (including edge chains, which are parsed into a single
 * {@link EdgeASTNode}).
 *
 * @group Patch
 */
export interface EdgeBinding {
  edgeAST: EdgeASTNode;
}

/**
 * Binding information for a model subgraph.
 *
 * As with nodes, the same subgraph id may appear in multiple statements; every
 * statement is recorded.
 *
 * @group Patch
 */
export interface SubgraphBinding {
  declarations: SubgraphASTNode[];
}

/**
 * All information collected while binding a parsed DOT document to the model
 * built from it.
 *
 * @group Patch
 */
export interface PatchBindings {
  /**
   * The parsed Dot AST node.
   */
  dotAST: DotASTNode;
  /**
   * The Graph AST node of the document.
   */
  graphAST: GraphASTNode;
  /**
   * The original DOT source.
   */
  source: string;
  /**
   * The root model built from the document.
   */
  model: RootGraphModel;
  /**
   * Per-model-object binding registry.
   */
  registry: WeakMap<object, unknown>;
  /**
   * Attribute origins keyed by the model object that owns the attributes
   * (node/edge models, container models and default attribute list models).
   */
  attributes: WeakMap<object, Map<string, AttributeOrigin[]>>;
  /**
   * The Comment AST node attached to a model as its `comment`, when any.
   */
  comments: WeakMap<object, CommentASTNode>;
  /**
   * The container model directly owning a node/edge/subgraph model.
   */
  owners: WeakMap<object, object>;
  /**
   * The container model owning a default attribute list model.
   */
  listOwners: WeakMap<object, object>;
  /**
   * Every AttributeList AST node contributing to a default attribute list
   * model, in source order.
   */
  listDeclarations: WeakMap<
    object,
    Array<Extract<ClusterStatementASTNode, { type: 'AttributeList' }>>
  >;
  /**
   * The first AST node a container model was built from.
   */
  containerAST: WeakMap<object, GraphASTNode | SubgraphASTNode>;
  /**
   * Parent AST node of every AST node.
   */
  astParents: WeakMap<ASTNode, ASTNode>;
  /**
   * The container model an edge/subgraph AST statement was declared in.
   */
  declarationContainer: WeakMap<EdgeASTNode | SubgraphASTNode, object>;
}

type ASTNode = import('../types.js').ASTNode;

/**
 * A stable path describing the model object a patch targets.
 *
 * Paths never rely on object identity: they identify the target through its
 * structural location (`nodes`, `edges`, `subgraphs`, `attributes`, ...) and
 * value (node id, edge target tuple, subgraph id/index).
 *
 * @group Patch
 */
export type PatchTargetPath =
  | { kind: 'graph' }
  | { kind: 'node'; id: string; declaration: number }
  | { kind: 'edge'; index: number; targets: EdgeTargetTuple }
  | { kind: 'subgraph'; id?: string; declaration: number }
  | {
      kind: 'attribute';
      owner: PatchTargetPath;
      key: string;
      declaration: number;
    }
  | {
      kind: 'default-attributes';
      owner: PatchTargetPath;
      list: 'graph' | 'node' | 'edge';
      declaration: number;
    };

/**
 * The reason a patch edits the range it does.
 *
 * @group Patch
 */
export interface PatchReason {
  /**
   * Machine readable code.
   *
   * - `attribute-value-changed`: the value literal of an existing attribute is
   *   replaced in place, preserving its quote style.
   * - `attribute-added`: an attribute is inserted into an existing attribute
   *   list or together with a newly created `[...]` list.
   * - `attribute-removed`: an attribute statement is removed (its surrounding
   *   `[` `]` is removed too when the list becomes empty).
   * - `statement-added`: a new node/edge/subgraph statement is inserted.
   * - `statement-removed`: an existing node/edge/subgraph statement is
   *   removed.
   * - `statement-moved`: a subgraph statement is moved between containers.
   * - `ancestor-rewrite`: a safe local edit is not possible (overlapping
   *   changes), so the nearest common serializable ancestor is rewritten.
   */
  code:
    | 'attribute-value-changed'
    | 'attribute-added'
    | 'attribute-removed'
    | 'statement-added'
    | 'statement-removed'
    | 'statement-moved'
    | 'ancestor-rewrite';
  /**
   * Human readable explanation.
   */
  message: string;
}

/**
 * A single, non-overlapping text replacement.
 *
 * Ranges are half-open offsets (`[start, end)`) into the original DOT source
 * (UTF-16 code unit offsets, matching parser locations).
 *
 * @group Patch
 */
export interface PatchOperation {
  /**
   * Half-open source range to replace.
   */
  range: { start: number; end: number };
  /**
   * The replacement text. An empty string deletes the range.
   */
  replacement: string;
  /**
   * Stable path of the model object this operation primarily targets.
   */
  target: PatchTargetPath;
  /**
   * Why this range was chosen.
   */
  reason: PatchReason;
  /**
   * FNV-1a 64 hex digest of the source text covered by {@link PatchOperation.range}
   * at plan creation time. The operation is rejected if this no longer matches
   * when the patch is applied.
   */
  preconditionHash: string;
}

/**
 * One declaration that could host an ambiguous edit.
 *
 * @group Patch
 */
export interface PatchCandidate {
  /**
   * Path that selects this exact declaration.
   */
  target: PatchTargetPath;
  /**
   * Original source range of the declaration.
   */
  range: { start: number; end: number };
  /**
   * A short preview (the original declaration text, trimmed).
   */
  preview: string;
}

/**
 * Describes an edit that cannot be mapped to a single declaration because the
 * target model object is backed by several source statements.
 *
 * @group Patch
 */
export interface PatchAmbiguity {
  /**
   * The ambiguous target (without a `declaration` index).
   */
  target: PatchTargetPath;
  /**
   * Every declaration that could host the edit.
   */
  candidates: PatchCandidate[];
  /**
   * The attribute key when the ambiguity is about an attribute.
   */
  attributeKey?: AttributeKey;
  /**
   * Human readable explanation.
   */
  message: string;
}

/**
 * The result of planning model changes against a parsed DOT document.
 *
 * @group Patch
 */
export interface PatchPlan {
  /**
   * FNV-1a 64 hex digest of the complete source at plan creation time.
   */
  sourceHash: string;
  /**
   * `ok` plans contain non-overlapping operations ready to apply.
   */
  status: 'ok' | 'ambiguous';
  /**
   * The operations to apply, ordered back-to-front by range start so that
   * applying them in order never invalidates an offset. Insertions at the
   * same position are merged into a single operation.
   */
  operations: PatchOperation[];
  /**
   * Ambiguous edits, if any. No operations are produced for them until the
   * caller selects a declaration.
   */
  ambiguities: PatchAmbiguity[];
}

/**
 * Options for {@link openPatchSession}.
 *
 * @group Patch
 */
export interface OpenPatchSessionOptions {
  /**
   * Parse options forwarded to {@link parse}.
   */
  parseOptions?: import('../dot-shim/parser/parse.js').ParseOptions<'Dot'>;
  /**
   * Models context used to build the bound model. Defaults to the registered
   * global context.
   */
  models?: ModelsContext;
  /**
   * Resolve an ambiguous edit by picking a declaration index.
   *
   * Receives the ambiguity and the index of the change within the planning
   * run. Returning the {@link PatchCandidate.target} path (or one of the
   * candidate paths) selects that declaration.
   */
  resolveAmbiguity?: (ambiguity: PatchAmbiguity) => PatchTargetPath | undefined;
}

/**
 * Thrown when a patch is applied to source text that no longer matches the
 * precondition hashes captured while planning.
 *
 * @group Patch
 */
export class PatchPreconditionError extends Error {
  constructor(
    /**
     * The operation whose precondition failed, if a single operation failed.
     */
    public readonly operation: PatchOperation | null,
    message: string,
  ) {
    super(message);
    this.name = 'PatchPreconditionError';
  }
}

/**
 * A session bound to one DOT document and one mutable model of it.
 *
 * @group Patch
 */
export interface PatchSession {
  /**
   * The parsed AST.
   */
  readonly ast: DotASTNode;
  /**
   * The model built from the source. Mutate this model, then call
   * {@link PatchSession.plan}.
   */
  readonly model: RootGraphModel;
  /**
   * The original source text.
   */
  readonly source: string;
  /**
   * Plan the changes made to the model.
   */
  plan(): PatchPlan;
  /**
   * Plan and apply the changes to {@link PatchSession.source} (or the given
   * `currentSource`, whose hashes must still match).
   */
  apply(currentSource?: string): { plan: PatchPlan; output: string };
}
