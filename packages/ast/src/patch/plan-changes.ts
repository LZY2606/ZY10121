import type {
  AttributeListModel,
  EdgeModel,
  GraphBaseModel,
  NodeModel,
  SubgraphModel,
} from '@ts-graphviz/common';
import type {
  AttributeASTNode,
  AttributeListASTNode,
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  SubgraphASTNode,
} from '../types.js';
import type { AttributeChange, Change } from './diff.js';
import {
  type ListInfo,
  listInsertionAnchor,
  listSeparatorStyle,
  makeOperation,
  removeAttributeFromList,
  replaceAttributeValue,
} from './edits.js';
import {
  containerAST,
  containerOwner,
  edgeBinding,
  listDeclarations,
  listOwner,
  nodeBinding,
  subgraphBinding,
} from './inspect.js';
import { containerPath, edgePath, formatPath, nodePath } from './path.js';
import {
  findAttributeListRange,
  findBlockRange,
  findStatementListRange,
  offsetsOf,
} from './ranges.js';
import {
  serializeBracketedList,
  serializeDefaultListStatement,
  serializeEdgeStatement,
  serializeListAttribute,
  serializeNodeStatement,
  serializeSubgraphStatement,
} from './serialize.js';
import {
  type BlockInfo,
  inferChildIndent,
  insertStatements,
  moveSubgraphOperations,
  removeStatement,
} from './statements.js';
import type {
  AttributeOrigin,
  PatchAmbiguity,
  PatchBindings,
  PatchOperation,
  PatchTargetPath,
} from './types.js';

/**
 * One unresolved or resolved edit with the AST context required to choose a
 * range.
 */
export interface PlannedChange {
  change: Change;
  /**
   * When the caller resolved an ambiguity, index of the chosen origin
   * declaration (attribute origins or node/subgraph declarations).
   */
  resolution?: number;
}

export interface ChangePlanResult {
  operations: PatchOperation[];
  /**
   * AST nodes that own the chosen ranges, used for overlap/LCA merging.
   */
  owners: Array<{ operation: PatchOperation; ast: object }>;
}

interface OwnerContext {
  kind: 'node' | 'edge' | 'container' | 'list';
  model: object;
  path: PatchTargetPath;
  container: GraphBaseModel;
}

function resolveOrigin(
  change: Change,
  resolution: number | undefined,
): { origin?: AttributeOrigin; index: number } {
  if (change.kind !== 'attribute-value' && change.kind !== 'attribute-remove') {
    return { index: 0 };
  }
  const origins = change.origins;
  const index = resolution ?? origins.length - 1;
  return { origin: origins[index], index };
}

function nodeOwnerContext(
  bindings: PatchBindings,
  node: NodeModel,
): OwnerContext {
  const container = containerOwner(bindings, node);
  if (!container) {
    throw new Error('Node has no owning container.');
  }
  return {
    kind: 'node',
    model: node,
    container,
    path: nodePath(bindings, container, node, 0),
  };
}

function edgeOwnerContext(
  bindings: PatchBindings,
  edge: EdgeModel,
): OwnerContext {
  const container = containerOwner(bindings, edge);
  if (!container) {
    throw new Error('Edge has no owning container.');
  }
  return {
    kind: 'edge',
    model: edge,
    container,
    path: edgePath(container, edge),
  };
}

/**
 * Plan an attribute value/edit against a node or edge declaration.
 */
