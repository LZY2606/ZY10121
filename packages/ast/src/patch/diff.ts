import type {
  AttributeListModel,
  EdgeModel,
  GraphBaseModel,
  NodeModel,
  SubgraphModel,
} from '@ts-graphviz/common';
import type {
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  SubgraphASTNode,
} from '../types.js';
import {
  type AttributeOwner,
  collectAttributeOwners,
  collectEdges,
  collectNodes,
  collectSubgraphs,
  containerOwner,
  edgeBinding,
  listOwner,
  nodeBinding,
  subgraphBinding,
} from './inspect.js';
import { containerPath, edgePath, nodePath } from './path.js';
import type {
  AttributeOrigin,
  PatchAmbiguity,
  PatchBindings,
  PatchCandidate,
  PatchTargetPath,
} from './types.js';

export type AttributeChange = Extract<Change, { kind: AttributeChangeKind }>;

export type AttributeChangeKind =
  | 'attribute-value'
  | 'attribute-add'
  | 'attribute-remove';

/**
 * A change detected by comparing bound declarations with the live model.
 *
 * @group Patch
 */
export type Change =
  | {
      kind: AttributeChangeKind;
      ownerKind: 'node' | 'edge' | 'container' | 'list';
      ownerTarget: object;
      ownerPath: PatchTargetPath;
      attributeKey: string;
      newValue?: unknown;
      origins: AttributeOrigin[];
    }
  | {
      kind: 'statement-add-node';
      container: GraphBaseModel;
      node: NodeModel;
    }
  | {
      kind: 'statement-add-edge';
      container: GraphBaseModel;
      edge: EdgeModel;
    }
  | {
      kind: 'statement-add-subgraph';
      container: GraphBaseModel;
      subgraph: SubgraphModel;
    }
  | {
      kind: 'statement-remove-node';
      container: GraphBaseModel;
      node: NodeModel | undefined;
      declaration: NodeASTNode;
    }
  | {
      kind: 'statement-remove-edge';
      container: GraphBaseModel;
      edge: EdgeModel | undefined;
      declaration: EdgeASTNode;
    }
  | {
      kind: 'statement-remove-subgraph';
      container: GraphBaseModel;
      subgraph: SubgraphModel | undefined;
      declaration: SubgraphASTNode;
    }
  | {
      kind: 'default-list-add';
      container: GraphBaseModel;
      list: AttributeListModel;
      kind2: 'graph' | 'node' | 'edge';
    }
  | {
      kind: 'subgraph-move';
      subgraph: SubgraphModel;
      declaration: SubgraphASTNode;
      oldContainer: GraphBaseModel;
      newContainer: GraphBaseModel;
    };

/**
 * Result of diffing the live model against its bindings.
 *
 * @group Patch
 */
export interface DiffResult {
  changes: Change[];
  ambiguities: PatchAmbiguity[];
}

function ownerBasePath(
  bindings: PatchBindings,
  owner: AttributeOwner,
): PatchTargetPath {
  switch (owner.kind) {
    case 'node': {
      const container = containerOwner(bindings, owner.node) ?? bindings.model;
      return nodePath(bindings, container, owner.node, 0);
    }
    case 'edge': {
      const container = containerOwner(bindings, owner.edge) ?? bindings.model;
      return edgePath(container, owner.edge);
    }
    case 'container':
      return containerPath(bindings, owner.container, 0);
    case 'list': {
      const container = listOwner(bindings, owner.list);
      if (!container) {
        throw new Error('Default attribute list has no owning container.');
      }
      return containerPath(bindings, container, 0);
    }
  }
}

function attributeCandidates(
  source: string,
  ownerPath: PatchTargetPath,
  key: string,
  origins: AttributeOrigin[],
): PatchCandidate[] {
  return origins.map((origin, index) => {
    const loc = origin.attributeAST.location;
    if (!loc) {
      throw new Error('Attribute AST has no source location.');
    }
    return {
      target: { kind: 'attribute', owner: ownerPath, key, declaration: index },
      range: { start: loc.start.offset, end: loc.end.offset },
      preview: source.slice(loc.start.offset, loc.end.offset).trim(),
    };
  });
}

