import type {
  AttributeListModel,
  EdgeModel,
  GraphBaseModel,
  ModelsContext,
  NodeModel,
  RootGraphModel,
  SubgraphModel,
} from '@ts-graphviz/common';
import { RootModelsContext } from '@ts-graphviz/common';
import { collectAttributes } from '../model-shim/to-model/plugins/utils/collect-attributes.js';
import { CommentHolder } from '../model-shim/to-model/plugins/utils/comment-holder.js';
import { convertToEdgeTargetTuple } from '../model-shim/to-model/plugins/utils/convert-to-edge-target-tuple.js';
import type {
  ASTNode,
  AttributeASTNode,
  CommentASTNode,
  DotASTNode,
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  SubgraphASTNode,
} from '../types.js';
import type {
  AttributeOrigin,
  EdgeBinding,
  NodeBinding,
  PatchBindings,
  SubgraphBinding,
} from './types.js';

type RegistryEntry =
  | ({ kind: 'node' } & NodeBinding)
  | ({ kind: 'edge' } & EdgeBinding)
  | ({ kind: 'subgraph' } & SubgraphBinding)
  | { kind: 'container' };

function originsOf(
  bindings: PatchBindings,
  owner: object,
): Map<string, AttributeOrigin[]> {
  let map = bindings.attributes.get(owner);
  if (!map) {
    map = new Map();
    bindings.attributes.set(owner, map);
  }
  return map;
}

function recordAttribute(
  bindings: PatchBindings,
  owner: object,
  attributeAST: AttributeASTNode,
  origin: Omit<AttributeOrigin, 'attributeAST'>,
): void {
  const key = attributeAST.key.value;
  const map = originsOf(bindings, owner);
  const list = map.get(key) ?? [];
  list.push({ ...origin, attributeAST });
  map.set(key, list);
}

function attrValue(attr: AttributeASTNode): string {
  return attr.value.quoted === 'html'
    ? `<${attr.value.value}>`
    : attr.value.value;
}

/**
 * Build a model from a parsed Dot AST while recording the AST declaration(s)
 * behind every model object.
 *
 * Unlike {@link toModel}, repeated node statements with the same id within one
 * container are merged into a single model (matching DOT semantics where later
 * statements only append attributes), and every declaration is recorded.
 *
 * @group Patch
 */
export function buildBindings(
  dotAST: DotASTNode,
  source: string,
  models: ModelsContext = RootModelsContext,
): { model: RootGraphModel; bindings: PatchBindings } {
  const graphAST = dotAST.children.find(
    (child): child is GraphASTNode => child.type === 'Graph',
  );
  if (!graphAST) {
    throw new Error(
      'Cannot build a patch session from a document without a graph.',
    );
  }

  const bindings: PatchBindings = {
    dotAST,
    source,
    graphAST,
    model: undefined as never,
    registry: new WeakMap(),
    attributes: new WeakMap(),
    comments: new WeakMap(),
    owners: new WeakMap(),
    listOwners: new WeakMap(),
    listDeclarations: new WeakMap(),
    containerAST: new WeakMap(),
    astParents: new WeakMap(),
    declarationContainer: new WeakMap(),
  };

  buildASTParentIndex(bindings, dotAST, undefined);

  const Ctor = graphAST.directed ? models.Digraph : models.Graph;
  const model = new Ctor(graphAST.id?.value, graphAST.strict);
  bindings.model = model;
  bindings.registry.set(model as object, { kind: 'container' });
  bindings.containerAST.set(model as object, graphAST);

  bindContainer(bindings, model, graphAST, models);
  return { model, bindings };
}

function buildASTParentIndex(
  bindings: PatchBindings,
  node: ASTNode,
  parent: ASTNode | undefined,
): void {
  if (parent) {
    bindings.astParents.set(node, parent);
  }
  if (node.type === 'Edge') {
    for (const target of node.targets) {
      buildASTParentIndex(bindings, target as ASTNode, node);
    }
  }
  for (const child of (node as { children?: ASTNode[] }).children ?? []) {
    buildASTParentIndex(bindings, child, node);
  }
}