function planDeclarationAttribute(
  bindings: PatchBindings,
  change: AttributeChange,
  context: OwnerContext & { kind: 'node' | 'edge' },
  resolutionIndex?: number,
): Array<{ operation: PatchOperation; ast: object }> {
  const source = bindings.source;
  const modelNodeOrEdge = context.model as NodeModel | EdgeModel;
  const statement =
    context.kind === 'node'
      ? nodeBinding(bindings, modelNodeOrEdge as NodeModel)?.declarations[0]
      : edgeBinding(bindings, modelNodeOrEdge as EdgeModel);
  if (!statement) {
    throw new Error('Bound declaration missing for attribute change.');
  }

  if (change.kind === 'attribute-value' || change.kind === 'attribute-remove') {
    const { origin, index } = resolveOrigin(change, resolutionIndex);
    if (!origin || !origin.statementAST) {
      throw new Error('Attribute origin is not a declaration attribute.');
    }
    const target: PatchTargetPath = {
      kind: 'attribute',
      owner: context.path,
      key: change.attributeKey,
      declaration: index,
    };
    if (change.kind === 'attribute-value') {
      return [
        {
          operation: replaceAttributeValue(
            source,
            origin.attributeAST,
            change.newValue,
            target,
          ),
          ast: origin.statementAST,
        },
      ];
    }
    const list = findStatementListRange(source, origin.statementAST);
    if (!list) {
      throw new Error('Attribute list missing for declaration attribute.');
    }
    const remainingAttributes = origin.statementAST.children.filter(
      (child) => child.type === 'Attribute' && child !== origin.attributeAST,
    );
    const hasComments = origin.statementAST.children.some(
      (child) => child.type === 'Comment',
    );
    if (remainingAttributes.length === 0 && !hasComments) {
      // Remove the whole list plus horizontal whitespace preceding it; keep
      // the statement terminator.
      let start = list.open;
      const statementOffsets = offsetsOf(origin.statementAST);
      while (
        start > statementOffsets.start &&
        /[ \t]/.test(source[start - 1])
      ) {
        start--;
      }
      return [
        {
          operation: makeOperation(
            source,
            { start, end: list.close + 1 },
            '',
            target,
            {
              code: 'attribute-removed',
              message:
                'Removing the attribute together with its now-empty list; keeping the statement terminator.',
            },
          ),
          ast: origin.statementAST,
        },
      ];
    }
    return [
      {
        operation: removeAttributeFromList(
          source,
          list,
          origin.attributeAST,
          target,
        ),
        ast: origin.statementAST,
      },
    ];
  }

  // attribute-add onto an existing declaration.
  const existingList = findStatementListRange(source, statement);
  const target: PatchTargetPath = {
    kind: 'attribute',
    owner: context.path,
    key: change.attributeKey,
    declaration: 0,
  };
  const value = change.newValue;
  if (!existingList) {
    // Synthesize a list before the terminator.
    const statementOffsets = offsetsOf(statement);
    const statementStart = statementOffsets.start;
    const statementEnd = statementOffsets.end;
    const terminated = source[statementEnd - 1] === ';';
    const headEnd = terminated ? statementEnd - 1 : statementEnd;
    const head = source.slice(statementStart, headEnd).replace(/\s+$/, '');
    const bracketList = serializeBracketedList([[change.attributeKey, value]]);
    const text = `${head} ${bracketList};`;
    return [
      {
        operation: makeOperation(
          source,
          {
            start: statementStart,
            end: statementEnd,
          },
          text,
          target,
          {
            code: 'attribute-added',
            message: 'Adding a new attribute list to the declaration.',
          },
        ),
        ast: statement,
      },
    ];
  }
  const attrLocs = declarationAttributeLocations(bindings, statement);
  const { offset } = listInsertionAnchor(source, existingList, attrLocs);
  const style = styleOfList(source, existingList);
  const text = serializeListAttribute(change.attributeKey, value, style);
  const separator = listSeparatorStyle(source, existingList);
  const insertionText = formatInsertion(
    source,
    existingList,
    offset,
    text,
    separator,
  );
  return [
    {
      operation: makeOperation(
        source,
        { start: offset, end: offset },
        insertionText,
        target,
        {
          code: 'attribute-added',
          message:
            'Adding the attribute to the existing declaration attribute list.',
        },
      ),
      ast: statement,
    },
  ];
}

function styleOfList(source: string, list: ListInfo): boolean | 'html' {
  void source;
  void list;
  return true;
}

function declarationAttributeLocations(
  bindings: PatchBindings,
  statement: NodeASTNode | EdgeASTNode,
): Array<{ start: number; end: number }> {
  void bindings;
  return statement.children
    .filter((child): child is AttributeASTNode => child.type === 'Attribute')
    .map((child) => offsetsOf(child));
}

