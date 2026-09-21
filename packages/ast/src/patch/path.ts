import type {
  EdgeModel,
  GraphBaseModel,
  NodeModel,
  SubgraphModel,
} from '@ts-graphviz/common';
import { edgeBinding, nodeBinding, subgraphBinding } from './inspect.js';
import type { PatchBindings, PatchTargetPath } from './types.js';

/**
 * Build the stable path of a container model (graph or subgraph declaration).
 *
 * @group Patch
 */
export function containerPath(
  bindings: PatchBindings,
  container: GraphBaseModel,
  declarationIndex = 0,
): PatchTargetPath {
  if (container.$$type === 'Graph') {
    void bindings;
    return { kind: 'graph' };
  }
  const subgraph = container as unknown as SubgraphModel;
  return {
    kind: 'subgraph',
    id: subgraph.id,
    declaration: declarationIndex,
  };
}

/**
 * Find the index of a subgraph declaration AST within its owner's children.
 */
export function declarationIndexOf(
  bindings: PatchBindings,
  model: NodeModel | EdgeModel | SubgraphModel,
  ast: object,
): number {
  if (model.$$type === 'Node') {
    return (
      nodeBinding(bindings, model as NodeModel)?.declarations.indexOf(
        ast as never,
      ) ?? 0
    );
  }
  if (model.$$type === 'Subgraph') {
    return (
      subgraphBinding(bindings, model as SubgraphModel)?.declarations.indexOf(
        ast as never,
      ) ?? 0
    );
  }
  return 0;
}

/**
 * Edge index within its declaring container (0-based, source/model order).
 */
export function edgeIndex(container: GraphBaseModel, edge: EdgeModel): number {
  return container.edges.indexOf(edge);
}

/**
 * Path for a node declaration.
 *
 * @group Patch
 */
export function nodePath(
  bindings: PatchBindings,
  owner: GraphBaseModel,
  node: NodeModel,
  declarationIndex: number,
): PatchTargetPath {
  void owner;
  void bindings;
  return { kind: 'node', id: node.id, declaration: declarationIndex };
}

/**
 * Path for an edge statement.
 *
 * @group Patch
 */
export function edgePath(
  container: GraphBaseModel,
  edge: EdgeModel,
): PatchTargetPath {
  return {
    kind: 'edge',
    index: edgeIndex(container, edge),
    targets: edge.targets,
  };
}

/**
 * Resolve a path returned by an ambiguity resolver back to a declaration
 * index for a given node/subgraph/attribute owner.
 *
 * @group Patch
 */
export function declarationFromResolvedPath(
  resolved: PatchTargetPath,
): number | undefined {
  if ('declaration' in resolved) {
    return resolved.declaration;
  }
  return undefined;
}

/**
 * Human-readable rendering of a path (stable across sessions).
 *
 * @group Patch
 */
export function formatPath(path: PatchTargetPath): string {
  switch (path.kind) {
    case 'graph':
      return 'graph';
    case 'node':
      return `nodes[${JSON.stringify(path.id)}]#${path.declaration}`;
    case 'edge':
      return `edges[${path.index}]`;
    case 'subgraph':
      return `subgraphs[${path.id === undefined ? '<anonymous>' : JSON.stringify(path.id)}]#${path.declaration}`;
    case 'attribute':
      return `${formatPath(path.owner)}.attributes[${JSON.stringify(path.key)}]#${path.declaration}`;
    case 'default-attributes':
      return `${formatPath(path.owner)}.attributes.${path.list}#${path.declaration}`;
  }
}

/**
 * The declaration index carried by a path.
 */
export function pathDeclaration(path: PatchTargetPath): number {
  return 'declaration' in path ? path.declaration : 0;
}

/**
 * AST node of an edge's single declaration.
 */
export function edgeASTOf(
  bindings: PatchBindings,
  edge: EdgeModel,
): import('../types.js').EdgeASTNode | undefined {
  return edgeBinding(bindings, edge);
}
