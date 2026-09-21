import type {
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
import { makeOperation } from './edits.js';
import { edgeBinding } from './inspect.js';
import { findBlockRange, offsetsOf } from './ranges.js';
import { lineIndent } from './scan.js';
import {
  serializeEdgeStatement,
  serializeNodeStatement,
  serializeSubgraphStatement,
} from './serialize.js';
import { type BlockInfo, inferChildIndent } from './statements.js';
import type { PatchBindings, PatchOperation } from './types.js';

type OwnedOperation = { operation: PatchOperation; ast: object };
type ASTNodeLike = {
  type: string;
  location?: { start: { offset: number }; end: { offset: number } };
};

/**
 * Group operations into equivalence classes by range overlap; within every
 * class that contains more than one operation (or a single operation marked
 * as a structural move conflicting with another), escalate to a rewrite of
 * the nearest common serializable ancestor.
 *
 * @group Patch
 */
export function mergeOverlappingOperations(
  source: string,
  bindings: PatchBindings,
  entries: OwnedOperation[],
): PatchOperation[] {
  const merged: PatchOperation[] = [];
  const used = new Set<number>();

  const overlaps = (a: PatchOperation, b: PatchOperation): boolean => {
    const aInsert = a.range.start === a.range.end;
    const bInsert = b.range.start === b.range.end;
    if (aInsert && bInsert) {
      // Same-position insertions are merged by the session; distinct anchors
      // never overlap.
      return false;
    }
    if (aInsert) {
      // An insertion joins an existing range only when its anchor is strictly
      // inside that range (inserting into a block that is itself rewritten).
      return a.range.start > b.range.start && a.range.start < b.range.end;
    }
    if (bInsert) {
      return b.range.start > a.range.start && b.range.start < a.range.end;
    }
    return a.range.start < b.range.end && b.range.start < a.range.end;
  };

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) {
      continue;
    }
    const cluster: OwnedOperation[] = [entries[i]];
    used.add(i);
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < entries.length; j++) {
        if (used.has(j)) {
          continue;
        }
        if (
          cluster.some((member) =>
            overlaps(member.operation, entries[j].operation),
          )
        ) {
          cluster.push(entries[j]);
          used.add(j);
          grew = true;
        }
      }
    }
    if (cluster.length === 1) {
      merged.push(cluster[0].operation);
      continue;
    }
    merged.push(escalateToAncestor(source, bindings, cluster));
  }
  return merged;
}

/**
 * Find the nearest common ancestor AST node of the owning nodes, restricted to
 * serializable ancestors (Node/Edge/Subgraph/Graph).
 */
function nearestCommonAncestor(
  bindings: PatchBindings,
  asts: object[],
): NodeASTNode | EdgeASTNode | SubgraphASTNode | GraphASTNode {
  const chains = asts.map((ast) => ancestorChain(bindings, ast as ASTNodeLike));
  let lca: ASTNodeLike | undefined;
  const first = chains[0];
  for (const node of first) {
    if (chains.every((chain) => chain.includes(node))) {
      lca = node;
      break;
    }
  }
  if (
    !lca ||
    (lca.type !== 'Node' &&
      lca.type !== 'Edge' &&
      lca.type !== 'Subgraph' &&
      lca.type !== 'Graph')
  ) {
    // Fall back to the root graph.
    return bindings.graphAST;
  }
  return lca as NodeASTNode | EdgeASTNode | SubgraphASTNode | GraphASTNode;
}

/**
 * Ancestor chain starting from the node itself up to Dot, ordered nearest
 * first, filtered to serializable node types when appropriate.
 */
function ancestorChain(
  bindings: PatchBindings,
  ast: ASTNodeLike,
): ASTNodeLike[] {
  const chain: ASTNodeLike[] = [];
  let current: ASTNodeLike | undefined = ast;
  while (current) {
    chain.push(current);
    current = bindings.astParents.get(current as never) as
      | ASTNodeLike
      | undefined;
  }
  // Add the root graph explicitly.
  if (!chain.includes(bindings.graphAST as unknown as ASTNodeLike)) {
    chain.push(bindings.graphAST as unknown as ASTNodeLike);
  }
  return chain;
}

function escalateToAncestor(
  source: string,
  bindings: PatchBindings,
  cluster: OwnedOperation[],
): PatchOperation {
  const ancestor = nearestCommonAncestor(
    bindings,
    cluster.map((entry) => entry.ast),
  );
  const location = offsetsOf(ancestor);
  const replacement = renderAncestor(bindings, ancestor, source);
  const primaryTarget = cluster[0]?.operation.target;
  if (!primaryTarget) {
    throw new Error('Ancestor rewrite cluster is empty.');
  }
  return makeOperation(
    source,
    { start: location.start, end: location.end },
    replacement,
    primaryTarget,
    {
      code: 'ancestor-rewrite',
      message: `Overlapping changes cannot be applied independently; rewriting the nearest common ${ancestor.type} ancestor.`,
    },
  );
}