/**
 * Format the replacement text for an attribute insertion at `offset` inside a
 * bracket list, matching the list's separator style and keeping newlines out
 * of the inserted bytes unless the list itself is multi-line.
 */
function formatInsertion(
  source: string,
  list: ListInfo,
  offset: number,
  text: string,
  separator: ',' | ';' | 'space',
): string {
  const isEmpty = source.slice(list.open + 1, list.close).trim().length === 0;
  if (isEmpty) {
    return ` ${text} `;
  }
  // When the anchor sits right before `]`, terminate the previous item and
  // insert the new item using the list separator.
  if (offset >= list.close) {
    const trimmed = trimBackToContent(source, list, offset);
    void trimmed;
    if (separator === ',') {
      return `, ${text} `;
    }
    if (separator === ';') {
      return ` ${text}; `;
    }
    return ` ${text} `;
  }
  if (separator === ',') {
    return `${text}, `;
  }
  if (separator === ';') {
    return `${text}; `;
  }
  return `${text} `;
}

function trimBackToContent(
  source: string,
  list: ListInfo,
  offset: number,
): number {
  let cursor = offset;
  while (cursor > list.open + 1 && /[ \t]/.test(source[cursor - 1])) {
    cursor--;
  }
  return cursor;
}

/**
 * Plan an attribute change against a default `graph/node/edge` list.
 */
function planListAttribute(
  bindings: PatchBindings,
  change: AttributeChange,
  list: AttributeListModel,
  resolutionIndex?: number,
): Array<{ operation: PatchOperation; ast: object }> {
  const source = bindings.source;
  const owner = listOwner(bindings, list);
  if (!owner) {
    throw new Error('Default attribute list has no owning container.');
  }
  const ownerPath = containerPath(bindings, owner, 0);
  const declarations = listDeclarations(bindings, list);
  const kind = ({ Graph: 'graph', Node: 'node', Edge: 'edge' } as const)[
    declarations[0]?.kind ?? 'Node'
  ];
  const target: PatchTargetPath = {
    kind: 'default-attributes',
    owner: ownerPath,
    list: kind,
    declaration: 0,
  };

  if (change.kind === 'attribute-value' || change.kind === 'attribute-remove') {
    const { origin, index } = resolveOrigin(change, resolutionIndex);
    if (!origin || !origin.listAST) {
      throw new Error('Attribute origin is not a default list attribute.');
    }
    const listInfo = findAttributeListRange(source, origin.listAST);
    if (change.kind === 'attribute-value') {
      return [
        {
          operation: replaceAttributeValue(
            source,
            origin.attributeAST,
            change.newValue,
            {
              kind: 'attribute',
              owner: target,
              key: change.attributeKey,
              declaration: index,
            },
          ),
          ast: origin.attributeAST.value,
        },
      ];
    }
    return [
      {
        operation: removeAttributeFromList(
          source,
          listInfo,
          origin.attributeAST,
          {
            kind: 'attribute',
            owner: target,
            key: change.attributeKey,
            declaration: index,
          },
        ),
        ast: origin.listAST,
      },
    ];
  }

  // attribute-add
  const lastDeclaration = declarations[declarations.length - 1];
  const value = change.newValue;
  if (!lastDeclaration) {
    throw new Error(
      'Default attribute list with no declaration cannot be added to.',
    );
  }
  const listInfo = findAttributeListRange(source, lastDeclaration);
  const attrLocs = lastDeclaration.children
    .filter((child): child is AttributeASTNode => child.type === 'Attribute')
    .map((child) => offsetsOf(child));
  const { offset } = listInsertionAnchor(source, listInfo, attrLocs);
  const text = serializeListAttribute(change.attributeKey, value, true);
  const separator = listSeparatorStyle(source, listInfo);
  const insertionText = formatInsertion(
    source,
    listInfo,
    offset,
    text,
    separator,
  );
  return [
    {
      operation: makeOperation(
        source,
        { start: offset, end: offset },
        insertionText,
        {
          kind: 'attribute',
          owner: target,
          key: change.attributeKey,
          declaration: 0,
        },
        {
          code: 'attribute-added',
          message:
            'Adding the attribute to the last default attribute list declaration.',
        },
      ),
      ast: lastDeclaration,
    },
  ];
}