function declaredValue(origin: AttributeOrigin): string {
  const literal = origin.attributeAST.value;
  return literal.quoted === 'html' ? `<${literal.value}>` : literal.value;
}

function diffAttributes(
  bindings: PatchBindings,
  changes: Change[],
  ambiguities: PatchAmbiguity[],
): void {
  for (const owner of collectAttributeOwners(bindings.model)) {
    // New model objects (without any declaration) are emitted wholesale by
    // statement additions; their attributes must not be diffed separately.
    if (
      (owner.kind === 'node' && !nodeBinding(bindings, owner.node)) ||
      (owner.kind === 'edge' && !edgeBinding(bindings, owner.edge)) ||
      (owner.kind === 'container' &&
        owner.container.$$type === 'Subgraph' &&
        !bindings.containerAST.has(owner.container as object))
    ) {
      continue;
    }
    // Default attribute lists that never appeared in the source have no
    // possible patch location; skip them unless they gained attributes
    // (handled by container statement insertion elsewhere is not supported,
    // so emit a synthesized list on the container instead when needed).
    if (owner.kind === 'list') {
      const declared = bindings.listDeclarations.has(owner.list);
      const originMap = bindings.attributes.get(owner.list);
      if (!declared && (!originMap || originMap.size === 0)) {
        // New default list entirely: add as container statement addition.
        if (owner.list.size > 0) {
          newDefaultListChanges(bindings, changes, owner.list);
        }
        continue;
      }
    }
    let ownerTarget: object;
    let ownerKind: 'node' | 'edge' | 'container' | 'list';
    let liveValues: ReadonlyArray<[string, unknown]>;
    switch (owner.kind) {
      case 'node':
        ownerTarget = owner.node;
        ownerKind = 'node';
        liveValues = owner.node.attributes.values;
        break;
      case 'edge':
        ownerTarget = owner.edge;
        ownerKind = 'edge';
        liveValues = owner.edge.attributes.values;
        break;
      case 'container':
        ownerTarget = owner.container;
        ownerKind = 'container';
        liveValues = owner.container.values;
        break;
      case 'list':
        ownerTarget = owner.list;
        ownerKind = 'list';
        liveValues = owner.list.values;
        break;
    }
    const basePath = ownerBasePath(bindings, owner);
    const originMap = bindings.attributes.get(ownerTarget);
    const live = new Map<string, unknown>();
    for (const [key, value] of liveValues) {
      if (key !== 'comment') {
        live.set(key, value);
      }
    }

    for (const [key, value] of live) {
      const origins = originMap?.get(key) ?? [];
      if (origins.length === 0) {
        changes.push({
          kind: 'attribute-add',
          ownerKind,
          ownerTarget,
          ownerPath: basePath,
          attributeKey: key,
          newValue: value,
          origins,
        });
        continue;
      }
      const declared = declaredValue(origins[origins.length - 1]);
      if (String(declared) !== String(value)) {
        if (origins.length > 1) {
          ambiguities.push({
            target: {
              kind: 'attribute',
              owner: basePath,
              key,
              declaration: 0,
            },
            candidates: attributeCandidates(
              bindings.source,
              basePath,
              key,
              origins,
            ),
            attributeKey: key as never,
            message: `Attribute "${key}" is declared ${origins.length} times; choose the declaration that should receive the new value.`,
          });
        }
        changes.push({
          kind: 'attribute-value',
          ownerKind,
          ownerTarget,
          ownerPath: basePath,
          attributeKey: key,
          newValue: value,
          origins,
        });
      }
    }

    for (const [key, origins] of originMap ?? []) {
      if (key === 'comment' || live.has(key)) {
        continue;
      }
      if (origins.length > 1) {
        ambiguities.push({
          target: { kind: 'attribute', owner: basePath, key, declaration: 0 },
          candidates: attributeCandidates(
            bindings.source,
            basePath,
            key,
            origins,
          ),
          attributeKey: key as never,
          message: `Attribute "${key}" is declared ${origins.length} times; choose the declaration to remove.`,
        });
      }
      changes.push({
        kind: 'attribute-remove',
        ownerKind,
        ownerTarget,
        ownerPath: basePath,
        attributeKey: key,
        origins,
      });
    }
  }
}