function bindContainer(
  bindings: PatchBindings,
  model: GraphBaseModel,
  ast: GraphASTNode | SubgraphASTNode,
  models: ModelsContext,
): void {
  const holder = new CommentHolder();
  for (const stmt of ast.children) {
    switch (stmt.type) {
      case 'Comment':
        holder.set(stmt);
        break;
      case 'Attribute': {
        model.set(stmt.key.value as never, attrValue(stmt) as never);
        recordAttribute(bindings, model as object, stmt, { kind: 'body' });
        holder.reset();
        break;
      }
      case 'AttributeList': {
        const listModel =
          model.attributes[
            ({ Graph: 'graph', Node: 'node', Edge: 'edge' } as const)[stmt.kind]
          ];
        bindings.listOwners.set(listModel as object, model);
        const declarations =
          bindings.listDeclarations.get(listModel as object) ?? [];
        declarations.push(stmt);
        bindings.listDeclarations.set(listModel as object, declarations);
        for (const child of stmt.children) {
          if (child.type === 'Attribute') {
            recordAttribute(bindings, listModel as object, child, {
              kind: 'list',
              listAST: stmt,
            });
          }
        }
        for (const [key, value] of Object.entries(
          collectAttributes(
            stmt.children.filter(
              (child): child is AttributeASTNode => child.type === 'Attribute',
            ),
          ),
        )) {
          (
            listModel as unknown as {
              set(key: string, value: unknown): void;
            }
          ).set(key, value);
        }
        const commentAST = holder.comment;
        holder.reset();
        if (commentAST) {
          listModel.comment = commentAST.value;
          bindings.comments.set(listModel as object, commentAST);
        }
        break;
      }
      case 'Node': {
        let node: NodeModel | undefined = model.getNode(stmt.id.value);
        let nodeEntry: (NodeBinding & { kind: 'node' }) | undefined;
        if (!node) {
          const created = new models.Node(
            stmt.id.value,
            collectAttributes(
              stmt.children.filter(
                (child): child is AttributeASTNode =>
                  child.type === 'Attribute',
              ),
            ),
          );
          node = created;
          model.addNode(node);
          bindings.owners.set(node as object, model);
          nodeEntry = { kind: 'node', declarations: [stmt] };
          bindings.registry.set(node as object, nodeEntry);
        } else {
          nodeEntry = bindings.registry.get(node as object) as
            | (NodeBinding & { kind: 'node' })
            | undefined;
          nodeEntry?.declarations.push(stmt);
        }
        const boundNode = node as NodeModel;
        for (const child of stmt.children) {
          if (child.type === 'Attribute') {
            boundNode.attributes.set(
              child.key.value as never,
              attrValue(child) as never,
            );
            recordAttribute(bindings, boundNode as object, child, {
              kind: 'declaration',
              statementAST: stmt,
            });
          }
        }
        const commentAST = holder.comment;
        holder.apply(boundNode, stmt.location);
        if (boundNode.comment !== undefined && commentAST) {
          bindings.comments.set(boundNode as object, commentAST);
        }
        break;
      }
      case 'Edge': {
        const edge = new models.Edge(
          convertToEdgeTargetTuple(stmt),
          collectAttributes(
            stmt.children.filter(
              (child): child is AttributeASTNode => child.type === 'Attribute',
            ),
          ),
        );
        model.addEdge(edge);
        bindings.owners.set(edge as object, model);
        bindings.registry.set(edge as object, { kind: 'edge', edgeAST: stmt });
        bindings.declarationContainer.set(stmt, model as object);
        for (const child of stmt.children) {
          if (child.type === 'Attribute') {
            recordAttribute(bindings, edge as object, child, {
              kind: 'declaration',
              statementAST: stmt,
            });
          }
        }
        const commentAST = holder.comment;
        holder.apply(edge, stmt.location);
        if (edge.comment !== undefined && commentAST) {
          bindings.comments.set(edge as object, commentAST);
        }
        break;
      }
      case 'Subgraph': {
        const id = stmt.id?.value;
        let subgraph = id !== undefined ? model.getSubgraph(id) : undefined;
        if (!subgraph) {
          subgraph = new models.Subgraph(id);
          model.addSubgraph(subgraph);
          bindings.owners.set(subgraph as object, model);
          bindings.registry.set(subgraph as object, {
            kind: 'subgraph',
            declarations: [stmt],
          });
          bindings.containerAST.set(subgraph as object, stmt);
        } else {
          const entry = bindings.registry.get(subgraph as object) as
            | (SubgraphBinding & { kind: 'subgraph' })
            | undefined;
          entry?.declarations.push(stmt);
        }
        bindings.declarationContainer.set(stmt, model);
        bindContainer(bindings, subgraph, stmt, models);
        const commentAST = holder.comment;
        holder.apply(subgraph, stmt.location);
        if (subgraph.comment !== undefined && commentAST) {
          bindings.comments.set(subgraph as object, commentAST);
        }
        break;
      }
    }
  }
}

export type {
  ASTNode,
  CommentASTNode,
  EdgeASTNode,
  NodeASTNode,
  RootGraphModel,
  SubgraphASTNode,
  SubgraphModel,
  NodeModel,
  EdgeModel,
  AttributeListModel,
  RegistryEntry,
};