/**
 * Plan an attribute change against a container body (bare `key = value;`).
 */
function planContainerBodyAttribute(
  bindings: PatchBindings,
  change: AttributeChange,
  container: GraphBaseModel,
  resolutionIndex?: number,
): Array<{ operation: PatchOperation; ast: object }> {
  const source = bindings.source;
  const target = containerPath(bindings, container, 0);
  if (change.kind === 'attribute-value' || change.kind === 'attribute-remove') {
    const { origin, index } = resolveOrigin(change, resolutionIndex);
    if (!origin) {
      throw new Error('Body attribute origin missing.');
    }
    const attrTarget: PatchTargetPath = {
      kind: 'attribute',
      owner: target,
      key: change.attributeKey,
      declaration: index,
    };
    if (change.kind === 'attribute-value') {
      return [
        {
          operation: replaceAttributeValue(
            source,
            origin.attributeAST,
            change.newValue,
            attrTarget,
          ),
          ast: origin.attributeAST,
        },
      ];
    }
    // Remove the whole statement plus its line.
    const loc = origin.attributeAST.location;
    if (!loc) {
      throw new Error('Body attribute AST has no source location.');
    }
    let start = loc.start.offset;
    while (start > 0 && /[ \t]/.test(source[start - 1])) {
      start--;
    }
    let end = loc.end.offset;
    // Body attributes are `key = value;` statements; include terminator and newline.
    if (source[end] === ';') {
      end++;
    }
    if (source[end] === '\r' && source[end + 1] === '\n') {
      end += 2;
    } else if (source[end] === '\n') {
      end++;
    }
    return [
      {
        operation: makeOperation(source, { start, end }, '', attrTarget, {
          code: 'attribute-removed',
          message:
            'Removing the bare graph attribute statement and its line break.',
        }),
        ast: origin.attributeAST,
      },
    ];
  }

  // Add a new bare attribute statement at the end of the block.
  const block = blockInfoFor(bindings, container);
  const _childIndent = inferChildIndent(source, block);
  const text = `${change.attributeKey} = ${serializeListAttribute(
    change.attributeKey,
    change.newValue,
    true,
  ).replace(/^[^=]*= /, '')};`;
  const insertion = insertStatements(source, block, text, {
    kind: 'attribute',
    owner: target,
    key: change.attributeKey,
    declaration: 0,
  });
  return [{ operation: insertion, ast: block.ast }];
}

function blockInfoFor(
  bindings: PatchBindings,
  container: GraphBaseModel,
): BlockInfo {
  const ast = containerAST(bindings, container);
  const range = findBlockRange(bindings.source, ast);
  return { ast, ...range };
}