function diffStatements(bindings: PatchBindings, changes: Change[]): void {
  // Additions: model objects with no binding.
  for (const { container, node } of collectNodes(bindings.model)) {
    if (!nodeBinding(bindings, node)) {
      changes.push({ kind: 'statement-add-node', container, node });
    }
  }
  for (const { container, edge } of collectEdges(bindings.model)) {
    if (!edgeBinding(bindings, edge)) {
      changes.push({ kind: 'statement-add-edge', container, edge });
    }
  }
  for (const { container, subgraph } of collectSubgraphs(bindings.model)) {
    const binding = subgraphBinding(bindings, subgraph);
    if (!binding) {
      changes.push({ kind: 'statement-add-subgraph', container, subgraph });
      continue;
    }
    const declaredContainer = bindings.declarationContainer.get(
      binding.declarations[0],
    );
    if (declaredContainer && declaredContainer !== container) {
      void declaredContainer;
      changes.push({
        kind: 'subgraph-move',
        subgraph,
        declaration: binding.declarations[0],
        oldContainer: declaredContainer as GraphBaseModel,
        newContainer: container,
      });
    }
  }

  // Removals: walk every (container, declaration) pair in the AST and mark
  // those that still exist in the live model *in the same container*. Live
  // membership is keyed by id, so a declaration of a node that still exists
  // elsewhere is still a removal in this container.
  const liveEdgeDecls = new WeakSet<EdgeASTNode>();
  const liveSubgraphDecls = new WeakSet<SubgraphASTNode>();
  const liveNodeIdsByContainer = new WeakMap<object, Set<string>>();
  const markContainer = (container: GraphBaseModel): void => {
    const ids = new Set<string>();
    for (const node of container.nodes) {
      ids.add(node.id);
    }
    liveNodeIdsByContainer.set(container as object, ids);
    for (const edge of container.edges) {
      const decl = edgeBinding(bindings, edge);
      if (decl && isDeclarationInContainer(bindings, decl, container)) {
        liveEdgeDecls.add(decl);
      }
    }
    for (const subgraph of container.subgraphs) {
      subgraphBinding(bindings, subgraph)?.declarations.forEach((decl) => {
        // A declaration is live in the container that currently owns the
        // subgraph model; after a move, its old declaration in another
        // container is treated as removed.
        const liveOwner = liveSubgraphOwner.get(subgraph);
        const declarationContainerModel = findModelForDeclarationContainer(
          bindings,
          decl,
        );
        if (liveOwner === declarationContainerModel) {
          liveSubgraphDecls.add(decl);
        }
      });
      markContainer(subgraph);
    }
  };
  // Current owner of each live subgraph model (reflecting moves).
  const liveSubgraphOwner = new Map<SubgraphModel, GraphBaseModel>();
  const collectOwners = (container: GraphBaseModel): void => {
    for (const subgraph of container.subgraphs) {
      liveSubgraphOwner.set(subgraph, container);
      collectOwners(subgraph);
    }
  };
  collectOwners(bindings.model);
  markContainer(bindings.model);

  const scan = (
    container: GraphBaseModel,
    ast: GraphASTNode | SubgraphASTNode,
  ): void => {
    for (const stmt of ast.children) {
      if (stmt.type === 'Node') {
        const stillMember =
          liveNodeIdsByContainer.get(container as object)?.has(stmt.id.value) ??
          false;
        if (!stillMember) {
          changes.push({
            kind: 'statement-remove-node',
            container,
            node: undefined,
            declaration: stmt,
          });
        }
      } else if (stmt.type === 'Edge') {
        if (!liveEdgeDecls.has(stmt)) {
          changes.push({
            kind: 'statement-remove-edge',
            container,
            edge: undefined,
            declaration: stmt,
          });
        }
      } else if (stmt.type === 'Subgraph') {
        const boundSub = findSubgraphModel(bindings, stmt);
        const declarationOwner = isDeclarationInContainer(
          bindings,
          stmt,
          container,
        )
          ? container
          : undefined;
        const liveOwner = boundSub
          ? findCurrentSubgraphOwner(bindings, boundSub)
          : undefined;
        const movedAway =
          boundSub !== undefined &&
          declarationOwner !== undefined &&
          liveOwner !== undefined &&
          liveOwner !== declarationOwner;
        if (movedAway) {
          // Handled by the subgraph-move change.
        } else if (!liveSubgraphDecls.has(stmt)) {
          changes.push({
            kind: 'statement-remove-subgraph',
            container,
            subgraph: boundSub,
            declaration: stmt,
          });
        } else if (boundSub) {
          scan(boundSub, stmt);
        }
      }
    }
  };
  scan(bindings.model, bindings.graphAST);
}

