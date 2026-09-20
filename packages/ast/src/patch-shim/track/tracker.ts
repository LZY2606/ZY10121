import {
  type EdgeModel,
  type GraphBaseModel,
  type NodeModel,
  type SubgraphModel,
  createModelsContext,
  isNodeModel,
  isNodeRefGroupLike,
  toNodeRef,
  toNodeRefGroup,
} from '@ts-graphviz/common';
import type {
  AttributeASTNode,
  AttributeListASTNode,
  ClusterStatementASTNode,
  CommentASTNode,
  DotASTNode,
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  SubgraphASTNode,
} from '../../types.js';
import { ToModelConverter } from '../../model-shim/to-model/converter.js';
import type { ConvertToModelOptions } from '../../model-shim/to-model/types.js';
import { CommentHolder } from '../../model-shim/to-model/plugins/utils/comment-holder.js';
import type { ASTPathSegment, ModelPathSegment } from '../types.js';

/** Snapshot of an attribute as it appeared in the original source. */
export interface AttrSnapshot {
  key: string;
  /** Normalized value as represented on the model (HTML literals wrapped in `<>`). */
  value: string;
  ast: AttributeASTNode;
}

export interface NodeDeclaration {
  ast: NodeASTNode;
  childIndex: number;
  astPath: ASTPathSegment[];
  attrs: AttrSnapshot[];
  comment?: CommentASTNode;
}

export interface EdgeDeclaration {
  ast: EdgeASTNode;
  childIndex: number;
  astPath: ASTPathSegment[];
  attrs: AttrSnapshot[];
  model: EdgeModel;
  comment?: CommentASTNode;
}

export interface SubgraphDeclaration {
  ast: SubgraphASTNode;
  childIndex: number;
  astPath: ASTPathSegment[];
  info: ClusterInfo;
  model: SubgraphModel;
  comment?: CommentASTNode;
}

export interface BareAttributeDeclaration {
  ast: AttributeASTNode;
  childIndex: number;
  astPath: ASTPathSegment[];
  value: string;
}

export interface AttributeListDeclaration {
  ast: AttributeListASTNode;
  childIndex: number;
  astPath: ASTPathSegment[];
  attrs: AttrSnapshot[];
}

/** All provenance gathered for one graph/subgraph declaration in the AST. */
export interface ClusterInfo {
  ast: GraphASTNode | SubgraphASTNode;
  parent: ClusterInfo | null;
  model: GraphBaseModel;
  /** Null only for the root graph. */
  declaration: SubgraphDeclaration | null;
  depth: number;
  /** Model path segments of {@link model}. */
  modelPath: ModelPathSegment[];
  /** All cluster statement AST children with their child index. */
  statements: { node: ClusterStatementASTNode; index: number }[];
  bareAttributes: Map<string, BareAttributeDeclaration>;
  attributeLists: AttributeListDeclaration[];
  /** Keyed by node id; declaration order preserved. */
  nodeDeclarations: Map<string, NodeDeclaration[]>;
  edges: EdgeDeclaration[];
  subgraphs: SubgraphDeclaration[];
  /** Keyed by subgraph id; anonymous subgraphs get a unique key. */
  subgraphDeclarations: Map<string, SubgraphDeclaration[]>;
  /** Comment originally attached to the cluster model. */
  comment?: CommentASTNode;
}

export interface NodeProvenance {
  cluster: ClusterInfo;
  group: NodeDeclaration[];
  model: NodeModel;
}

export interface SubgraphProvenance {
  cluster: ClusterInfo;
  group: SubgraphDeclaration[];
  model: SubgraphModel;
}

export interface Tracker {
  root: ClusterInfo;
  clusters: ClusterInfo[];
  nodeProvenance: Map<NodeModel, NodeProvenance>;
  edgeProvenance: Map<
    EdgeModel,
    { cluster: ClusterInfo; declaration: EdgeDeclaration }
  >;
  subgraphProvenance: Map<SubgraphModel, SubgraphProvenance>;
  model: GraphBaseModel;
  source: string;
}

function normalizeValue(ast: {
  value: string;
  quoted: boolean | 'html';
}): string {
  return ast.quoted === 'html' ? `<${ast.value}>` : ast.value;
}