function planStatementAdds(
  bindings: PatchBindings,
): Array<{ operation: PatchOperation; ast: object }> {
  const source = bindings.source;
  const result: Array<{ operation: PatchOperation; ast: object }> = [];
  // Group additions per container block so same-anchor insertions are stable
  // and get merged in model order.
  const groups = new Map<
    GraphBaseModel,
    { nodes: NodeModel[]; edges: EdgeModel[]; subgraphs: SubgraphModel[] }
  >();
  const ensure = (container: GraphBaseModel) => {
    let group = groups.get(container);
    if (!group) {
      group = { nodes: [], edges: [], subgraphs: [] };
      groups.set(container, group);
    }
    return group;
  };

  // Walk the live model to preserve model order.
  const walk = (container: GraphBaseModel): void => {
    for (const node of container.nodes) {
      if (!nodeBinding(bindings, node)) {
        ensure(container).nodes.push(node);
      }
    }
    for (const subgraph of container.subgraphs) {
      const binding = subgraphBinding(bindings, subgraph);
      if (!binding) {
        ensure(container).subgraphs.push(subgraph);
      }
      walk(subgraph);
    }
    for (const edge of container.edges) {
      if (!edgeBinding(bindings, edge)) {
        ensure(container).edges.push(edge);
      }
    }
  };
  walk(bindings.model);

  for (const [container, group] of groups) {
    const block = blockInfoFor(bindings, container);
    const childIndent = inferChildIndent(source, block);
    const eol =
      source.includes('\r\n') && !source.includes('\n') ? '\r\n' : '\n';
    void eol;
    const texts: string[] = [];
    for (const node of group.nodes) {
      texts.push(serializeNodeStatement(node, source, { indent: childIndent }));
    }
    for (const subgraph of group.subgraphs) {
      texts.push(
        serializeSubgraphStatement(subgraph, source, { indent: childIndent }),
      );
    }
    for (const edge of group.edges) {
      texts.push(serializeEdgeStatement(edge, source, { indent: childIndent }));
    }
    if (texts.length === 0) {
      continue;
    }
    const joined = texts.join(
      source.includes('\r\n') &&
        !source.slice(block.open, block.close).includes('\n')
        ? '\r\n'
        : '\n',
    );
    const operation = insertStatements(source, block, joined, {
      ...containerPath(bindings, container, 0),
    } as PatchTargetPath);
    result.push({ operation, ast: block.ast });
  }
  return result;
}

function planStatementRemovals(
  bindings: PatchBindings,
  changes: Change[],
): Array<{ operation: PatchOperation; ast: object }> {
  const result: Array<{ operation: PatchOperation; ast: object }> = [];
  for (const change of changes) {
    if (
      change.kind !== 'statement-remove-node' &&
      change.kind !== 'statement-remove-edge' &&
      change.kind !== 'statement-remove-subgraph'
    ) {
      continue;
    }
    const declaration = change.declaration;
    const target =
      change.kind === 'statement-remove-node'
        ? {
            kind: 'node',
            id: declaration.type === 'Node' ? declaration.id.value : '',
            declaration: 0,
          }
        : change.kind === 'statement-remove-edge'
          ? {
              kind: 'edge',
              index: change.container.edges.length,
              targets: [],
            }
          : {
              kind: 'subgraph',
              id:
                declaration.type === 'Subgraph'
                  ? declaration.id?.value
                  : undefined,
              declaration: 0,
            };
    result.push({
      operation: removeStatement(
        bindings.source,
        declaration,
        target as PatchTargetPath,
      ),
      ast: declaration,
    });
  }
  return result;
}

function planSubgraphMoves(
  bindings: PatchBindings,
  changes: Change[],
): Array<{ operation: PatchOperation; ast: object }> {
  const result: Array<{ operation: PatchOperation; ast: object }> = [];
  for (const change of changes) {
    if (change.kind !== 'subgraph-move') {
      continue;
    }
    const source = bindings.source;
    const oldBlock = blockInfoFor(bindings, change.oldContainer);
    const newBlock = blockInfoFor(bindings, change.newContainer);
    const childIndent = inferChildIndent(source, newBlock);
    const movedText = serializeSubgraphStatement(change.subgraph, source, {
      indent: childIndent,
    });
    const target = containerPath(bindings, change.newContainer, 0);
    const { removal, insertion } = moveSubgraphOperations(
      source,
      change.declaration,
      oldBlock,
      newBlock,
      movedText,
      target,
    );
    result.push({ operation: removal, ast: change.declaration });
    result.push({ operation: insertion, ast: newBlock.ast });
  }
  return result;
}

/**
 * Convert all diff changes into raw operations.
 *
 * @group Patch
 */
