import type { ClusterStatementASTNode } from '../../types.js';
import type { PatchEntry, PatchReason } from '../types.js';
import { hashRange } from '../hash.js';
import type { ClusterInfo } from '../track/tracker.js';
import {
  detectEOL,
  findClosingBrace,
  lineIndent,
  statementRemovalRange,
} from '../render/source-text.js';
import { serializeClusterStatements } from '../render/body.js';
import { printClusterStatements } from '../render/print.js';
import { renderModelPath } from '../render/paths.js';
import type { Edit } from './changes.js';

interface Span {
  start: number;
  end: number;
}

function nodeSpan(node: {
  location?: { start: { offset: number }; end: { offset: number } };
}): Span | null {
  if (!node.location) return null;
  return {
    start: node.location.start.offset,
    end: node.location.end.offset,
  };
}

function editSpan(edit: Edit): Span | null {
  switch (edit.kind) {
    case 'fine':
      return { start: edit.start, end: edit.end };
    case 'insert':
      return edit.zone.mode === 'before'
        ? { start: edit.zone.anchor, end: edit.zone.anchor }
        : null;
    case 'remove':
      return nodeSpan(edit.stmt);
    case 'rewrite-statement':
      return nodeSpan(edit.stmt);
    case 'rewrite-cluster':
      return nodeSpan(edit.cluster.ast);
  }
}

function owningStatement(edit: Edit): ClusterStatementASTNode | null {
  return edit.kind === 'fine'
    ? edit.statement
    : edit.kind === 'remove' || edit.kind === 'rewrite-statement'
      ? edit.stmt
      : null;
}

function commonCluster(a: ClusterInfo, b: ClusterInfo): ClusterInfo {
  if (a === b) return a;
  const ancestors = new Set<ClusterInfo>();
  let node: ClusterInfo | null = a;
  while (node) {
    ancestors.add(node);
    node = node.parent;
  }
  let other: ClusterInfo | null = b;
  while (other && !ancestors.has(other)) {
    other = other.parent;
  }
  return other ?? a;
}

function clusterRoot(cluster: ClusterInfo): ClusterInfo {
  let node = cluster;
  while (node.parent) node = node.parent;
  return node;
}

function clusterDirected(cluster: ClusterInfo): boolean {
  const root = clusterRoot(cluster);
  return root.ast.type === 'Graph'
    ? (root.ast as { directed: boolean }).directed
    : true;
}

/**
 * Collapse overlapping edits by promoting them to the nearest common
 * serializable ancestor (a single statement, or the enclosing cluster body).
 */
function resolveOverlaps(edits: Edit[]): Edit[] {
  const working = [...edits];
  for (;;) {
    let collided = false;
    outer: for (let i = 0; i < working.length; i++) {
      for (let j = i + 1; j < working.length; j++) {
        const a = working[i];
        const b = working[j];
        const sa = editSpan(a);
        const sb = editSpan(b);
        if (!sa || !sb) continue;
        const samePointInsert =
          sa.start === sa.end && sb.start === sb.end && sa.start === sb.start;
        if (samePointInsert || !(sa.start < sb.end && sb.start < sa.end)) {
          continue;
        }
        const cluster = commonCluster(a.cluster, b.cluster);
        const stmtA = owningStatement(a);
        const stmtB = owningStatement(b);
        working.splice(j, 1);
        working.splice(i, 1);
        if (stmtA && stmtA === stmtB) {
          working.push({
            kind: 'rewrite-statement',
            cluster,
            stmt: stmtA,
            replacement: '',
            targetPath: a.targetPath,
            segments: a.segments,
            reason: {
              kind: 'fallback-ancestor-rewrite',
              ancestor: stmtA.type as 'Node' | 'Edge' | 'Subgraph',
              detail:
                'Overlapping edits could not be expressed as disjoint ranges.',
            },
          });
        } else {
          working.push({
            kind: 'rewrite-cluster',
            cluster,
            targetPath: renderModelPath(cluster.modelPath),
            segments: cluster.modelPath,
            reason: {
              kind: 'merged-ancestor-rewrite',
              ancestor: cluster.parent === null ? 'Graph' : 'Subgraph',
              merged: [a.reason, b.reason],
            },
          });
        }
        collided = true;
        break outer;
      }
    }
    if (!collided) return working;
  }
}

/** Serialize one whole statement freshly from the current model. */
function regenerateStatement(
  source: string,
  cluster: ClusterInfo,
  stmt: ClusterStatementASTNode,
): string {
  const eol = detectEOL(source);
  const statements = serializeClusterStatements(cluster.model);
  const regenerated = statements[cluster.ast.children.indexOf(stmt)];
  const body = printClusterStatements(
    regenerated ? [regenerated] : statements,
    { directed: clusterDirected(cluster), eol, indent: '' },
  );
  return body.replace(new RegExp(`${eol}$`), '');
}