function snapshotAttributes(attrs: AttributeASTNode[]): AttrSnapshot[] {
  return attrs.map((ast) => ({
    key: ast.key.value,
    value: normalizeValue(ast.value),
    ast,
  }));
}

const attributeFilter = (
  v: AttributeASTNode | CommentASTNode,
): v is AttributeASTNode => v.type === 'Attribute';

const childPath = (
  parent: ASTPathSegment[],
  index: number,
): ASTPathSegment[] => [...parent, { kind: 'child', index }];

function attachedComment(
  holder: CommentHolder,
  location: { start: { line: number } } | undefined,
): CommentASTNode | undefined {
  const comment = holder.comment;
  if (!comment || !location || !comment.location) {
    return comment ?? undefined;
  }
  if (comment.kind === 'Block') {
    return comment.location.end.line === location.start.line - 1
      ? comment
      : undefined;
  }
  return comment.location.end.line === location.start.line
    ? comment
    : undefined;
}

/**
 * Walk the parsed DOT AST and build a {@link Tracker} tying every model object
 * produced from it back to its originating source declarations.
 *
 * @internal
 */
export function trackDot(
  dot: DotASTNode,
  source: string,
  options?: ConvertToModelOptions,
): Tracker {
  const context = createModelsContext(options?.models ?? {});
  const converter = new ToModelConverter(options);

  const graphAst = dot.children.find(
    (v): v is GraphASTNode => v.type === 'Graph',
  );
  if (!graphAst) {
    throw new Error('Cannot patch a DOT source without a graph.');
  }

  const clusters: ClusterInfo[] = [];
  const nodeProvenance = new Map<NodeModel, NodeProvenance>();
  const edgeProvenance = new Map<
    EdgeModel,
    { cluster: ClusterInfo; declaration: EdgeDeclaration }
  >();
  const subgraphProvenance = new Map<SubgraphModel, SubgraphProvenance>();

  const rootModel = new (graphAst.directed
    ? context.Digraph
    : context.Graph)(graphAst.id?.value, graphAst.strict);

  const root: ClusterInfo = {
    ast: graphAst,
    parent: null,
    model: rootModel,
    declaration: null,
    depth: 0,
    modelPath: [{ kind: 'graph' }],
    statements: [],
    bareAttributes: new Map(),
    attributeLists: [],
    nodeDeclarations: new Map(),
    edges: [],
    subgraphs: [],
    subgraphDeclarations: new Map(),
  };
  clusters.push(root);

  // Dot-level comment attached to the graph (mirrors DotPlugin semantics).
  {
    const holder = new CommentHolder();
    for (const stmt of dot.children) {
      if (stmt.type === 'Comment') {
        holder.set(stmt);
      } else if (stmt === graphAst) {
        root.comment = attachedComment(holder, graphAst.location);
        break;
      }
    }
  }

  applyCluster(root, graphAst.children, [{ kind: 'dot' }, { kind: 'graph' }]);

  return {
    root,
    clusters,
    nodeProvenance,
    edgeProvenance,
    subgraphProvenance,
    model: rootModel,
    source,
  };

  function applyCluster(
    info: ClusterInfo,
    statements: ClusterStatementASTNode[],
    baseAstPath: ASTPathSegment[],
  ): void {
    const holder = new CommentHolder();
    statements.forEach((stmt, index) => {
      info.statements.push({ node: stmt, index });
      const astPath = childPath(baseAstPath, index);
      switch (stmt.type) {
        case 'Subgraph': {
          // Repeated named subgraph declarations merge into one shared model.
          const idKey = stmt.id ? `id:${stmt.id.value}` : `anon:${clusters.length}`;
          const prior = info.subgraphDeclarations
            .get(idKey)
            ?.find((decl) => decl.ast.id?.value === stmt.id?.value);
          const model =
            prior?.model ?? new context.Subgraph(stmt.id?.value);
          if (!prior) {
            model.with(context);
            info.model.addSubgraph(model);
          }
          const child: ClusterInfo = {
            ast: stmt,
            parent: info,
            model,
            declaration: null,
            depth: info.depth + 1,
            modelPath: [
              ...info.modelPath,
              { kind: 'subgraphs', index: info.model.subgraphs.indexOf(model) },
            ],
            statements: [],
            bareAttributes: new Map(),
            attributeLists: [],
            nodeDeclarations: new Map(),
            edges: [],
            subgraphs: [],
            subgraphDeclarations: new Map(),
          };
          clusters.push(child);
          const declaration: SubgraphDeclaration = {
            ast: stmt,
            childIndex: index,
            astPath,
            info: child,
            model,
          };
          child.declaration = declaration;
          info.subgraphs.push(declaration);
          const group = info.subgraphDeclarations.get(idKey) ?? [];
          group.push(declaration);
          info.subgraphDeclarations.set(idKey, group);
          const prov = subgraphProvenance.get(model);
          if (prov) {
            prov.group.push(declaration);
          } else {
            subgraphProvenance.set(model, {
              cluster: info,
              group: [declaration],
              model,
            });
          }
          applyCluster(child, stmt.children, astPath);
          declaration.comment = attachedComment(holder, stmt.location);
          if (child.comment === undefined && declaration.comment) {
            child.comment = declaration.comment;
          }
          holder.reset();
          break;
        }
        case 'Attribute': {
          const value = normalizeValue(stmt.value);
          info.model.set(stmt.key.value, value);
          info.bareAttributes.set(stmt.key.value, {
            ast: stmt,
            childIndex: index,
            astPath,
            value,
          });
          holder.reset();
          break;
        }
        case 'Node': {
          const model = converter.convert(stmt);
          info.model.addNode(model);
          const attrs = snapshotAttributes(
            stmt.children.filter(attributeFilter),
          );
          const declaration: NodeDeclaration = {
            ast: stmt,
            childIndex: index,
            astPath,
            attrs,
            comment: stmt.children.find(
              (v): v is CommentASTNode => v.type === 'Comment',
            ),
          };
          const group = info.nodeDeclarations.get(model.id) ?? [];
          group.push(declaration);
          info.nodeDeclarations.set(model.id, group);
          nodeProvenance.set(model, { cluster: info, group, model });
          holder.apply(model, stmt.location);
          break;
        }
        case 'Edge': {
          const model = converter.convert(stmt);
          info.model.addEdge(model);
          const attrs = snapshotAttributes(
            stmt.children.filter(attributeFilter),
          );
          const declaration: EdgeDeclaration = {
            ast: stmt,
            childIndex: index,
            astPath,
            attrs,
            model,
            comment: stmt.children.find(
              (v): v is CommentASTNode => v.type === 'Comment',
            ),
          };
          info.edges.push(declaration);
          edgeProvenance.set(model, { cluster: info, declaration });
          holder.apply(model, stmt.location);
          break;
        }
        case 'AttributeList': {
          const attrs = snapshotAttributes(
            stmt.children.filter(attributeFilter),
          );
          info.attributeLists.push({
            ast: stmt,
            childIndex: index,
            astPath,
            attrs,
          });
          const values: Record<string, string> = {};
          for (const attr of attrs) {
            values[attr.key] = attr.value;
          }
          switch (stmt.kind) {
            case 'Edge':
              info.model.edge(values);
              break;
            case 'Node':
              info.model.node(values);
              break;
            case 'Graph':
              info.model.graph(values);
              break;
          }
          holder.reset();
          break;
        }
        case 'Comment':
          holder.set(stmt);
      }
    });
  }
}

/**
 * Compare two edge target tuples structurally, mirroring how DOT node ids and
 * ports are represented on the model.
 *
 * @internal
 */
export function sameEdgeTargets(
  a: EdgeModel['targets'],
  b: EdgeModel['targets'],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((target, i) => {
    const other = b[i];
    if (Array.isArray(target) || isNodeRefGroupLike(target)) {
      if (!Array.isArray(other) && !isNodeRefGroupLike(other)) {
        return false;
      }
      const left = (
        Array.isArray(target) ? target : toNodeRefGroup(target)
      ).map(refKey);
      const right = (
        Array.isArray(other) ? other : toNodeRefGroup(other)
      ).map(refKey);
      return (
        left.length === right.length &&
        left.every((key, j) => key === right[j])
      );
    }
    if (Array.isArray(other) || isNodeRefGroupLike(other)) {
      return false;
    }
    return refKey(toNodeRef(target)) === refKey(toNodeRef(other));
  });
}

function refKey(ref: ReturnType<typeof toNodeRef>): string {
  if (isNodeModel(ref)) {
    return `${ref.id}::`;
  }
  return `${ref.id}:${ref.port ?? ''}:${ref.compass ?? ''}`;
}