export function planChanges(
  bindings: PatchBindings,
  changes: Change[],
  resolutions: ReadonlyMap<string, number>,
): ChangePlanResult {
  const results: Array<{ operation: PatchOperation; ast: object }> = [];
  const source = bindings.source;

  for (const change0 of changes) {
    if (change0.kind === 'default-list-add') {
      const block = blockInfoFor(bindings, change0.container);
      const childIndent = inferChildIndent(source, block);
      const values = change0.list.values.filter(
        ([key]) => key !== 'comment',
      ) as Array<[string, unknown]>;
      const text = serializeDefaultListStatement(
        change0.kind2,
        values,
        source,
        { indent: childIndent },
      );
      const operation = insertStatements(source, block, text, {
        ...containerPath(bindings, change0.container, 0),
      } as PatchTargetPath);
      results.push({ operation, ast: block.ast });
      continue;
    }
    if (
      change0.kind === 'statement-add-node' ||
      change0.kind === 'statement-add-edge' ||
      change0.kind === 'statement-add-subgraph' ||
      change0.kind === 'subgraph-move' ||
      change0.kind === 'statement-remove-node' ||
      change0.kind === 'statement-remove-edge' ||
      change0.kind === 'statement-remove-subgraph'
    ) {
      continue;
    }
    const change: AttributeChange = change0;

    // Attribute changes that live inside a moving subgraph are folded into
    // the move's serialized statement; skip them as standalone operations.
    if (isInsideMovingSubgraph(bindings, change, changes)) {
      continue;
    }

    // Attribute changes.
    const ownerTarget = change.ownerTarget as
      | NodeModel
      | EdgeModel
      | GraphBaseModel
      | AttributeListModel;
    const ownerKind = change.ownerKind;
    const resolutionKey = `${formatPath(stripOwnerDeclaration(change.ownerPath))}:${change.attributeKey}`;
    const resolution = resolutions.get(resolutionKey);

    if (ownerKind === 'node') {
      const node = ownerTarget as NodeModel;
      results.push(
        ...planDeclarationAttribute(
          bindings,
          change,
          {
            ...nodeOwnerContext(bindings, node),
            kind: 'node' as const,
          },
          resolution,
        ),
      );
    } else if (ownerKind === 'edge') {
      const edge = ownerTarget as EdgeModel;
      results.push(
        ...planDeclarationAttribute(
          bindings,
          change,
          {
            ...edgeOwnerContext(bindings, edge),
            kind: 'edge' as const,
          },
          resolution,
        ),
      );
    } else if (ownerKind === 'list') {
      results.push(
        ...planListAttribute(
          bindings,
          change,
          ownerTarget as AttributeListModel,
          resolution,
        ),
      );
    } else {
      results.push(
        ...planContainerBodyAttribute(
          bindings,
          change,
          ownerTarget as GraphBaseModel,
          resolution,
        ),
      );
    }
  }

  results.push(...planStatementAdds(bindings));
  results.push(...planStatementRemovals(bindings, changes));
  results.push(...planSubgraphMoves(bindings, changes));

  return {
    operations: results.map((entry) => entry.operation),
    owners: results,
  };
}

function _withResolution(
  entries: Array<{ operation: PatchOperation; ast: object }>,
): Array<{ operation: PatchOperation; ast: object }> {
  return entries;
}

export type {
  AttributeASTNode,
  AttributeListASTNode,
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  PatchAmbiguity,
  SubgraphASTNode,
};

function stripOwnerDeclaration(path: PatchTargetPath): PatchTargetPath {
  if ('declaration' in path) {
    return { ...(path as object), declaration: 0 } as PatchTargetPath;
  }
  return path;
}

function isInsideMovingSubgraph(
  bindings: PatchBindings,
  change: AttributeChange,
  allChanges: Change[],
): boolean {
  const movingDeclarations = new Set<SubgraphASTNode>();
  for (const candidate of allChanges) {
    if (candidate.kind === 'subgraph-move') {
      movingDeclarations.add(candidate.declaration);
    }
  }
  if (movingDeclarations.size === 0) {
    return false;
  }
  const originAST = change.origins[0]?.attributeAST;
  if (!originAST) {
    return false;
  }
  let parent = bindings.astParents.get(originAST);
  while (parent) {
    if (
      parent.type === 'Subgraph' &&
      movingDeclarations.has(parent as SubgraphASTNode)
    ) {
      return true;
    }
    parent = bindings.astParents.get(parent);
  }
  return false;
}