/**
 * Render the current model view of an ancestor AST statement/subtree.
 *
 * Node/Edge statements are rebuilt from their live model. Subgraph/Graph
 * blocks are rebuilt statement-by-statement from the live container model.
 */
function renderAncestor(
  bindings: PatchBindings,
  ancestor: NodeASTNode | EdgeASTNode | SubgraphASTNode | GraphASTNode,
  source: string,
): string {
  if (ancestor.type === 'Node') {
    const node = findNodeModel(bindings, ancestor);
    if (!node) {
      throw new Error(
        'Cannot rewrite a node declaration whose model was removed.',
      );
    }
    return serializeNodeStatement(node, source, {
      indent: lineIndent(source, offsetsOf(ancestor).start),
    });
  }
  if (ancestor.type === 'Edge') {
    const edge = findEdgeModel(bindings, ancestor);
    if (!edge) {
      throw new Error(
        'Cannot rewrite an edge statement whose model was removed.',
      );
    }
    return serializeEdgeStatement(edge, source, {
      indent: lineIndent(source, offsetsOf(ancestor).start),
    });
  }
  const container = findContainerModel(bindings, ancestor);
  if (!container) {
    throw new Error(
      'Cannot rewrite a block whose container model was removed.',
    );
  }
  return renderBlock(bindings, ancestor, container, source);
}

function renderBlock(
  bindings: PatchBindings,
  ast: SubgraphASTNode | GraphASTNode,
  container: GraphBaseModel,
  source: string,
): string {
  const range = findBlockRange(source, ast);
  const block: BlockInfo = { ast, ...range };
  const childIndent = inferChildIndent(source, block);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines: string[] = [];

  if (ast.type === 'Graph') {
    const head = source
      .slice(ast.location?.start.offset, range.open + 1)
      .replace(/\s+$/, ' ');
    lines.push(head.endsWith('{') ? head : `${head.trim()} {`);
  } else {
    const head = source
      .slice(ast.location?.start.offset, range.open + 1)
      .replace(/\s+$/, ' ');
    lines.push(head.endsWith('{') ? head : head.trim());
    if (!lines[0].endsWith('{')) {
      lines[0] = `${lines[0].trim()} {`;
    }
  }

  for (const [key, value] of container.values) {
    lines.push(`${childIndent}${key} = ${quote(String(value))};`);
  }
  for (const kind of ['graph', 'node', 'edge'] as const) {
    const list = container.attributes[kind];
    if (list.size === 0) {
      continue;
    }
    lines.push(`${childIndent}${kind} [`);
    for (const [key, value] of list.values) {
      lines.push(`${childIndent}  ${key} = ${quote(String(value))};`);
    }
    lines.push(`${childIndent}];`);
  }
  for (const node of container.nodes) {
    lines.push(serializeNodeStatement(node, source, { indent: childIndent }));
  }
  for (const subgraph of container.subgraphs) {
    const subAST = bindings.containerAST.get(subgraph as object) as
      | SubgraphASTNode
      | undefined;
    if (subAST) {
      lines.push(renderBlock(bindings, subAST, subgraph, source));
    } else {
      lines.push(
        serializeSubgraphStatement(subgraph, source, { indent: childIndent }),
      );
    }
  }
  for (const edge of container.edges) {
    lines.push(serializeEdgeStatement(edge, source, { indent: childIndent }));
  }

  const closeIndent = lineIndent(source, range.close);
  lines.push(`${closeIndent}}`);
  return lines.join(eol);
}

function quote(value: string): string {
  if (/^<.+>$/ms.test(value.trim())) {
    return value.trim();
  }
  return `"${value.replace(/(?<!\\)"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function findNodeModel(
  bindings: PatchBindings,
  ast: NodeASTNode,
): NodeModel | undefined {
  let found: NodeModel | undefined;
  const visit = (container: GraphBaseModel): void => {
    const node = container.getNode(ast.id.value);
    if (node) {
      found = node;
      return;
    }
    for (const subgraph of container.subgraphs) {
      visit(subgraph);
    }
  };
  visit(bindings.model);
  return found;
}

function findEdgeModel(
  bindings: PatchBindings,
  ast: EdgeASTNode,
): EdgeModel | undefined {
  let found: EdgeModel | undefined;
  const visit = (container: GraphBaseModel): void => {
    for (const edge of container.edges) {
      if (edgeBinding(bindings, edge) === ast) {
        found = edge;
        return;
      }
    }
    for (const subgraph of container.subgraphs) {
      visit(subgraph);
    }
  };
  visit(bindings.model);
  return found;
}

function findContainerModel(
  bindings: PatchBindings,
  ast: SubgraphASTNode | GraphASTNode,
): GraphBaseModel | undefined {
  if (ast.type === 'Graph') {
    return bindings.model;
  }
  let found: SubgraphModel | undefined;
  const visit = (container: GraphBaseModel): void => {
    for (const subgraph of container.subgraphs) {
      if (bindings.containerAST.get(subgraph as object) === ast) {
        found = subgraph;
        return;
      }
      visit(subgraph);
    }
  };
  visit(bindings.model);
  return found;
}