/** Compute the replacement region strictly between a cluster's braces. */
function buildClusterBodyRewrite(
  source: string,
  cluster: ClusterInfo,
): Span & { replacement: string } {
  const loc = cluster.ast.location;
  if (!loc) {
    throw new Error('Cannot rewrite a cluster without source locations.');
  }
  let open = -1;
  for (let i = loc.start.offset; i < loc.end.offset; i++) {
    if (source[i] === '{') {
      open = i;
      break;
    }
  }
  const close = findClosingBrace(source, cluster.ast);
  const eol = detectEOL(source);
  const body = printClusterStatements(
    serializeClusterStatements(cluster.model),
    { directed: clusterDirected(cluster), eol, indent: childIndent(source, open) },
  );
  return { start: open + 1, end: close, replacement: `${eol}${body}` };
}

function childIndent(source: string, open: number): string {
  const nl = source.indexOf('\n', open + 1);
  if (nl === -1) {
    return `${lineIndent(source, open)}  `;
  }
  const start = nl + 1;
  let p = start;
  while (source[p] === ' ' || source[p] === '\t') p++;
  if (p < source.length && source[p] !== '}') {
    return source.slice(start, p);
  }
  return `${source.slice(start, p)}  `;
}

/**
 * Turn collected edits into disjoint, hashed, back-to-front patch entries.
 *
 * @internal
 */
export function finalizeEdits(source: string, input: Edit[]): PatchEntry[] {
  const edits = resolveOverlaps(input);

  const forced = edits.filter(
    (e): e is Extract<Edit, { kind: 'rewrite-cluster' }> =>
      e.kind === 'rewrite-cluster',
  );

  const kept: Edit[] = [];
  outer: for (const edit of edits) {
    if (edit.kind === 'rewrite-cluster') {
      kept.push(edit);
      continue;
    }
    for (const force of forced) {
      const span = nodeSpan(force.cluster.ast);
      const own = editSpan(edit);
      if (span && own && own.start >= span.start && own.end <= span.end) {
        continue outer;
      }
    }
    kept.push(edit);
  }

  // Build entries in ascending model/source order first, storing the model
  // ordering key needed to combine co-located inserts.
  const built: (PatchEntry & { insertOrder?: number })[] = [];
  for (const edit of kept) {
    switch (edit.kind) {
      case 'fine':
        built.push(makeEntry(edit, { start: edit.start, end: edit.end }, edit.replacement, source));
        break;
      case 'insert':
        if (edit.zone.mode === 'before') {
          built.push(
            makeEntry(
              edit,
              { start: edit.zone.anchor, end: edit.zone.anchor },
              edit.text,
              source,
              edit.order,
            ),
          );
        }
        break;
      case 'remove': {
        const span = statementRemovalRange(source, edit.stmt);
        if (span) built.push(makeEntry(edit, span, '', source));
        break;
      }
      case 'rewrite-statement': {
        const span = nodeSpan(edit.stmt);
        if (span) {
          built.push(
            makeEntry(
              edit,
              span,
              regenerateStatement(source, edit.cluster, edit.stmt),
              source,
            ),
          );
        }
        break;
      }
      case 'rewrite-cluster': {
        const builtBody = buildClusterBodyRewrite(source, edit.cluster);
        built.push(
          makeEntry(
            edit,
            { start: builtBody.start, end: builtBody.end },
            builtBody.replacement,
            source,
          ),
        );
        break;
      }
    }
  }

  // Combine inserts at the same zero-width point in model (ascending) order.
  built.sort((a, b) => {
    const ao = a.insertOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.insertOrder ?? Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
  const byPoint = new Map<number, PatchEntry[]>();
  for (const entry of built) {
    if (
      entry.range.start === entry.range.end &&
      entry.insertOrder !== undefined
    ) {
      const list = byPoint.get(entry.range.start) ?? [];
      list.push(entry);
      byPoint.set(entry.range.start, list);
    }
  }
  for (const list of byPoint.values()) {
    if (list.length <= 1) continue;
    const mergedReason: PatchReason = {
      kind: 'merged-ancestor-rewrite',
      ancestor: 'Subgraph',
      merged: list.map((e) => e.reason),
    };
    const combined: PatchEntry = {
      ...list[0],
      replacement: list.map((e) => e.replacement).join(''),
      reason: mergedReason,
    };
    const index = built.indexOf(list[0]);
    built.splice(index, list.length, combined);
  }

  // Final order: back-to-front by range, zero-width inserts at a point before
  // any replacement ending there (they are disjoint, so this is cosmetic).
  built.sort(
    (a, b) =>
      b.range.start - a.range.start || a.range.end - b.range.end,
  );
  return built.map(({ insertOrder: _ignored, ...entry }) => entry);
}

function makeEntry(
  edit: Edit,
  span: Span,
  replacement: string,
  source: string,
  insertOrder?: number,
): PatchEntry & { insertOrder?: number } {
  return {
    range: span,
    replacement,
    targetPath: edit.targetPath,
    targetPathSegments: edit.segments,
    reason: edit.reason,
    preHash: hashRange(source, span.start, span.end),
    insertOrder,
  };
}
