import type {
  AttributeListModel,
  EdgeModel,
  GraphBaseModel,
  NodeModel,
  SubgraphModel,
} from '@ts-graphviz/common';
import type { EdgeASTNode, SubgraphASTNode } from '../types.js';
import type { NodeBinding, PatchBindings, SubgraphBinding } from './types.js';

/**
 * Binding entry for a node model, narrowed from the registry.
 */
export function nodeBinding(
  bindings: PatchBindings,
  node: NodeModel,
): (NodeBinding & { kind: 'node' }) | undefined {
  const entry = bindings.registry.get(node as object);
  return entry && (entry as { kind?: string }).kind === 'node'
    ? (entry as NodeBinding & { kind: 'node' })
    : undefined;
}

export function edgeBinding(
  bindings: PatchBindings,
  edge: EdgeModel,
): EdgeASTNode | undefined {
  const entry = bindings.registry.get(edge as object) as
    | { kind: 'edge'; edgeAST: EdgeASTNode }
    | undefined;
  return entry?.edgeAST;
}

export function subgraphBinding(
  bindings: PatchBindings,
  subgraph: SubgraphModel,
): (SubgraphBinding & { kind: 'subgraph' }) | undefined {
  const entry = bindings.registry.get(subgraph as object);
  return entry && (entry as { kind?: string }).kind === 'subgraph'
    ? (entry as SubgraphBinding & { kind: 'subgraph' })
    : undefined;
}

export function listDeclarations(
  bindings: PatchBindings,
  list: AttributeListModel,
): import('../types.js').AttributeListASTNode[] {
  return bindings.listDeclarations.get(list as object) ?? [];
}

export function containerOwner(
  bindings: PatchBindings,
  child: object,
): GraphBaseModel | undefined {
  return bindings.owners.get(child) as GraphBaseModel | undefined;
}

export function listOwner(
  bindings: PatchBindings,
  list: AttributeListModel,
): GraphBaseModel | undefined {
  return bindings.listOwners.get(list as object) as GraphBaseModel | undefined;
}

export function containerAST(
  bindings: PatchBindings,
  container: GraphBaseModel,
): import('../types.js').GraphASTNode | SubgraphASTNode {
  return bindings.containerAST.get(container as object) as
    | import('../types.js').GraphASTNode
    | SubgraphASTNode;
}

/**
 * Find every live node model reachable from the root graph, together with its
 * owning container.
 */
export function collectNodes(
  root: GraphBaseModel,
): Array<{ container: GraphBaseModel; node: NodeModel }> {
  const result: Array<{ container: GraphBaseModel; node: NodeModel }> = [];
  const walk = (container: GraphBaseModel): void => {
    for (const node of container.nodes) {
      result.push({ container, node });
    }
    for (const subgraph of container.subgraphs) {
      walk(subgraph);
    }
  };
  walk(root);
  return result;
}

export function collectEdges(
  root: GraphBaseModel,
): Array<{ container: GraphBaseModel; edge: EdgeModel }> {
  const result: Array<{ container: GraphBaseModel; edge: EdgeModel }> = [];
  const walk = (container: GraphBaseModel): void => {
    for (const edge of container.edges) {
      result.push({ container, edge });
    }
    for (const subgraph of container.subgraphs) {
      walk(subgraph);
    }
  };
  walk(root);
  return result;
}

export function collectSubgraphs(
  root: GraphBaseModel,
): Array<{ container: GraphBaseModel; subgraph: SubgraphModel }> {
  const result: Array<{
    container: GraphBaseModel;
    subgraph: SubgraphModel;
  }> = [];
  const walk = (container: GraphBaseModel): void => {
    for (const subgraph of container.subgraphs) {
      result.push({ container, subgraph });
      walk(subgraph);
    }
  };
  walk(root);
  return result;
}

export type AttributeOwner =
  | { kind: 'node'; node: NodeModel }
  | { kind: 'edge'; edge: EdgeModel }
  | { kind: 'container'; container: GraphBaseModel }
  | { kind: 'list'; list: AttributeListModel };

/**
 * All attribute-bearing model objects reachable from the root.
 */
export function collectAttributeOwners(root: GraphBaseModel): AttributeOwner[] {
  const owners: AttributeOwner[] = [{ kind: 'container', container: root }];
  owners.push(
    { kind: 'list', list: root.attributes.graph },
    { kind: 'list', list: root.attributes.node },
    { kind: 'list', list: root.attributes.edge },
  );
  for (const { node } of collectNodes(root)) {
    owners.push({ kind: 'node', node });
  }
  for (const { edge } of collectEdges(root)) {
    owners.push({ kind: 'edge', edge });
  }
  for (const { subgraph } of collectSubgraphs(root)) {
    owners.push({ kind: 'container', container: subgraph });
    owners.push(
      { kind: 'list', list: subgraph.attributes.graph },
      { kind: 'list', list: subgraph.attributes.node },
      { kind: 'list', list: subgraph.attributes.edge },
    );
  }
  return owners;
}