function findModelForDeclarationContainer(
  bindings: PatchBindings,
  declaration: SubgraphASTNode,
): GraphBaseModel | undefined {
  let parent = bindings.astParents.get(declaration);
  while (parent && parent.type !== 'Graph' && parent.type !== 'Subgraph') {
    parent = bindings.astParents.get(parent);
  }
  if (!parent) {
    return undefined;
  }
  let found: GraphBaseModel | undefined;
  const visit = (container: GraphBaseModel): void => {
    if (bindings.containerAST.get(container as object) === parent) {
      found = container;
      return;
    }
    for (const sub of container.subgraphs) {
      visit(sub);
    }
  };
  visit(bindings.model);
  return found;
}

function isDeclarationInContainer(
  bindings: PatchBindings,
  declaration: NodeASTNode | EdgeASTNode | SubgraphASTNode,
  container: GraphBaseModel,
): boolean {
  let parent = bindings.astParents.get(declaration);
  while (parent && parent.type !== 'Graph' && parent.type !== 'Subgraph') {
    parent = bindings.astParents.get(parent);
  }
  if (!parent) {
    return false;
  }
  return bindings.containerAST.get(container as object) === parent;
}

function findCurrentSubgraphOwner(
  bindings: PatchBindings,
  target: SubgraphModel,
): GraphBaseModel | undefined {
  let found: GraphBaseModel | undefined;
  const visit = (container: GraphBaseModel): boolean => {
    for (const subgraph of container.subgraphs) {
      if (subgraph === target) {
        found = container;
        return true;
      }
      if (visit(subgraph)) {
        return true;
      }
    }
    return false;
  };
  visit(bindings.model);
  return found;
}

function findSubgraphModel(
  bindings: PatchBindings,
  declaration: SubgraphASTNode,
): SubgraphModel | undefined {
  let found: SubgraphModel | undefined;
  const visit = (container: GraphBaseModel): void => {
    for (const subgraph of container.subgraphs) {
      if (
        subgraphBinding(bindings, subgraph)?.declarations.includes(declaration)
      ) {
        found = subgraph;
        return;
      }
      visit(subgraph);
    }
  };
  visit(bindings.model);
  return found;
}

function newDefaultListChanges(
  bindings: PatchBindings,
  changes: Change[],
  list: AttributeListModel,
): void {
  const owner = bindings.listOwners.get(list) as GraphBaseModel | undefined;
  // A list with no declarations is never registered with an owner; infer it
  // from the model identity.
  const container = owner ?? findListContainer(bindings, list);
  if (!container) {
    return;
  }
  const kind =
    container.attributes.graph === list
      ? 'graph'
      : container.attributes.node === list
        ? 'node'
        : 'edge';
  changes.push({
    kind: 'default-list-add',
    container,
    list,
    kind2: kind,
  });
}

function findListContainer(
  bindings: PatchBindings,
  list: AttributeListModel,
): GraphBaseModel | undefined {
  let found: GraphBaseModel | undefined;
  const visit = (container: GraphBaseModel): void => {
    if (
      container.attributes.graph === list ||
      container.attributes.node === list ||
      container.attributes.edge === list
    ) {
      found = container;
      return;
    }
    for (const subgraph of container.subgraphs) {
      visit(subgraph);
    }
  };
  visit(bindings.model);
  return found;
}

/**
 * Compare the live model with the bindings captured at session creation.
 *
 * @group Patch
 */
export function diffModel(bindings: PatchBindings): DiffResult {
  const changes: Change[] = [];
  const ambiguities: PatchAmbiguity[] = [];
  diffAttributes(bindings, changes, ambiguities);
  diffStatements(bindings, changes);
  return { changes, ambiguities };
}
